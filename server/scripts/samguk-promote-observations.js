#!/usr/bin/env node

const crypto = require("node:crypto");
const path = require("node:path");
const FALLBACK = require("../data/samguk-fallback.json");
const { createSamgukSheetService } = require("../lib/samguk-sheet");
const { createSamgukSheetWriter } = require("../lib/samguk-sheet-writer");
const {
  ALLOWED_FIELDS,
  DEFAULT_CONSENSUS_WINDOW_MS,
  normalizeObservation,
  readObservationQueue,
  resolveLatestAccepted,
} = require("../lib/samguk-observations");

const DEFAULT_QUEUE_PATH = path.resolve(__dirname, "../data/samguk-observations.ndjson");
const PLAYER_IDS = new Map(FALLBACK.members.map((member, index) => [member.soopId, `P${String(index + 1).padStart(3, "0")}`]));

function usage() {
  return [
    "Usage: node scripts/samguk-promote-observations.js [--write] [--queue PATH] [--window-ms N]",
    "",
    "기본은 dry-run입니다. --write는 교차검증된 최신 완전 스냅샷만 Apps Script로 보냅니다.",
  ].join("\n");
}

function parseArguments(argv) {
  const options = {
    queuePath: DEFAULT_QUEUE_PATH,
    windowMs: Number(process.env.SAMGUK_CONSENSUS_WINDOW_MS) || DEFAULT_CONSENSUS_WINDOW_MS,
    write: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--write") options.write = true;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else if (argument === "--queue") {
      if (!argv[index + 1]) throw new Error("--queue 경로가 필요합니다.");
      options.queuePath = path.resolve(argv[index + 1]);
      index += 1;
    } else if (argument === "--window-ms") {
      if (!argv[index + 1]) throw new Error("--window-ms 값이 필요합니다.");
      options.windowMs = Number(argv[index + 1]);
      index += 1;
    } else throw new Error(`알 수 없는 옵션입니다: ${argument}`);
  }
  return options;
}

function baselineObservations(payload, now = Date.now()) {
  const observations = [];
  for (const member of payload.members) {
    const playerId = PLAYER_IDS.get(member.soopId);
    if (!playerId) continue;
    for (const field of ALLOWED_FIELDS) {
      const value = member[field];
      if (value === null || value === undefined || value === "") continue;
      observations.push({
        playerId,
        field,
        value,
        sourceType: "sheet",
        sourceId: `current-status:${playerId}:${field}`,
        sourceUrl: payload.sheetUrl,
        observedAt: member.observedAt || payload.updatedAt,
        collectedAt: new Date(now).toISOString(),
      });
    }
  }
  return observations;
}

function completeFields(member) {
  return Object.fromEntries(ALLOWED_FIELDS.map(field => [
    field,
    member[field] === undefined || member[field] === "" ? null : member[field],
  ]));
}

function maxTimestamp(values) {
  return values.reduce((latest, value) => (
    Date.parse(value) > Date.parse(latest) ? value : latest
  ));
}

function buildPromotionSnapshots(payload, queued, { windowMs, now = Date.now() }) {
  const baselines = baselineObservations(payload, now);
  const inputs = [...baselines, ...queued].map(observation => normalizeObservation(observation, { now }));
  const latest = resolveLatestAccepted(inputs, { baselines, windowMs });
  const observationsById = new Map(inputs.map(observation => [observation.observationId, observation]));
  const memberByPlayerId = new Map(payload.members.map(member => [PLAYER_IDS.get(member.soopId), member]));
  const acceptedByPlayer = new Map();

  for (const candidate of latest) {
    if (candidate.verification === "sheet-baseline") continue;
    if (!acceptedByPlayer.has(candidate.playerId)) acceptedByPlayer.set(candidate.playerId, []);
    acceptedByPlayer.get(candidate.playerId).push(candidate);
  }

  const snapshots = [];
  for (const [playerId, accepted] of acceptedByPlayer) {
    const member = memberByPlayerId.get(playerId);
    if (!member) continue;
    const fields = completeFields(member);
    accepted.forEach(candidate => { fields[candidate.field] = candidate.value; });
    const supporting = accepted.flatMap(candidate => candidate.observationIds)
      .map(id => observationsById.get(id)).filter(Boolean);
    const evidenceHashes = [...new Set(accepted.flatMap(candidate => candidate.evidenceHashes))].sort();
    const digest = crypto.createHash("sha256").update(JSON.stringify({ playerId, fields, evidenceHashes })).digest("hex");
    const sourceTypeSet = new Set(supporting.map(item => item.sourceType));
    const sourceTypes = ["sheet", "fmkorea", "broadcast"].filter(sourceType => sourceTypeSet.has(sourceType));
    const sourceIds = [...new Set(supporting.map(item => item.sourceId))];
    const nonSheet = [...supporting].sort((left, right) => Date.parse(right.observedAt) - Date.parse(left.observedAt))
      .find(item => item.sourceType !== "sheet");
    const confidences = supporting.map(item => item.ocrConfidence).filter(value => value !== null);
    const verification = accepted.every(candidate => candidate.verification === "broadcast-repeat")
      ? "broadcast-repeat"
      : "cross-source";
    snapshots.push({
      observationId: `OBS-CROSS-${digest.slice(0, 24).toUpperCase()}`,
      playerId,
      fields,
      observedAt: maxTimestamp(accepted.map(candidate => candidate.observedAt)),
      verification,
      primarySourceType: (nonSheet || supporting[0]).sourceType,
      sourceTypes,
      sourceCount: Math.max(sourceTypes.length, verification === "broadcast-repeat" ? sourceIds.length : 0),
      sourceUrls: [...new Set(supporting.map(item => item.sourceUrl).filter(Boolean))],
      evidenceHash: crypto.createHash("sha256").update(evidenceHashes.join(":"), "utf8").digest("hex"),
      batchId: `PROMOTE-${new Date(now).toISOString().slice(0, 10).replace(/-/g, "")}-${digest.slice(0, 8).toUpperCase()}`,
      ocrConfidence: confidences.length ? Math.min(...confidences) : null,
      note: `교차검증 ${accepted.length}개 항목 자동 승격`,
    });
  }
  return snapshots.sort((left, right) => left.playerId.localeCompare(right.playerId));
}

async function promote(options = {}) {
  const queuePath = options.queuePath || DEFAULT_QUEUE_PATH;
  const queued = options.observations || readObservationQueue(queuePath);
  const service = options.service || createSamgukSheetService();
  const payload = await service.load();
  if (payload.stale || payload.source !== "google-sheet") {
    throw new Error("최신 Google Sheet를 읽지 못해 승격을 중단합니다.");
  }
  const snapshots = buildPromotionSnapshots(payload, queued, {
    windowMs: options.windowMs || DEFAULT_CONSENSUS_WINDOW_MS,
    now: options.now ? options.now() : Date.now(),
  });
  const results = [];
  if (options.write) {
    const writer = options.writer || createSamgukSheetWriter();
    for (const snapshot of snapshots) {
      results.push(await writer.appendSnapshot(snapshot));
    }
  }
  return { queuePath, queued: queued.length, snapshots, written: results.length, results };
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const result = await promote(options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`${JSON.stringify({ error: "promotion_failed", message: error.message })}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  DEFAULT_QUEUE_PATH,
  PLAYER_IDS,
  baselineObservations,
  buildPromotionSnapshots,
  completeFields,
  main,
  parseArguments,
  promote,
};
