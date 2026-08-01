const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const ALLOWED_FIELDS = Object.freeze([
  "level",
  "horse",
  "horseLevel",
  "weapon",
  "helmet",
  "armor",
  "shoes",
  "strength",
  "agility",
  "vitality",
  "intelligence",
  "powerScore",
]);
const SOURCE_TYPES = Object.freeze(["sheet", "fmkorea", "broadcast"]);
const DEFAULT_CONSENSUS_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_QUEUE_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_LINE_MAX_BYTES = 16 * 1024;
const MAX_BATCH_SIZE = 1_000;
const MAX_NUMERIC_VALUE = 1_000_000_000;
const PLAYER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const OBSERVATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const HASH_PATTERN = /^[a-fA-F0-9]{64}$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
const ALLOWED_INPUT_KEYS = new Set([
  "observationId",
  "playerId",
  "field",
  "value",
  "sourceType",
  "sourceId",
  "sourceUrl",
  "observedAt",
  "collectedAt",
  "evidenceHash",
  "ocrConfidence",
]);

class SamgukObservationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SamgukObservationError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new SamgukObservationError(code, message);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value);
}

function normalizeText(value, label, { maxLength, pattern } = {}) {
  if (typeof value !== "string" && typeof value !== "number") {
    fail("invalid_schema", `${label}은(는) 문자열이어야 합니다.`);
  }
  const normalized = String(value).normalize("NFKC").trim();
  if (!normalized) fail("invalid_schema", `${label}이(가) 비어 있습니다.`);
  if (CONTROL_CHARACTER_PATTERN.test(normalized)) {
    fail("invalid_schema", `${label}에 제어 문자를 사용할 수 없습니다.`);
  }
  if (maxLength && normalized.length > maxLength) {
    fail("invalid_schema", `${label}은(는) ${maxLength}자를 넘을 수 없습니다.`);
  }
  if (pattern && !pattern.test(normalized)) {
    fail("invalid_schema", `${label} 형식이 올바르지 않습니다.`);
  }
  return normalized;
}

function normalizeTimestamp(value, label, fallback) {
  const candidate = value === undefined || value === null || value === "" ? fallback : value;
  if (candidate instanceof Date && Number.isFinite(candidate.getTime())) {
    return candidate.toISOString();
  }
  if (typeof candidate !== "string" && typeof candidate !== "number") {
    fail("invalid_timestamp", `${label} 시각이 올바르지 않습니다.`);
  }
  const timestamp = typeof candidate === "number" ? candidate : Date.parse(candidate);
  if (!Number.isFinite(timestamp)) fail("invalid_timestamp", `${label} 시각이 올바르지 않습니다.`);
  const year = new Date(timestamp).getUTCFullYear();
  if (year < 2000 || year > 2100) fail("invalid_timestamp", `${label} 시각 범위를 확인하세요.`);
  return new Date(timestamp).toISOString();
}

function normalizeNumber(value, field) {
  if (typeof value === "string") {
    const compact = value.trim().replace(/,/g, "");
    if (!compact) fail("invalid_value", `${field} 값이 비어 있습니다.`);
    value = Number(compact);
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > MAX_NUMERIC_VALUE) {
    fail("invalid_value", `${field} 값은 0 이상 ${MAX_NUMERIC_VALUE} 이하의 숫자여야 합니다.`);
  }
  if (field !== "powerScore" && !Number.isInteger(value)) {
    fail("invalid_value", `${field} 값은 정수여야 합니다.`);
  }
  return Object.is(value, -0) ? 0 : value;
}

function normalizeValue(field, value) {
  if (field === "horse") {
    return normalizeText(value, "horse", { maxLength: 80 });
  }
  return normalizeNumber(value, field);
}

function hostMatches(hostname, root) {
  return hostname === root || hostname.endsWith(`.${root}`);
}

function sourceHostAllowed(sourceType, hostname) {
  if (sourceType === "sheet") return hostname === "docs.google.com";
  if (sourceType === "fmkorea") return hostMatches(hostname, "fmkorea.com");
  if (sourceType === "broadcast") {
    return hostMatches(hostname, "sooplive.com") || hostMatches(hostname, "sooplive.co.kr");
  }
  return false;
}

function normalizeSourceUrl(value, sourceType) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > 2_048 || CONTROL_CHARACTER_PATTERN.test(value)) {
    fail("invalid_url", "sourceUrl 형식이 올바르지 않습니다.");
  }
  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    fail("invalid_url", "sourceUrl 형식이 올바르지 않습니다.");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    fail("invalid_url", "sourceUrl은 인증정보가 없는 HTTPS URL이어야 합니다.");
  }
  const hostname = parsed.hostname.toLowerCase();
  if (!sourceHostAllowed(sourceType, hostname)) {
    fail("invalid_url", `${sourceType} 출처에 허용되지 않은 sourceUrl 호스트입니다.`);
  }
  parsed.hostname = hostname;
  return parsed.toString();
}

