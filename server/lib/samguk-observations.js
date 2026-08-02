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
const MIN_BROADCAST_CONFIDENCE = 0.95;
const DEFAULT_CONSENSUS_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_OBSERVATION_FUTURE_SKEW_MS = 5 * 60 * 1000;
const DEFAULT_QUEUE_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_LINE_MAX_BYTES = 16 * 1024;
const DEFAULT_QUEUE_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_QUEUE_LOCK_STALE_MS = 30_000;
const QUEUE_LOCK_RETRY_MS = 10;
const QUEUE_LOCK_RECORD_MAX_BYTES = 1_024;
const MAX_BATCH_SIZE = 1_000;
const NUMERIC_FIELD_MAXIMUMS = Object.freeze({
  level: 10_000,
  horseLevel: 999,
  weapon: 999,
  helmet: 999,
  armor: 999,
  shoes: 999,
  strength: 1_000_000,
  agility: 1_000_000,
  vitality: 1_000_000,
  intelligence: 1_000_000,
  powerScore: 1_000_000,
});
const PLAYER_ID_PATTERN = /^P\d{3}$/;
const OBSERVATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const HASH_PATTERN = /^[a-fA-F0-9]{64}$/;
const LOCK_OWNER_ID_PATTERN = /^[a-f0-9]{32}$/;
const LOCK_OWNER_FILE_PATTERN = /^owner-([a-f0-9]{32})\.json$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
const LOCK_SLEEP_BUFFER = new Int32Array(new SharedArrayBuffer(4));
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
  const maximum = NUMERIC_FIELD_MAXIMUMS[field];
  if (!Number.isSafeInteger(maximum)) fail("invalid_field", `지원하지 않는 숫자 필드 '${field}'입니다.`);
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > maximum) {
    fail("invalid_value", `${field} 값은 0 이상 ${maximum} 이하의 숫자여야 합니다.`);
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

/**
 * HLS monitor sourceId는 같은 media segment 안의 frame마다 시각/sample suffix가 다르다.
 * 반복 방송 검증에서는 frame이 아니라 segment를 독립 근거 단위로 센다.
 * 수동/구형 screen sourceId는 기존처럼 sourceId 자체를 한 단위로 유지한다.
 */
function broadcastEvidenceUnitId(sourceId) {
  const normalized = String(sourceId || "");
  const hls = /^screen:(P\d{3}):\d{13}:([a-f0-9]{16}):(?:mid|\d+)$/i.exec(normalized);
  return hls ? `hls:${hls[1].toUpperCase()}:${hls[2].toLowerCase()}` : normalized;
}

function findAcceptedConsensus(inputs, {
  windowMs = DEFAULT_CONSENSUS_WINDOW_MS,
  now,
} = {}) {
  const normalizedWindowMs = normalizeWindowMs(windowMs);
  const currentTime = now === undefined ? null : Number(now);
  if (currentTime !== null && (!Number.isFinite(currentTime) || currentTime < 0)) {
    fail("invalid_timestamp", "교차검증 기준 시각이 올바르지 않습니다.");
  }
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
      if (currentTime !== null && (
        endTime < currentTime - normalizedWindowMs
        || endTime > currentTime + MAX_OBSERVATION_FUTURE_SKEW_MS
      )) continue;
      const window = group.slice(start, end + 1);
      const eligibleWindow = window.filter(item => (
        item.sourceType !== "broadcast"
          || (item.ocrConfidence !== null && item.ocrConfidence >= MIN_BROADCAST_CONFIDENCE)
      ));
      const sourceTypes = new Set(eligibleWindow.map(item => item.sourceType));
      const highConfidenceBroadcasts = eligibleWindow.filter(item => (
        item.sourceType === "broadcast"
      ));
      const broadcastEvidenceUnits = new Set(
        highConfidenceBroadcasts.map(item => broadcastEvidenceUnitId(item.sourceId)),
      );
      const broadcastEvidenceHashes = new Set(
        highConfidenceBroadcasts.map(item => item.evidenceHash),
      );
      const crossSource = sourceTypes.size >= 2;
      const repeatedBroadcast = broadcastEvidenceUnits.size >= 2
        && broadcastEvidenceHashes.size >= 2;
      if (!crossSource && !repeatedBroadcast) continue;

      const supporting = crossSource ? eligibleWindow : highConfidenceBroadcasts;
      const latestSupporting = supporting[supporting.length - 1];
      latest = {
        playerId: latestSupporting.playerId,
        field: latestSupporting.field,
        value: latestSupporting.value,
        observedAt: latestSupporting.observedAt,
        verification: crossSource ? "cross-source" : "broadcast-repeat",
        sourceTypes: [...new Set(supporting.map(item => item.sourceType))].sort(),
        sourceIds: [...new Set(supporting.map(item => item.sourceId))].sort(),
        evidenceUnitIds: [...new Set(supporting.map(item => (
          item.sourceType === "broadcast" ? broadcastEvidenceUnitId(item.sourceId) : item.sourceId
        )))].sort(),
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
  now,
} = {}) {
  if (!Array.isArray(baselines)) fail("invalid_schema", "baselines는 배열이어야 합니다.");
  const candidates = [
    ...findAcceptedConsensus(inputs, { windowMs, now }),
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

function queueLockError(code, message) {
  return new SamgukObservationError(code, message);
}

function sameInode(left, right) {
  return Boolean(left && right && left.dev === right.dev && left.ino === right.ino);
}

function monotonicMilliseconds() {
  return Number(process.hrtime.bigint() / 1_000_000n);
}

function waitSynchronously(milliseconds) {
  if (milliseconds > 0) Atomics.wait(LOCK_SLEEP_BUFFER, 0, 0, milliseconds);
}

function normalizeQueueLockOptions(options = {}) {
  const timeoutMs = options.lockTimeoutMs ?? DEFAULT_QUEUE_LOCK_TIMEOUT_MS;
  const staleMs = options.lockStaleMs ?? DEFAULT_QUEUE_LOCK_STALE_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 60_000) {
    fail("invalid_schema", "lockTimeoutMs는 0~60000 범위의 정수여야 합니다.");
  }
  if (!Number.isSafeInteger(staleMs) || staleMs < 1 || staleMs > 86_400_000) {
    fail("invalid_schema", "lockStaleMs는 1~86400000 범위의 정수여야 합니다.");
  }
  return { timeoutMs, staleMs };
}

function prepareQueueLockTarget(filePath) {
  let resolved;
  try {
    resolved = ensureQueuePath(filePath);
    fs.mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
    const directoryStat = fs.lstatSync(path.dirname(resolved));
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
      throw queueLockError("invalid_lock_path", "queue lock 상위 경로가 안전하지 않습니다.");
    }
  } catch (error) {
    if (error instanceof SamgukObservationError) throw error;
    throw queueLockError("invalid_lock_path", "queue lock 경로를 준비하지 못했습니다.");
  }
  return resolved;
}

let cachedBootId;
let bootIdLoaded = false;

function getBootId() {
  if (bootIdLoaded) return cachedBootId;
  bootIdLoaded = true;
  try {
    const value = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    cachedBootId = /^[a-fA-F0-9-]{16,64}$/.test(value) ? value.toLowerCase() : null;
  } catch {
    cachedBootId = null;
  }
  return cachedBootId;
}

function getProcessStartTicks(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    const value = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const commandEnd = value.lastIndexOf(")");
    if (commandEnd < 0) return null;
    const fields = value.slice(commandEnd + 1).trim().split(/\s+/);
    const startTicks = fields[19];
    return /^\d{1,32}$/.test(startTicks || "") ? startTicks : null;
  } catch {
    return null;
  }
}

