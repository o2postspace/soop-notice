const fs = require("node:fs");
const path = require("node:path");
const {
  DEFAULT_LINE_MAX_BYTES,
  SamgukObservationError,
  dedupeObservations,
  normalizeObservation,
  observationFingerprint,
} = require("./samguk-observations");

const DEFAULT_PROMOTION_AUDIT_SEGMENT_MAX_BYTES = 10 * 1024 * 1024;
const MAX_PROMOTION_AUDIT_SEGMENT_BYTES = 1024 * 1024 * 1024;
// Queue 전체(기본 최대 10MiB)를 한 번에 compact할 수 있어야 하므로 queue의
// 단일 append batch 한도(1,000)를 audit에 재사용하지 않는다.
const MAX_PROMOTION_AUDIT_BATCH_SIZE = 50_000;
const SEGMENT_NUMBER_WIDTH = 6;

function fail(code, message) {
  throw new SamgukObservationError(code, message);
}

function sameInode(left, right) {
  return Boolean(left && right && left.dev === right.dev && left.ino === right.ino);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeSegmentMaxBytes(value = DEFAULT_PROMOTION_AUDIT_SEGMENT_MAX_BYTES) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > MAX_PROMOTION_AUDIT_SEGMENT_BYTES) {
    fail(
      "invalid_schema",
      `promotion audit segment 크기는 1~${MAX_PROMOTION_AUDIT_SEGMENT_BYTES} 범위의 정수여야 합니다.`,
    );
  }
  return parsed;
}

function prepareAuditPath(filePath) {
  if (typeof filePath !== "string" || !filePath.trim() || !path.isAbsolute(filePath)) {
    fail("invalid_path", "promotion audit는 절대 경로여야 합니다.");
  }
  const resolved = path.resolve(filePath);
  const directory = path.dirname(resolved);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const directoryStat = fs.lstatSync(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    fail("invalid_path", "promotion audit 상위 경로는 일반 디렉터리여야 합니다.");
  }
  return { resolved, directory };
}

function segmentPath(resolved, index) {
  if (index === 0) return resolved;
  if (!Number.isSafeInteger(index) || index < 1 || index >= 10 ** SEGMENT_NUMBER_WIDTH) {
    fail("audit_segment_limit", "promotion audit segment 번호 한도를 넘었습니다.");
  }
  return `${resolved}.part-${String(index).padStart(SEGMENT_NUMBER_WIDTH, "0")}`;
}

function listAuditSegments(resolved, directory) {
  const basename = path.basename(resolved);
  const pattern = new RegExp(
    `^${escapeRegExp(basename)}(?:\\.part-(\\d{${SEGMENT_NUMBER_WIDTH}}))?$`,
  );
  const segments = [];
  for (const name of fs.readdirSync(directory)) {
    const match = pattern.exec(name);
    if (!match) continue;
    const index = match[1] === undefined ? 0 : Number(match[1]);
    if (match[1] !== undefined && index === 0) {
      fail("invalid_path", "promotion audit segment 번호가 올바르지 않습니다.");
    }
    const filePath = path.join(directory, name);
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      fail("invalid_path", "promotion audit segment는 일반 파일이어야 합니다.");
    }
    segments.push({ index, path: filePath, pathStat: stat });
  }
  segments.sort((left, right) => left.index - right.index);
  for (let index = 1; index < segments.length; index += 1) {
    if (segments[index - 1].index === segments[index].index) {
      fail("invalid_path", "promotion audit segment 번호가 중복되었습니다.");
    }
  }
  return segments;
}

