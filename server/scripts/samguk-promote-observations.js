#!/usr/bin/env node

const crypto = require("node:crypto");
const path = require("node:path");
const FALLBACK = require("../data/samguk-fallback.json");
const { createSamgukSheetService } = require("../lib/samguk-sheet");
const { createSamgukSheetWriter } = require("../lib/samguk-sheet-writer");
const {
  DEFAULT_PROMOTION_AUDIT_SEGMENT_MAX_BYTES,
  appendPromotionAudit,
} = require("../lib/samguk-promotion-audit");
const {
  ALLOWED_FIELDS,
  CURRENT_SEASON_ID,
  DEFAULT_CONSENSUS_WINDOW_MS,
  MONOTONIC_NUMERIC_FIELDS,
  compactObservationQueue,
  dedupeObservations,
  normalizeObservation,
  observationFingerprint,
  readObservationQueue,
  resolveLatestAccepted,
} = require("../lib/samguk-observations");

const DEFAULT_QUEUE_PATH = path.resolve(__dirname, "../data/samguk-observations.ndjson");
const DEFAULT_BASELINE_RETRY_ATTEMPTS = 3;
const DEFAULT_BASELINE_RETRY_BASE_MS = 250;
const DEFAULT_BASELINE_RETRY_MAX_MS = 2_000;
const MAX_BASELINE_RETRY_ATTEMPTS = 5;
const MAX_BASELINE_RETRY_DELAY_MS = 10_000;
const MAX_SNAPSHOT_SOURCE_COUNT = 10;
const PLAYER_IDS = new Map(FALLBACK.members.map((member, index) => [member.soopId, `P${String(index + 1).padStart(3, "0")}`]));

function resolveCacheStampPath(queuePath = DEFAULT_QUEUE_PATH, configuredPath = process.env.SAMGUK_API_CACHE_STAMP_PATH) {
  const configured = String(configuredPath || "").trim();
  const resolvedQueuePath = path.isAbsolute(queuePath)
    ? path.normalize(queuePath)
    : path.resolve(__dirname, "..", queuePath);
  if (!configured) return `${resolvedQueuePath}.api-cache-stamp`;
  return path.isAbsolute(configured)
    ? path.normalize(configured)
    : path.resolve(__dirname, "..", configured);
}

function boundedPositiveInteger(value, fallback, maximum, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    if (value === undefined || value === null || value === "") return fallback;
    throw new RangeError(`${label}는 1~${maximum} 범위의 정수여야 합니다.`);
  }
  return parsed;
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function isFreshBaseline(payload) {
  return Boolean(payload
    && payload.stale === false
    && payload.source === "google-sheet"
    && payload.seasonId === CURRENT_SEASON_ID);
}