function createQueueLockRecord(ownerId) {
  return {
    version: 1,
    pid: process.pid,
    ownerId,
    createdAt: Date.now(),
    bootId: getBootId(),
    processStartTicks: getProcessStartTicks(process.pid),
  };
}

function parseQueueLockRecord(content, expectedOwnerId = null) {
  if (typeof content !== "string" || Buffer.byteLength(content) > QUEUE_LOCK_RECORD_MAX_BYTES) {
    return null;
  }
  let record;
  try {
    record = JSON.parse(content);
  } catch {
    return null;
  }
  if (!record || Array.isArray(record) || typeof record !== "object") return null;
  const keys = Object.keys(record).sort();
  const expectedKeys = [
    "bootId",
    "createdAt",
    "ownerId",
    "pid",
    "processStartTicks",
    "version",
  ];
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
    return null;
  }
  if (record.version !== 1
    || !Number.isSafeInteger(record.pid) || record.pid <= 0 || record.pid > 2_147_483_647
    || !LOCK_OWNER_ID_PATTERN.test(record.ownerId || "")
    || (expectedOwnerId && record.ownerId !== expectedOwnerId)
    || !Number.isSafeInteger(record.createdAt) || record.createdAt <= 0
    || (record.bootId !== null && !/^[a-fA-F0-9-]{16,64}$/.test(record.bootId))
    || (record.processStartTicks !== null && !/^\d{1,32}$/.test(record.processStartTicks))) {
    return null;
  }
  return record;
}