function normalizeConfidence(value) {
  if (value === undefined || value === null || value === "") return null;
  const number = typeof value === "string" ? Number(value.trim()) : value;
  if (typeof number !== "number" || !Number.isFinite(number) || number < 0 || number > 1) {
    fail("invalid_confidence", "ocrConfidence는 0 이상 1 이하의 숫자여야 합니다.");
  }
  return number;
}

function observationFingerprint(observation) {
  return sha256(canonicalJson({
    evidenceHash: observation.evidenceHash,
    field: observation.field,
    observedAt: observation.observedAt,
    ocrConfidence: observation.ocrConfidence,
    playerId: observation.playerId,
    sourceId: observation.sourceId,
    sourceType: observation.sourceType,
    sourceUrl: observation.sourceUrl,
    value: observation.value,
  }));
}

function normalizeObservation(input, { now = Date.now() } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    fail("invalid_schema", "관측값은 JSON 객체여야 합니다.");
  }
  const unexpected = Object.keys(input).filter(key => !ALLOWED_INPUT_KEYS.has(key));
  if (unexpected.length > 0) {
    fail("invalid_schema", `허용되지 않은 필드입니다: ${unexpected.join(", ")}`);
  }

  const playerId = normalizeText(input.playerId, "playerId", {
    maxLength: 64,
    pattern: PLAYER_ID_PATTERN,
  });
  const field = normalizeText(input.field, "field", { maxLength: 32 });
  if (!ALLOWED_FIELDS.includes(field)) fail("invalid_field", `허용되지 않은 관측 필드입니다: ${field}`);
  const sourceType = normalizeText(input.sourceType, "sourceType", { maxLength: 16 }).toLowerCase();
  if (!SOURCE_TYPES.includes(sourceType)) fail("invalid_source", `허용되지 않은 출처입니다: ${sourceType}`);
  const sourceId = normalizeText(input.sourceId, "sourceId", { maxLength: 256 });
  const sourceUrl = normalizeSourceUrl(input.sourceUrl, sourceType);
  const observedAt = normalizeTimestamp(input.observedAt, "observedAt");
  const collectedAt = normalizeTimestamp(input.collectedAt, "collectedAt", now);
  const value = normalizeValue(field, input.value);
  const ocrConfidence = normalizeConfidence(input.ocrConfidence);
  const evidenceHash = input.evidenceHash === undefined || input.evidenceHash === null || input.evidenceHash === ""
    ? sha256(canonicalJson({ sourceId, sourceType, sourceUrl }))
    : normalizeText(input.evidenceHash, "evidenceHash", { maxLength: 64, pattern: HASH_PATTERN }).toLowerCase();

  const normalized = {
    observationId: null,
    playerId,
    field,
    value,
    sourceType,
    sourceId,
    sourceUrl,
    observedAt,
    collectedAt,
    evidenceHash,
    ocrConfidence,
  };
  const generatedId = `OBS-${observationFingerprint(normalized).slice(0, 24).toUpperCase()}`;
  normalized.observationId = input.observationId === undefined || input.observationId === null || input.observationId === ""
    ? generatedId
    : normalizeText(input.observationId, "observationId", {
      maxLength: 128,
      pattern: OBSERVATION_ID_PATTERN,
    });
  return normalized;
}

function normalizeWindowMs(value) {
  const windowMs = Number(value ?? DEFAULT_CONSENSUS_WINDOW_MS);
  if (!Number.isFinite(windowMs) || windowMs <= 0 || windowMs > 30 * 24 * 60 * 60 * 1000) {
    fail("invalid_window", "교차검증 window는 0초 초과 30일 이하여야 합니다.");
  }
  return windowMs;
}

function dedupeObservations(observations, options) {
  if (!Array.isArray(observations)) fail("invalid_schema", "관측 목록은 배열이어야 합니다.");
  const result = [];
  const fingerprints = new Set();
  const ids = new Map();
  for (const input of observations) {
    const observation = normalizeObservation(input, options);
    const fingerprint = observationFingerprint(observation);
    const priorFingerprint = ids.get(observation.observationId);
    if (priorFingerprint && priorFingerprint !== fingerprint) {
      fail("observation_id_conflict", `observationId '${observation.observationId}'의 내용이 서로 다릅니다.`);
    }
    ids.set(observation.observationId, fingerprint);
    if (fingerprints.has(fingerprint)) continue;
    fingerprints.add(fingerprint);
    result.push(observation);
  }
  return result;
}