async function loadFreshBaseline(service, options = {}) {
  if (!service || typeof service.load !== "function") {
    throw new TypeError("Google Sheet service.load가 필요합니다.");
  }
  const attempts = boundedPositiveInteger(
    options.attempts,
    DEFAULT_BASELINE_RETRY_ATTEMPTS,
    MAX_BASELINE_RETRY_ATTEMPTS,
    "baseline retry attempts",
  );
  const baseDelayMs = boundedPositiveInteger(
    options.baseDelayMs,
    DEFAULT_BASELINE_RETRY_BASE_MS,
    MAX_BASELINE_RETRY_DELAY_MS,
    "baseline retry base delay",
  );
  const maxDelayMs = boundedPositiveInteger(
    options.maxDelayMs,
    DEFAULT_BASELINE_RETRY_MAX_MS,
    MAX_BASELINE_RETRY_DELAY_MS,
    "baseline retry max delay",
  );
  const sleepFn = options.sleepFn || delay;
  if (typeof sleepFn !== "function") throw new TypeError("baseline retry sleepFn은 함수여야 합니다.");

  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const payload = await service.load();
      if (isFreshBaseline(payload)) return { payload, attempts: attempt };
      if (payload?.seasonId && payload.seasonId !== CURRENT_SEASON_ID) {
        const error = new Error(`Google Sheet seasonId는 '${CURRENT_SEASON_ID}'여야 합니다.`);
        error.code = "invalid_season";
        throw error;
      }
      const error = new Error("최신 Google Sheet baseline을 읽지 못했습니다.");
      error.code = "baseline_unavailable";
      lastError = error;
    } catch (error) {
      lastError = error;
      if (new Set(["config_error", "invalid_config", "invalid_season"]).has(error?.code)) throw error;
    }

    if (attempt < attempts) {
      const waitMs = Math.min(maxDelayMs, baseDelayMs * (2 ** (attempt - 1)));
      await sleepFn(waitMs, attempt);
    }
  }

  const error = new Error(`${attempts}회 재시도 후에도 최신 Google Sheet를 읽지 못해 승격을 중단합니다.`);
  error.code = "baseline_unavailable";
  if (lastError) error.cause = lastError;
  throw error;
}

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
  if (!payload || payload.seasonId !== CURRENT_SEASON_ID) {
    throw new Error(`Google Sheet seasonId는 '${CURRENT_SEASON_ID}'여야 합니다.`);
  }
  const observations = [];
  for (const member of payload.members) {
    const playerId = PLAYER_IDS.get(member.soopId);
    if (!playerId) continue;
    for (const field of ALLOWED_FIELDS) {
      const value = member[field];
      if (value === null || value === undefined || value === "") continue;
      observations.push({
        seasonId: payload.seasonId,
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
  const latest = resolveLatestAccepted(inputs, { baselines, windowMs, now });
  const observationsById = new Map(inputs.map(observation => [observation.observationId, observation]));
  const memberByPlayerId = new Map(payload.members.map(member => [PLAYER_IDS.get(member.soopId), member]));
  const acceptedByPlayer = new Map();

  for (const candidate of latest) {
    if (candidate.verification === "sheet-baseline") continue;
    const member = memberByPlayerId.get(candidate.playerId);
    if (!member || candidate.value === member[candidate.field]) continue;
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
    const sourceTypes = ["sheet", "gamcom", "fmkorea", "broadcast"].filter(sourceType => sourceTypeSet.has(sourceType));
    const nonSheet = [...supporting].sort((left, right) => Date.parse(right.observedAt) - Date.parse(left.observedAt))
      .find(item => item.sourceType !== "sheet");
    const confidences = supporting.map(item => item.ocrConfidence).filter(value => value !== null);
    const verification = accepted.every(candidate => candidate.verification === "broadcast-repeat")
      ? "broadcast-repeat"
      : "cross-source";
    const minimumEvidenceCount = Math.min(...accepted.map(candidate => (
      candidate.verification === "broadcast-repeat"
        ? candidate.evidenceUnitIds.length
        : candidate.sourceTypes.length
    )));
    snapshots.push({
      seasonId: payload.seasonId,
      observationId: `OBS-CROSS-${digest.slice(0, 24).toUpperCase()}`,
      playerId,
      fields,
      observedAt: maxTimestamp(accepted.map(candidate => candidate.observedAt)),
      verification,
      primarySourceType: (nonSheet || supporting[0]).sourceType,
      sourceTypes,
      sourceCount: Math.min(
        MAX_SNAPSHOT_SOURCE_COUNT,
        minimumEvidenceCount,
      ),
      sourceUrls: [...new Set(supporting.map(item => item.sourceUrl).filter(Boolean))]
        .slice(0, MAX_SNAPSHOT_SOURCE_COUNT),
      evidenceHash: crypto.createHash("sha256").update(evidenceHashes.join(":"), "utf8").digest("hex"),
      batchId: `PROMOTE-${new Date(now).toISOString().slice(0, 10).replace(/-/g, "")}-${digest.slice(0, 8).toUpperCase()}`,
      ocrConfidence: confidences.length ? Math.min(...confidences) : null,
      note: `교차검증 ${accepted.length}개 항목 자동 승격`,
    });
  }
  return snapshots.sort((left, right) => left.playerId.localeCompare(right.playerId));
}

function observationTargetKey(playerId, field) {
  return `${playerId}\u0000${field}`;
}

function observationValueKey(value) {
  return JSON.stringify(value);
}

function currentSheetState(payload, now) {
  const state = new Map();
  for (const observation of baselineObservations(payload, now)) {
    const normalized = normalizeObservation(observation, { now });
    state.set(
      observationTargetKey(normalized.playerId, normalized.field),
      normalized.value,
    );
  }
  return state;
}

function compactQueuedObservations(payload, snapshots, queued, { now = Date.now() } = {}) {
  const observations = dedupeObservations(queued, { now });
  const previousState = currentSheetState(payload, now);
  const nextState = new Map(previousState);

  for (const snapshot of snapshots) {
    for (const field of ALLOWED_FIELDS) {
      const key = observationTargetKey(snapshot.playerId, field);
      const value = snapshot.fields?.[field];
      if (value === null || value === undefined || value === "") {
        nextState.delete(key);
        continue;
      }
      const normalized = normalizeObservation({
        seasonId: snapshot.seasonId,
        playerId: snapshot.playerId,
        field,
        value,
        sourceType: "sheet",
        sourceId: `promoted-state:${snapshot.playerId}:${field}`,
        observedAt: snapshot.observedAt,
        collectedAt: new Date(now).toISOString(),
      }, { now });
      nextState.set(key, normalized.value);
    }
  }

  const groups = new Map();
  for (const observation of observations) {
    const key = observationTargetKey(observation.playerId, observation.field);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(observation);
  }

  const retained = [];
  const removed = [];
  for (const [key, group] of groups) {
    if (!nextState.has(key)) {
      retained.push(...group);
      continue;
    }
    const sheetValue = observationValueKey(nextState.get(key));
    const matchesSheet = observation => observationValueKey(observation.value) === sheetValue;
    const monotonic = MONOTONIC_NUMERIC_FIELDS.has(group[0].field);
    for (const observation of group) {
      const resolved = monotonic
        ? observation.value <= nextState.get(key)
        : matchesSheet(observation);
      (resolved ? removed : retained).push(observation);
    }
  }

  return { retained, removed };
}

function assertArchiveAcknowledged(result, expected, now) {
  if (!result || !Array.isArray(result.inserted) || !Array.isArray(result.duplicates)) {
    throw new TypeError("archiveFn은 inserted/duplicates 배열로 기록 결과를 확인해야 합니다.");
  }
  const expectedRows = dedupeObservations(expected, { now });
  const acknowledgedRows = dedupeObservations([...result.inserted, ...result.duplicates], { now });
  const acknowledged = new Map(
    acknowledgedRows.map(row => [row.observationId, observationFingerprint(row)]),
  );
  if (expectedRows.length !== acknowledged.size
    || expectedRows.some(row => (
      acknowledged.get(row.observationId) !== observationFingerprint(row)
    ))) {
    throw new Error("promotion audit가 제거 대상 전체를 확인하지 못했습니다.");
  }
}

async function promote(options = {}) {
  const queuePath = options.queuePath || DEFAULT_QUEUE_PATH;
  const archivePath = options.archivePath || process.env.SAMGUK_PROMOTION_AUDIT_PATH
    || `${queuePath}.promoted`;
  if (!path.isAbsolute(archivePath)) throw new Error("promotion audit는 절대 경로여야 합니다.");
  if (path.resolve(archivePath) === path.resolve(queuePath)) {
    throw new Error("promotion audit 경로는 queue와 달라야 합니다.");
  }
  const observationsWereInjected = Object.prototype.hasOwnProperty.call(options, "observations");
  const queued = observationsWereInjected ? options.observations : readObservationQueue(queuePath);
  const rewriteFn = options.rewriteFn ?? null;
  if (rewriteFn !== null && typeof rewriteFn !== "function") {
    throw new TypeError("rewriteFn은 함수 또는 null이어야 합니다.");
  }
  const compactFn = options.compactFn ?? compactObservationQueue;
  const archiveFn = options.archiveFn ?? appendPromotionAudit;
  const configuredArchiveSegmentMaxBytes = options.archiveSegmentMaxBytes
    ?? process.env.SAMGUK_PROMOTION_AUDIT_SEGMENT_MAX_BYTES
    ?? DEFAULT_PROMOTION_AUDIT_SEGMENT_MAX_BYTES;
  if (!observationsWereInjected && typeof compactFn !== "function") {
    throw new TypeError("compactFn은 함수여야 합니다.");
  }
  if (typeof archiveFn !== "function") throw new TypeError("archiveFn은 함수여야 합니다.");
  const service = options.service || createSamgukSheetService();
  const baseline = await loadFreshBaseline(service, {
    attempts: options.baselineRetryAttempts ?? process.env.SAMGUK_BASELINE_RETRY_ATTEMPTS,
    baseDelayMs: options.baselineRetryBaseMs ?? process.env.SAMGUK_BASELINE_RETRY_BASE_MS,
    maxDelayMs: options.baselineRetryMaxMs ?? process.env.SAMGUK_BASELINE_RETRY_MAX_MS,
    sleepFn: options.sleepFn,
  });
  const payload = baseline.payload;
  const now = options.now ? options.now() : Date.now();
  const snapshots = buildPromotionSnapshots(payload, queued, {
    windowMs: options.windowMs ?? DEFAULT_CONSENSUS_WINDOW_MS,
    now,
  });
  const results = [];
  let compaction = null;
  if (options.write) {
    const writer = options.writer || createSamgukSheetWriter();
    for (const snapshot of snapshots) {
      results.push(await writer.appendSnapshot(snapshot));
    }
    if (observationsWereInjected && rewriteFn) {
      const compacted = compactQueuedObservations(payload, snapshots, queued, { now });
      if (options.archivePath && compacted.removed.length > 0) {
        const archiveResult = await archiveFn(archivePath, compacted.removed, {
          now,
          segmentMaxBytes: configuredArchiveSegmentMaxBytes,
        });
        assertArchiveAcknowledged(archiveResult, compacted.removed, now);
      }
      await rewriteFn(queuePath, compacted.retained, { now });
      compaction = {
        scanned: queued.length,
        removed: compacted.removed.length,
        retained: compacted.retained.length,
        archived: options.archivePath ? compacted.removed.length : 0,
      };
    } else if (!observationsWereInjected) {
      let compacted;
      const compactResult = await compactFn(queuePath, (currentQueued) => {
        compacted = compactQueuedObservations(payload, snapshots, currentQueued, { now });
        if (compacted.removed.length > 0) {
          const archiveResult = archiveFn(archivePath, compacted.removed, {
            now,
            segmentMaxBytes: configuredArchiveSegmentMaxBytes,
          });
          if (archiveResult && typeof archiveResult.then === "function") {
            throw new TypeError("실제 queue의 archiveFn은 동기 함수여야 합니다.");
          }
          assertArchiveAcknowledged(archiveResult, compacted.removed, now);
        }
        return compacted.retained;
      }, {
        now,
        lockTimeoutMs: options.lockTimeoutMs,
        lockStaleMs: options.lockStaleMs,
      });
      if (!compacted) throw new Error("queue compaction transform이 실행되지 않았습니다.");
      compaction = {
        scanned: compactResult?.scanned ?? compacted.retained.length + compacted.removed.length,
        removed: compacted.removed.length,
        retained: compacted.retained.length,
        archived: compacted.removed.length,
      };
    }
  }
  return {
    queuePath,
    queued: queued.length,
    snapshots,
    written: results.length,
    results,
    compaction,
    baselineAttempts: baseline.attempts,
  };
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
  DEFAULT_BASELINE_RETRY_ATTEMPTS,
  DEFAULT_BASELINE_RETRY_BASE_MS,
  DEFAULT_BASELINE_RETRY_MAX_MS,
  DEFAULT_QUEUE_PATH,
  MAX_BASELINE_RETRY_ATTEMPTS,
  MAX_SNAPSHOT_SOURCE_COUNT,
  PLAYER_IDS,
  baselineObservations,
  buildPromotionSnapshots,
  compactQueuedObservations,
  completeFields,
  isFreshBaseline,
  loadFreshBaseline,
  main,
  parseArguments,
  promote,
  resolveCacheStampPath,
};