function readBoundedLockFile(filePath, expectedOwnerId = null) {
  let pathStat;
  try {
    pathStat = fs.lstatSync(filePath);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw queueLockError("queue_lock_failed", "queue lock 상태를 확인하지 못했습니다.");
  }
  if (!pathStat.isFile() || pathStat.isSymbolicLink()
    || pathStat.size > QUEUE_LOCK_RECORD_MAX_BYTES
    || (pathStat.mode & 0o077) !== 0) {
    throw queueLockError("invalid_lock_path", "queue lock 소유자 파일이 안전하지 않습니다.");
  }

  const noFollow = fs.constants.O_NOFOLLOW || 0;
  let descriptor;
  try {
    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw queueLockError("invalid_lock_path", "queue lock 소유자 파일을 열 수 없습니다.");
  }
  try {
    const descriptorStat = fs.fstatSync(descriptor);
    if (!descriptorStat.isFile() || !sameInode(pathStat, descriptorStat)
      || descriptorStat.size > QUEUE_LOCK_RECORD_MAX_BYTES) {
      return null;
    }
    const buffer = Buffer.alloc(descriptorStat.size);
    let offset = 0;
    while (offset < buffer.length) {
      const bytesRead = fs.readSync(descriptor, buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return {
      stat: descriptorStat,
      record: parseQueueLockRecord(buffer.subarray(0, offset).toString("utf8"), expectedOwnerId),
    };
  } finally {
    try {
      fs.closeSync(descriptor);
    } catch {}
  }
}

function inspectQueueLockDirectory(lockPath) {
  let directoryStat;
  try {
    directoryStat = fs.lstatSync(lockPath);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw queueLockError("queue_lock_failed", "queue lock 상태를 확인하지 못했습니다.");
  }
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()
    || (directoryStat.mode & 0o077) !== 0) {
    throw queueLockError("invalid_lock_path", "queue lock 경로가 안전하지 않습니다.");
  }

  let names;
  try {
    names = fs.readdirSync(lockPath).sort();
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw queueLockError("queue_lock_failed", "queue lock 상태를 읽지 못했습니다.");
  }
  const ownerNames = names.filter(name => LOCK_OWNER_FILE_PATTERN.test(name));
  const unexpectedNames = names.filter(name => name !== ".reaper" && !LOCK_OWNER_FILE_PATTERN.test(name));
  if (ownerNames.length > 1 || unexpectedNames.length > 0) {
    throw queueLockError("invalid_lock_path", "queue lock 내부 구조가 안전하지 않습니다.");
  }

  const ownerName = ownerNames[0] || null;
  const ownerId = ownerName ? LOCK_OWNER_FILE_PATTERN.exec(ownerName)[1] : null;
  const owner = ownerName
    ? readBoundedLockFile(path.join(lockPath, ownerName), ownerId)
    : null;
  const reaper = names.includes(".reaper")
    ? readBoundedLockFile(path.join(lockPath, ".reaper"))
    : null;
  if ((ownerName && !owner) || (names.includes(".reaper") && !reaper)) {
    return { directoryStat, unstable: true, ownerName, owner, reaper };
  }

  let finalStat;
  try {
    finalStat = fs.lstatSync(lockPath);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw queueLockError("queue_lock_failed", "queue lock 상태를 확인하지 못했습니다.");
  }
  if (!sameInode(directoryStat, finalStat)) return null;
  return { directoryStat: finalStat, unstable: false, ownerName, owner, reaper };
}

function processOwnerIsDead(record) {
  const currentBootId = getBootId();
  if (record.bootId && currentBootId && record.bootId !== currentBootId) return true;
  const currentStartTicks = getProcessStartTicks(record.pid);
  if (record.processStartTicks && currentStartTicks
    && record.processStartTicks !== currentStartTicks) return true;
  try {
    process.kill(record.pid, 0);
    return false;
  } catch (error) {
    return error.code === "ESRCH";
  }
}

function lockEntryTimestamp(directoryStat, entry) {
  if (!entry) return directoryStat.mtimeMs || 0;
  return Math.max(entry.stat?.mtimeMs || 0, entry.record?.createdAt || 0);
}

function lockEntryIsRecoverable(inspection, entry, staleMs) {
  if (entry?.record) return processOwnerIsDead(entry.record);
  return Date.now() - lockEntryTimestamp(inspection.directoryStat, entry) >= staleMs;
}

function writeAll(descriptor, buffer) {
  let offset = 0;
  while (offset < buffer.byteLength) {
    const written = fs.writeSync(descriptor, buffer, offset, buffer.byteLength - offset);
    if (written <= 0) throw queueLockError("queue_lock_failed", "queue lock을 기록하지 못했습니다.");
    offset += written;
  }
}

function createLockRecordFile(filePath, ownerId) {
  const noFollow = fs.constants.O_NOFOLLOW || 0;
  let descriptor = null;
  let descriptorStat = null;
  const record = createQueueLockRecord(ownerId);
  const payload = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
  try {
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow,
      0o600,
    );
    fs.fchmodSync(descriptor, 0o600);
    writeAll(descriptor, payload);
    fs.fsyncSync(descriptor);
    descriptorStat = fs.fstatSync(descriptor);
    return { descriptor, stat: descriptorStat, record };
  } catch (error) {
    if (descriptor !== null) {
      try {
        descriptorStat ||= fs.fstatSync(descriptor);
        const pathStat = fs.lstatSync(filePath);
        if (sameInode(descriptorStat, pathStat)) fs.unlinkSync(filePath);
      } catch {}
      try {
        fs.closeSync(descriptor);
      } catch {}
    }
    if (error?.code === "EEXIST") return null;
    if (error instanceof SamgukObservationError) throw error;
    throw queueLockError("queue_lock_failed", "queue lock을 만들지 못했습니다.");
  }
}