function readExactFile(descriptor, size) {
  const buffer = Buffer.alloc(size);
  let offset = 0;
  while (offset < buffer.length) {
    const bytesRead = fs.readSync(descriptor, buffer, offset, buffer.length - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return buffer.subarray(0, offset);
}

function parseAuditLine(buffer, segment, lineNumber, { allowPartial = false } = {}) {
  if (buffer.byteLength > DEFAULT_LINE_MAX_BYTES) {
    fail("audit_corrupt", `promotion audit ${path.basename(segment.path)} ${lineNumber}행이 너무 큽니다.`);
  }
  if (buffer.byteLength === 0) return { observation: null, partial: false };
  let parsed;
  try {
    parsed = JSON.parse(buffer.toString("utf8"));
  } catch {
    if (allowPartial) return { observation: null, partial: true };
    fail("audit_corrupt", `promotion audit ${path.basename(segment.path)} ${lineNumber}행 JSON이 올바르지 않습니다.`);
  }
  try {
    return { observation: normalizeObservation(parsed), partial: allowPartial };
  } catch (error) {
    if (allowPartial && error instanceof SamgukObservationError) {
      return { observation: null, partial: true };
    }
    if (error instanceof SamgukObservationError) {
      fail(
        "audit_corrupt",
        `promotion audit ${path.basename(segment.path)} ${lineNumber}행이 올바르지 않습니다: ${error.message}`,
      );
    }
    throw error;
  }
}

function readAuditSegment(segment, segmentMaxBytes) {
  const noFollow = fs.constants.O_NOFOLLOW || 0;
  let descriptor;
  try {
    descriptor = fs.openSync(segment.path, fs.constants.O_RDONLY | noFollow);
  } catch (error) {
    if (error.code === "ELOOP") fail("invalid_path", "promotion audit segment는 일반 파일이어야 합니다.");
    throw error;
  }
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || !sameInode(segment.pathStat, stat)) {
      fail("invalid_path", "promotion audit segment가 읽는 중 변경되었습니다.");
    }
    fs.fchmodSync(descriptor, 0o600);
    if (stat.size > segmentMaxBytes) {
      fail(
        "audit_segment_too_large",
        `promotion audit segment가 ${segmentMaxBytes}바이트 제한을 넘었습니다.`,
      );
    }
    const content = readExactFile(descriptor, stat.size);
    const observations = [];
    let lineStart = 0;
    let lineNumber = 0;
    for (let offset = 0; offset < content.length; offset += 1) {
      if (content[offset] !== 0x0a) continue;
      lineNumber += 1;
      const parsed = parseAuditLine(content.subarray(lineStart, offset), segment, lineNumber);
      if (parsed.observation) observations.push(parsed.observation);
      lineStart = offset + 1;
    }
    let sealed = false;
    let trailingPartialBytes = 0;
    if (lineStart < content.length) {
      lineNumber += 1;
      const tail = content.subarray(lineStart);
      const parsed = parseAuditLine(tail, segment, lineNumber, { allowPartial: true });
      if (parsed.observation) observations.push(parsed.observation);
      else trailingPartialBytes = tail.byteLength;
      sealed = true;
    }
    return {
      ...segment,
      observations,
      sealed,
      size: stat.size,
      trailingPartialBytes,
    };
  } finally {
    fs.closeSync(descriptor);
  }
}

function scanPromotionAudit(filePath, options = {}) {
  const segmentMaxBytes = normalizeSegmentMaxBytes(options.segmentMaxBytes);
  const { resolved, directory } = prepareAuditPath(filePath);
  const segments = listAuditSegments(resolved, directory)
    .map(segment => readAuditSegment(segment, segmentMaxBytes));
  const observations = [];
  const fingerprints = new Set();
  const ids = new Map();
  for (const segment of segments) {
    for (const observation of segment.observations) {
      const fingerprint = observationFingerprint(observation);
      const priorFingerprint = ids.get(observation.observationId);
      if (priorFingerprint && priorFingerprint !== fingerprint) {
        fail(
          "observation_id_conflict",
          `observationId '${observation.observationId}'의 audit 내용이 서로 다릅니다.`,
        );
      }
      ids.set(observation.observationId, fingerprint);
      if (fingerprints.has(fingerprint)) continue;
      fingerprints.add(fingerprint);
      observations.push(observation);
    }
  }
  return { directory, fingerprints, ids, observations, resolved, segmentMaxBytes, segments };
}

function writeAllAppend(descriptor, buffer) {
  let offset = 0;
  while (offset < buffer.byteLength) {
    const written = fs.writeSync(descriptor, buffer, offset, buffer.byteLength - offset, null);
    if (written <= 0) fail("audit_write_failed", "promotion audit를 기록하지 못했습니다.");
    offset += written;
  }
}

function openExistingSegment(segment) {
  const noFollow = fs.constants.O_NOFOLLOW || 0;
  let descriptor;
  try {
    descriptor = fs.openSync(segment.path, fs.constants.O_WRONLY | fs.constants.O_APPEND | noFollow);
  } catch (error) {
    if (error.code === "ELOOP") fail("invalid_path", "promotion audit segment는 일반 파일이어야 합니다.");
    throw error;
  }
  const stat = fs.fstatSync(descriptor);
  if (!stat.isFile() || !sameInode(segment.pathStat, stat) || stat.size !== segment.size) {
    fs.closeSync(descriptor);
    fail("audit_changed", "promotion audit segment가 기록 전에 변경되었습니다.");
  }
  fs.fchmodSync(descriptor, 0o600);
  return { created: false, descriptor, index: segment.index, path: segment.path, size: stat.size };
}