function valueKey(value) {
  return canonicalJson(value);
}

function consensusKey(observation) {
  return `${observation.playerId}\u0000${observation.field}\u0000${valueKey(observation.value)}`;
}

function targetKey(observation) {
  return `${observation.playerId}\u0000${observation.field}`;
}

function findAcceptedConsensus(inputs, { windowMs = DEFAULT_CONSENSUS_WINDOW_MS } = {}) {
  const normalizedWindowMs = normalizeWindowMs(windowMs);
  const observations = dedupeObservations(inputs);
  const groups = new Map();
  for (const observation of observations) {
    const key = consensusKey(observation);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(observation);
  }

  const accepted = [];
  for (const group of groups.values()) {
    group.sort((left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt));
    let start = 0;
    let latest = null;
    for (let end = 0; end < group.length; end += 1) {
      const endTime = Date.parse(group[end].observedAt);
      while (endTime - Date.parse(group[start].observedAt) > normalizedWindowMs) start += 1;
      const window = group.slice(start, end + 1);
      const sourceTypes = new Set(window.map(item => item.sourceType));
      const highConfidenceBroadcasts = window.filter(item => (
        item.sourceType === "broadcast" && item.ocrConfidence !== null && item.ocrConfidence >= 0.95
      ));
      const broadcastSourceIds = new Set(highConfidenceBroadcasts.map(item => item.sourceId));
      const crossSource = sourceTypes.size >= 2;
      const repeatedBroadcast = broadcastSourceIds.size >= 2;
      if (!crossSource && !repeatedBroadcast) continue;

      const supporting = crossSource ? window : highConfidenceBroadcasts;
      latest = {
        playerId: group[end].playerId,
        field: group[end].field,
        value: group[end].value,
        observedAt: group[end].observedAt,
        verification: crossSource ? "cross-source" : "broadcast-repeat",
        sourceTypes: [...new Set(supporting.map(item => item.sourceType))].sort(),
        sourceIds: [...new Set(supporting.map(item => item.sourceId))].sort(),
        observationIds: [...new Set(supporting.map(item => item.observationId))].sort(),
        evidenceHashes: [...new Set(supporting.map(item => item.evidenceHash))].sort(),
      };
    }
    if (latest) accepted.push(latest);
  }
  return accepted.sort((left, right) => (
    Date.parse(right.observedAt) - Date.parse(left.observedAt)
      || left.playerId.localeCompare(right.playerId)
      || left.field.localeCompare(right.field)
  ));
}

function acceptSheetBaseline(input) {
  const observation = normalizeObservation(input);
  if (observation.sourceType !== "sheet") {
    fail("invalid_baseline", "초기 baseline은 sheet 출처만 즉시 채택할 수 있습니다.");
  }
  return {
    playerId: observation.playerId,
    field: observation.field,
    value: observation.value,
    observedAt: observation.observedAt,
    verification: "sheet-baseline",
    sourceTypes: ["sheet"],
    sourceIds: [observation.sourceId],
    observationIds: [observation.observationId],
    evidenceHashes: [observation.evidenceHash],
  };
}

function chooseLatestConsensus(candidates) {
  if (candidates.length === 0) return null;
  const sorted = [...candidates].sort((left, right) => (
    Date.parse(right.observedAt) - Date.parse(left.observedAt)
      || Number(left.verification === "sheet-baseline") - Number(right.verification === "sheet-baseline")
      || valueKey(left.value).localeCompare(valueKey(right.value))
  ));
  for (let index = 0; index < sorted.length;) {
    const observedAt = sorted[index].observedAt;
    const sameTime = [];
    while (index < sorted.length && sorted[index].observedAt === observedAt) {
      sameTime.push(sorted[index]);
      index += 1;
    }
    if (new Set(sameTime.map(candidate => valueKey(candidate.value))).size === 1) {
      return sameTime[0];
    }
  }
  return null;
}

function resolveLatestAccepted(inputs, {
  baselines = [],
  windowMs = DEFAULT_CONSENSUS_WINDOW_MS,
} = {}) {
  if (!Array.isArray(baselines)) fail("invalid_schema", "baselines는 배열이어야 합니다.");
  const candidates = [
    ...findAcceptedConsensus(inputs, { windowMs }),
    ...baselines.map(acceptSheetBaseline),
  ];
  const groups = new Map();
  for (const candidate of candidates) {
    const key = targetKey(candidate);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(candidate);
  }
  const latest = [];
  for (const group of groups.values()) {
    const candidate = chooseLatestConsensus(group);
    if (candidate) latest.push(candidate);
  }
  return latest.sort((left, right) => (
    left.playerId.localeCompare(right.playerId) || left.field.localeCompare(right.field)
  ));
}