function closeLockDescriptor(recordFile) {
  if (!recordFile || recordFile.descriptor === null) return;
  try {
    fs.closeSync(recordFile.descriptor);
  } catch {}
  recordFile.descriptor = null;
}

function sameLockOwner(left, right) {
  if (!left || !right) return left === right;
  if (!sameInode(left.stat, right.stat)) return false;
  if (!left.record || !right.record) return left.record === right.record;
  return left.record.ownerId === right.record.ownerId
    && left.record.pid === right.record.pid
    && left.record.processStartTicks === right.record.processStartTicks
    && left.record.bootId === right.record.bootId;
}

function removeOwnedRecordFile(filePath, expected) {
  const current = readBoundedLockFile(filePath, expected.record?.ownerId || null);
  if (!sameLockOwner(expected, current)) return false;
  try {
    fs.unlinkSync(filePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw queueLockError("queue_lock_failed", "queue lock 파일을 정리하지 못했습니다.");
  }
}

function recoverQueueLock(lockPath, inspection, staleMs) {
  if (!inspection || inspection.unstable) return false;

  if (inspection.reaper) {
    if (!lockEntryIsRecoverable(inspection, inspection.reaper, staleMs)) return false;
    return removeOwnedRecordFile(path.join(lockPath, ".reaper"), inspection.reaper);
  }

  const ownerEntry = inspection.owner || null;
  if (!lockEntryIsRecoverable(inspection, ownerEntry, staleMs)) return false;

  const reaperId = crypto.randomBytes(16).toString("hex");
  const reaper = createLockRecordFile(path.join(lockPath, ".reaper"), reaperId);
  if (!reaper) return false;
  let quarantinePath = null;
  try {
    const current = inspectQueueLockDirectory(lockPath);
    if (!current || current.unstable
      || !sameInode(inspection.directoryStat, current.directoryStat)
      || current.ownerName !== inspection.ownerName
      || !sameLockOwner(inspection.owner, current.owner)
      || !sameLockOwner(reaper, current.reaper)) {
      removeOwnedRecordFile(path.join(lockPath, ".reaper"), reaper);
      return false;
    }

    quarantinePath = `${lockPath}.stale-${crypto.randomBytes(12).toString("hex")}`;
    fs.renameSync(lockPath, quarantinePath);
    const quarantined = inspectQueueLockDirectory(quarantinePath);
    if (!quarantined || !sameInode(inspection.directoryStat, quarantined.directoryStat)
      || quarantined.ownerName !== inspection.ownerName
      || !sameLockOwner(inspection.owner, quarantined.owner)
      || !sameLockOwner(reaper, quarantined.reaper)) {
      throw queueLockError("queue_lock_failed", "stale queue lock 소유권을 확인하지 못했습니다.");
    }

    if (quarantined.ownerName
      && !removeOwnedRecordFile(path.join(quarantinePath, quarantined.ownerName), quarantined.owner)) {
      throw queueLockError("queue_lock_failed", "stale queue lock을 정리하지 못했습니다.");
    }
    if (!removeOwnedRecordFile(path.join(quarantinePath, ".reaper"), reaper)) {
      throw queueLockError("queue_lock_failed", "stale queue lock을 정리하지 못했습니다.");
    }
    fs.rmdirSync(quarantinePath);
    quarantinePath = null;
    return true;
  } catch (error) {
    if (error instanceof SamgukObservationError) throw error;
    throw queueLockError("queue_lock_failed", "stale queue lock을 복구하지 못했습니다.");
  } finally {
    closeLockDescriptor(reaper);
  }
}

function tryCreateQueueLock(resolved) {
  const lockPath = `${resolved}.lock`;
  let directoryStat;
  try {
    fs.mkdirSync(lockPath, { mode: 0o700 });
    fs.chmodSync(lockPath, 0o700);
    directoryStat = fs.lstatSync(lockPath);
  } catch (error) {
    if (error.code === "EEXIST") return null;
    throw queueLockError("queue_lock_failed", "queue lock을 만들지 못했습니다.");
  }

  let ownerId;
  let ownerName;
  let owner;
  try {
    ownerId = crypto.randomBytes(16).toString("hex");
    ownerName = `owner-${ownerId}.json`;
    owner = createLockRecordFile(path.join(lockPath, ownerName), ownerId);
    if (!owner) throw queueLockError("queue_lock_failed", "queue lock 소유자를 만들지 못했습니다.");
    const current = inspectQueueLockDirectory(lockPath);
    if (!current || current.unstable || current.reaper
      || !sameInode(directoryStat, current.directoryStat)
      || current.ownerName !== ownerName
      || !sameLockOwner(owner, current.owner)) {
      closeLockDescriptor(owner);
      try {
        const currentDirectory = fs.lstatSync(lockPath);
        if (sameInode(directoryStat, currentDirectory)) {
          removeOwnedRecordFile(path.join(lockPath, ownerName), owner);
          fs.rmdirSync(lockPath);
        }
      } catch {}
      return null;
    }
    return { resolved, lockPath, directoryStat, ownerName, owner };
  } catch (error) {
    if (owner) closeLockDescriptor(owner);
    try {
      const current = fs.lstatSync(lockPath);
      if (sameInode(directoryStat, current)) {
        if (owner) removeOwnedRecordFile(path.join(lockPath, ownerName), owner);
        fs.rmdirSync(lockPath);
      }
    } catch {}
    if (error instanceof SamgukObservationError) throw error;
    throw queueLockError("queue_lock_failed", "queue lock을 만들지 못했습니다.");
  }
}

// Local single-host mutex. Atomic mkdir serializes queue writers, while the
// per-owner token and process generation prevent an old owner from releasing a
// replacement lock after stale-lock recovery.
function acquireQueueLockState(filePath, options = {}) {
  const resolved = prepareQueueLockTarget(filePath);
  const { timeoutMs, staleMs } = normalizeQueueLockOptions(options);
  const deadline = monotonicMilliseconds() + timeoutMs;
  const lockPath = `${resolved}.lock`;

  while (true) {
    const state = tryCreateQueueLock(resolved);
    if (state) return state;
    const inspection = inspectQueueLockDirectory(lockPath);
    if (!inspection || recoverQueueLock(lockPath, inspection, staleMs)) continue;
    const remaining = deadline - monotonicMilliseconds();
    if (remaining <= 0) {
      throw queueLockError("queue_lock_timeout", "queue lock 대기 시간이 초과되었습니다.");
    }
    waitSynchronously(Math.min(QUEUE_LOCK_RETRY_MS, remaining));
  }
}

function releaseQueueLockState(state) {
  let releaseError = null;
  try {
    const current = inspectQueueLockDirectory(state.lockPath);
    if (!current || current.unstable || current.reaper
      || !sameInode(state.directoryStat, current.directoryStat)
      || current.ownerName !== state.ownerName
      || !sameLockOwner(state.owner, current.owner)) {
      throw queueLockError("queue_lock_owner_mismatch", "queue lock 소유권이 변경되었습니다.");
    }
    if (!removeOwnedRecordFile(path.join(state.lockPath, state.ownerName), state.owner)) {
      throw queueLockError("queue_lock_owner_mismatch", "queue lock 소유권이 변경되었습니다.");
    }
    fs.rmdirSync(state.lockPath);
  } catch (error) {
    releaseError = error instanceof SamgukObservationError
      ? error
      : queueLockError("queue_lock_release_failed", "queue lock을 해제하지 못했습니다.");
  } finally {
    closeLockDescriptor(state.owner);
  }
  if (releaseError) throw releaseError;
}

function acquireObservationQueueLock(filePath, options = {}) {
  const state = acquireQueueLockState(filePath, options);
  let released = false;
  return Object.freeze({
    release() {
      if (released) return false;
      released = true;
      releaseQueueLockState(state);
      return true;
    },
  });
}

function withObservationQueueLock(filePath, operation, options = {}) {
  const state = acquireQueueLockState(filePath, options);
  let result;
  let operationError = null;
  try {
    result = operation(state.resolved);
  } catch (error) {
    operationError = error;
  }
  let releaseError = null;
  try {
    releaseQueueLockState(state);
  } catch (error) {
    releaseError = error;
  }
  if (operationError) throw operationError;
  if (releaseError) throw releaseError;
  return result;
}

function readObservationQueue(filePath, { maxBytes = DEFAULT_QUEUE_MAX_BYTES } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    fail("invalid_schema", "maxBytes는 0 이상의 안전한 정수여야 합니다.");
  }
  const resolved = ensureQueuePath(filePath);
  const noFollow = fs.constants.O_NOFOLLOW || 0;
  let descriptor;
  try {
    descriptor = fs.openSync(resolved, fs.constants.O_RDONLY | noFollow);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    if (error.code === "ELOOP") fail("invalid_path", "queue는 일반 파일이어야 합니다.");
    throw error;
  }
  let content;
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) fail("invalid_path", "queue는 일반 파일이어야 합니다.");
    if (stat.size > maxBytes) fail("queue_too_large", `queue가 ${maxBytes}바이트 제한을 넘었습니다.`);
    const buffer = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < buffer.length) {
      const bytesRead = fs.readSync(descriptor, buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    content = buffer.subarray(0, offset).toString("utf8");
  } finally {
    fs.closeSync(descriptor);
  }
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

function appendObservationQueueUnlocked(filePath, inputs, {
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
    rewriteObservationQueueUnlocked(resolved, [...existing, ...inserted], { maxBytes, now });
  }

  return {
    inserted,
    duplicates,
    all: [...existing, ...inserted],
  };
}

function appendObservationQueue(filePath, inputs, options = {}) {
  const batch = Array.isArray(inputs) ? inputs : [inputs];
  if (batch.length === 0) fail("invalid_schema", "추가할 관측값이 없습니다.");
  if (batch.length > MAX_BATCH_SIZE) {
    fail("batch_too_large", `한 번에 ${MAX_BATCH_SIZE}건까지만 추가할 수 있습니다.`);
  }
  return withObservationQueueLock(
    filePath,
    resolved => appendObservationQueueUnlocked(resolved, batch, options),
    options,
  );
}

function rewriteObservationQueueUnlocked(filePath, inputs, {
  maxBytes = DEFAULT_QUEUE_MAX_BYTES,
  now = Date.now(),
} = {}) {
  if (!Array.isArray(inputs)) fail("invalid_schema", "관측 목록은 배열이어야 합니다.");
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    fail("invalid_schema", "maxBytes는 0 이상의 안전한 정수여야 합니다.");
  }

  const observations = dedupeObservations(inputs, { now });
  const lines = observations.map((observation) => `${JSON.stringify(observation)}\n`);
  for (const line of lines) {
    if (Buffer.byteLength(line) > DEFAULT_LINE_MAX_BYTES) {
      fail("line_too_large", `관측 한 건은 ${DEFAULT_LINE_MAX_BYTES}바이트를 넘을 수 없습니다.`);
    }
  }
  const payload = Buffer.from(lines.join(""), "utf8");
  if (payload.byteLength > maxBytes) {
    fail("queue_too_large", `queue가 ${maxBytes}바이트 제한을 넘습니다.`);
  }

  const resolved = ensureQueuePath(filePath);
  const directory = path.dirname(resolved);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = path.join(
    directory,
    `.${path.basename(resolved)}.${process.pid}.${crypto.randomBytes(12).toString("hex")}.tmp`,
  );
  const noFollow = fs.constants.O_NOFOLLOW || 0;
  let descriptor = null;
  let directoryDescriptor = null;
  let renamed = false;

  try {
    descriptor = fs.openSync(
      temporaryPath,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        noFollow,
      0o600,
    );
    fs.fchmodSync(descriptor, 0o600);

    let offset = 0;
    while (offset < payload.byteLength) {
      const written = fs.writeSync(
        descriptor,
        payload,
        offset,
        payload.byteLength - offset,
      );
      if (written <= 0) fail("queue_write_failed", "queue 임시 파일을 쓰지 못했습니다.");
      offset += written;
    }
    fs.fsyncSync(descriptor);
    try {
      fs.closeSync(descriptor);
    } finally {
      descriptor = null;
    }

    // Destination checks happen again immediately before replacement. rename
    // then swaps the complete file atomically without ever exposing a partial
    // JSONL queue.
    ensureQueuePath(resolved);
    fs.renameSync(temporaryPath, resolved);
    renamed = true;

    directoryDescriptor = fs.openSync(
      directory,
      fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0),
    );
    fs.fsyncSync(directoryDescriptor);
    try {
      fs.closeSync(directoryDescriptor);
    } finally {
      directoryDescriptor = null;
    }
  } finally {
    if (descriptor !== null) {
      try {
        fs.closeSync(descriptor);
      } catch {}
    }
    if (directoryDescriptor !== null) {
      try {
        fs.closeSync(directoryDescriptor);
      } catch {}
    }
    if (!renamed) {
      try {
        fs.unlinkSync(temporaryPath);
      } catch {}
    }
  }

  return {
    written: observations.length,
    bytes: payload.byteLength,
  };
}