function createSegment(resolved, index) {
  const filePath = segmentPath(resolved, index);
  const noFollow = fs.constants.O_NOFOLLOW || 0;
  let descriptor;
  try {
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow,
      0o600,
    );
  } catch (error) {
    if (error.code === "EEXIST" || error.code === "ELOOP") {
      fail("invalid_path", "새 promotion audit segment 경로를 안전하게 만들 수 없습니다.");
    }
    throw error;
  }
  const stat = fs.fstatSync(descriptor);
  if (!stat.isFile()) {
    fs.closeSync(descriptor);
    fail("invalid_path", "promotion audit segment는 일반 파일이어야 합니다.");
  }
  fs.fchmodSync(descriptor, 0o600);
  return { created: true, descriptor, index, path: filePath, size: 0 };
}

function closeSegment(segment, { sync = false } = {}) {
  if (!segment) return;
  try {
    if (sync) fs.fsyncSync(segment.descriptor);
  } finally {
    fs.closeSync(segment.descriptor);
  }
}

function fsyncDirectory(directory) {
  const descriptor = fs.openSync(
    directory,
    fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0),
  );
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function appendPromotionAudit(filePath, inputs, options = {}) {
  const batch = Array.isArray(inputs) ? inputs : [inputs];
  if (batch.length === 0) fail("invalid_schema", "추가할 promotion audit 관측값이 없습니다.");
  if (batch.length > MAX_PROMOTION_AUDIT_BATCH_SIZE) {
    fail(
      "batch_too_large",
      `한 번에 ${MAX_PROMOTION_AUDIT_BATCH_SIZE}건까지만 promotion audit에 추가할 수 있습니다.`,
    );
  }
  const normalized = dedupeObservations(batch, { now: options.now ?? Date.now() });
  const scan = scanPromotionAudit(filePath, options);
  const inserted = [];
  const duplicates = [];
  const pending = [];

  for (const observation of normalized) {
    const fingerprint = observationFingerprint(observation);
    const priorFingerprint = scan.ids.get(observation.observationId);
    if (priorFingerprint && priorFingerprint !== fingerprint) {
      fail(
        "observation_id_conflict",
        `observationId '${observation.observationId}'가 기존 audit 내용과 다릅니다.`,
      );
    }
    if (scan.fingerprints.has(fingerprint)) {
      duplicates.push(observation);
      continue;
    }
    const line = Buffer.from(`${JSON.stringify(observation)}\n`, "utf8");
    if (line.byteLength > DEFAULT_LINE_MAX_BYTES) {
      fail("line_too_large", `promotion audit 한 건은 ${DEFAULT_LINE_MAX_BYTES}바이트를 넘을 수 없습니다.`);
    }
    if (line.byteLength > scan.segmentMaxBytes) {
      fail("audit_line_too_large", "관측 한 건이 promotion audit segment 크기보다 큽니다.");
    }
    scan.fingerprints.add(fingerprint);
    scan.ids.set(observation.observationId, fingerprint);
    pending.push({ line, observation });
  }

  if (pending.length === 0) {
    return { bytes: 0, duplicates, inserted, segmentPaths: scan.segments.map(segment => segment.path) };
  }

  const latest = scan.segments.at(-1);
  let current = null;
  let nextIndex = latest ? latest.index + 1 : 0;
  let createdSegment = false;
  let bytes = 0;
  try {
    if (latest && !latest.sealed) current = openExistingSegment(latest);
    for (const entry of pending) {
      if (!current || current.size + entry.line.byteLength > scan.segmentMaxBytes) {
        if (current) {
          closeSegment(current, { sync: true });
          current = null;
        }
        current = createSegment(scan.resolved, nextIndex);
        createdSegment = true;
        nextIndex += 1;
      }
      writeAllAppend(current.descriptor, entry.line);
      current.size += entry.line.byteLength;
      bytes += entry.line.byteLength;
      inserted.push(entry.observation);
    }
    closeSegment(current, { sync: true });
    current = null;
    if (createdSegment) fsyncDirectory(scan.directory);
  } catch (error) {
    if (current) {
      try {
        closeSegment(current, { sync: true });
      } catch {}
    }
    throw error;
  }

  return {
    bytes,
    duplicates,
    inserted,
    segmentPaths: listAuditSegments(scan.resolved, scan.directory).map(segment => segment.path),
  };
}

function readPromotionAudit(filePath, options = {}) {
  return scanPromotionAudit(filePath, options).observations;
}

module.exports = {
  DEFAULT_PROMOTION_AUDIT_SEGMENT_MAX_BYTES,
  MAX_PROMOTION_AUDIT_BATCH_SIZE,
  appendPromotionAudit,
  readPromotionAudit,
};