function ensureQueuePath(filePath) {
  if (typeof filePath !== "string" || !filePath.trim()) fail("invalid_path", "queue 경로가 필요합니다.");
  const resolved = path.resolve(filePath);
  let stat;
  try {
    stat = fs.lstatSync(resolved);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (stat && (!stat.isFile() || stat.isSymbolicLink())) {
    fail("invalid_path", "queue는 일반 파일이어야 합니다.");
  }
  return resolved;
}

function readObservationQueue(filePath, { maxBytes = DEFAULT_QUEUE_MAX_BYTES } = {}) {
  const resolved = ensureQueuePath(filePath);
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  if (stat.size > maxBytes) fail("queue_too_large", `queue가 ${maxBytes}바이트 제한을 넘었습니다.`);
  const content = fs.readFileSync(resolved, "utf8");
  const rows = [];
  for (const [index, line] of content.split("\n").entries()) {
    if (!line.trim()) continue;
    if (Buffer.byteLength(line) > DEFAULT_LINE_MAX_BYTES) {
      fail("queue_corrupt", `queue ${index + 1}행이 너무 큽니다.`);
    }
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      fail("queue_corrupt", `queue ${index + 1}행 JSON이 올바르지 않습니다.`);
    }
    try {
      rows.push(normalizeObservation(parsed));
    } catch (error) {
      if (error instanceof SamgukObservationError) {
        fail("queue_corrupt", `queue ${index + 1}행이 올바르지 않습니다: ${error.message}`);
      }
      throw error;
    }
  }
  return dedupeObservations(rows);
}

function appendObservationQueue(filePath, inputs, {
  maxBytes = DEFAULT_QUEUE_MAX_BYTES,
  now = Date.now(),
} = {}) {
  const batch = Array.isArray(inputs) ? inputs : [inputs];
  if (batch.length === 0) fail("invalid_schema", "추가할 관측값이 없습니다.");
  if (batch.length > MAX_BATCH_SIZE) fail("batch_too_large", `한 번에 ${MAX_BATCH_SIZE}건까지만 추가할 수 있습니다.`);
  const resolved = ensureQueuePath(filePath);
  const existing = readObservationQueue(resolved, { maxBytes });
  const existingByFingerprint = new Map(existing.map(item => [observationFingerprint(item), item]));
  const existingById = new Map(existing.map(item => [item.observationId, observationFingerprint(item)]));
  const inserted = [];
  const duplicates = [];

  for (const input of batch) {
    const observation = normalizeObservation(input, { now });
    const fingerprint = observationFingerprint(observation);
    const priorIdFingerprint = existingById.get(observation.observationId);
    if (priorIdFingerprint && priorIdFingerprint !== fingerprint) {
      fail("observation_id_conflict", `observationId '${observation.observationId}'가 기존 내용과 다릅니다.`);
    }
    const duplicate = existingByFingerprint.get(fingerprint);
    if (duplicate) {
      duplicates.push(duplicate);
      continue;
    }
    existingByFingerprint.set(fingerprint, observation);
    existingById.set(observation.observationId, fingerprint);
    inserted.push(observation);
  }

  if (inserted.length > 0) {
    const payload = inserted.map(item => `${JSON.stringify(item)}\n`).join("");
    for (const line of payload.split("\n")) {
      if (line && Buffer.byteLength(line) > DEFAULT_LINE_MAX_BYTES) {
        fail("line_too_large", `관측 한 건은 ${DEFAULT_LINE_MAX_BYTES}바이트를 넘을 수 없습니다.`);
      }
    }
    fs.mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
    const noFollow = fs.constants.O_NOFOLLOW || 0;
    const descriptor = fs.openSync(
      resolved,
      fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | noFollow,
      0o600,
    );
    try {
      const currentSize = fs.fstatSync(descriptor).size;
      if (currentSize + Buffer.byteLength(payload) > maxBytes) {
        fail("queue_too_large", `queue가 ${maxBytes}바이트 제한을 넘습니다.`);
      }
      fs.writeSync(descriptor, payload, null, "utf8");
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
  }

  return {
    inserted,
    duplicates,
    all: [...existing, ...inserted],
  };
}

module.exports = {
  ALLOWED_FIELDS,
  DEFAULT_CONSENSUS_WINDOW_MS,
  DEFAULT_LINE_MAX_BYTES,
  DEFAULT_QUEUE_MAX_BYTES,
  SOURCE_TYPES,
  SamgukObservationError,
  acceptSheetBaseline,
  appendObservationQueue,
  dedupeObservations,
  findAcceptedConsensus,
  normalizeObservation,
  observationFingerprint,
  readObservationQueue,
  resolveLatestAccepted,
  sourceHostAllowed,
};