function rewriteObservationQueue(filePath, inputs, options = {}) {
  return withObservationQueueLock(
    filePath,
    resolved => rewriteObservationQueueUnlocked(resolved, inputs, options),
    options,
  );
}

function compactObservationQueue(filePath, transformFn, options = {}) {
  if (typeof transformFn !== "function") {
    fail("invalid_schema", "queue transformFn은 함수여야 합니다.");
  }
  return withObservationQueueLock(filePath, (resolved) => {
    const current = readObservationQueue(resolved, {
      maxBytes: options.maxBytes ?? DEFAULT_QUEUE_MAX_BYTES,
    });
    const replacement = transformFn(current.map(observation => ({ ...observation })));
    if (replacement && (typeof replacement === "object" || typeof replacement === "function")
      && typeof replacement.then === "function") {
      fail("invalid_schema", "queue transformFn은 동기 배열을 반환해야 합니다.");
    }
    if (!Array.isArray(replacement)) {
      fail("invalid_schema", "queue transformFn은 관측 배열을 반환해야 합니다.");
    }
    const rewritten = rewriteObservationQueueUnlocked(resolved, replacement, options);
    return {
      scanned: current.length,
      written: rewritten.written,
      bytes: rewritten.bytes,
    };
  }, options);
}

module.exports = {
  ALLOWED_FIELDS,
  DEFAULT_CONSENSUS_WINDOW_MS,
  DEFAULT_LINE_MAX_BYTES,
  DEFAULT_QUEUE_MAX_BYTES,
  DEFAULT_QUEUE_LOCK_STALE_MS,
  DEFAULT_QUEUE_LOCK_TIMEOUT_MS,
  MIN_BROADCAST_CONFIDENCE,
  MAX_OBSERVATION_FUTURE_SKEW_MS,
  NUMERIC_FIELD_MAXIMUMS,
  PLAYER_ID_PATTERN,
  SOURCE_TYPES,
  SamgukObservationError,
  acceptSheetBaseline,
  acquireObservationQueueLock,
  appendObservationQueue,
  broadcastEvidenceUnitId,
  compactObservationQueue,
  dedupeObservations,
  findAcceptedConsensus,
  normalizeObservation,
  observationFingerprint,
  readObservationQueue,
  rewriteObservationQueue,
  resolveLatestAccepted,
  sourceHostAllowed,
};
