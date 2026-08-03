"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const PLAYER_ID_PATTERN = /^P\d{3}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const ARCHIVE_REF_PATTERN = /^P\d{3}-\d{13}-q\d+-s[0-7]-[a-f0-9]{16}\.png$/;
const DEFAULT_RETENTION_MS = 30 * 60_000;
// 현재 후보 발생량(분당 약 70장)에서도 30분 보존시간이 파일 상한보다
// 먼저 적용되도록 잡는다. 실제 PNG는 대개 1MiB 미만이다.
const DEFAULT_MAX_FILES = 2_560;
const MAX_PNG_BYTES = 16 * 1024 * 1024;

class SamgukCandidateFrameArchiveError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SamgukCandidateFrameArchiveError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new SamgukCandidateFrameArchiveError(code, message);
}

function integerInRange(value, fallback, min, max, label) {
  const candidate = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(candidate) || candidate < min || candidate > max) {
    fail("invalid_config", `${label} 범위를 확인하세요.`);
  }
  return candidate;
}

function safeDirectory(value) {
  if (typeof value !== "string" || !path.isAbsolute(value) || value.includes("\u0000")) {
    fail("invalid_config", "stateDir은 절대경로여야 합니다.");
  }
  return path.resolve(value);
}

function validatePng(value) {
  if (!Buffer.isBuffer(value) || value.length < PNG_SIGNATURE.length
    || value.length > MAX_PNG_BYTES
    || !value.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    fail("invalid_png", "후보 frame이 PNG 형식이 아닙니다.");
  }
  return value;
}

function validateContext(input, png, now) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    fail("invalid_context", "후보 frame context가 필요합니다.");
  }
  const allowed = new Set([
    "playerId", "targetId", "observedAtMs", "mediaSequence", "sampleIndex", "evidenceHash",
  ]);
  if (Object.keys(input).some(key => !allowed.has(key))
    || !PLAYER_ID_PATTERN.test(input.playerId)
    || input.targetId !== input.playerId
    || !Number.isSafeInteger(input.observedAtMs)
    || input.observedAtMs < Date.UTC(2000, 0, 1)
    || input.observedAtMs > now + 5 * 60_000
    || !Number.isSafeInteger(input.mediaSequence) || input.mediaSequence < 0
    || !Number.isSafeInteger(input.sampleIndex) || input.sampleIndex < 0 || input.sampleIndex > 7
    || typeof input.evidenceHash !== "string" || !HASH_PATTERN.test(input.evidenceHash)) {
    fail("invalid_context", "후보 frame context 형식이 올바르지 않습니다.");
  }
  const actualHash = crypto.createHash("sha256").update(png).digest("hex");
  if (actualHash !== input.evidenceHash) {
    fail("invalid_context", "후보 frame hash가 일치하지 않습니다.");
  }
  return Object.freeze({ ...input, evidenceHash: actualHash });
}

async function regularPngEntries(directory) {
  const entries = [];
  for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".png")) continue;
    const filePath = path.join(directory, entry.name);
    const stat = await fs.promises.lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) continue;
    entries.push({ fileName: entry.name, filePath, mtimeMs: stat.mtimeMs });
  }
  return entries;
}

function createCandidateFrameArchive(options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    fail("invalid_config", "후보 frame archive 설정이 필요합니다.");
  }
  const allowed = new Set(["stateDir", "retentionMs", "maxFiles", "clock"]);
  if (Object.keys(options).some(key => !allowed.has(key))) {
    fail("invalid_config", "후보 frame archive에 알 수 없는 설정이 있습니다.");
  }
  const stateDir = safeDirectory(options.stateDir);
  const retentionMs = integerInRange(
    options.retentionMs,
    DEFAULT_RETENTION_MS,
    60_000,
    24 * 60 * 60_000,
    "retentionMs",
  );
  const maxFiles = integerInRange(options.maxFiles, DEFAULT_MAX_FILES, 1, 10_000, "maxFiles");
  const clock = options.clock || Date.now;
  if (typeof clock !== "function") fail("invalid_config", "clock은 함수여야 합니다.");
  const directory = path.join(stateDir, "candidate-frames");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const directoryStat = fs.lstatSync(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    fail("invalid_path", "후보 frame archive 경로가 안전하지 않습니다.");
  }
  fs.chmodSync(directory, 0o700);
  let lastCleanupAt = 0;
  let knownFileCount = null;
  let mutation = Promise.resolve();

  function serialized(action) {
    const result = mutation.then(action, action);
    mutation = result.catch(() => {});
    return result;
  }

  async function cleanupInternal(now, force) {
    if (!Number.isSafeInteger(now) || now < 0) fail("invalid_time", "정리 시각이 올바르지 않습니다.");
    if (!force && knownFileCount !== null && now - lastCleanupAt < 60_000) return 0;
    lastCleanupAt = now;
    const entries = (await regularPngEntries(directory)).sort((left, right) => (
      left.mtimeMs - right.mtimeMs || left.filePath.localeCompare(right.filePath)
    ));
    let removed = 0;
    for (const entry of entries) {
      if (now - entry.mtimeMs < retentionMs) continue;
      await fs.promises.rm(entry.filePath, { force: true });
      removed += 1;
    }
    const remaining = entries.slice(removed);
    while (remaining.length >= maxFiles) {
      const entry = remaining.shift();
      await fs.promises.rm(entry.filePath, { force: true });
      removed += 1;
    }
    knownFileCount = remaining.length;
    return removed;
  }

  function cleanup(now = clock(), force = false) {
    return serialized(() => cleanupInternal(now, force));
  }

  function archive(png, input) {
    validatePng(png);
    const now = clock();
    const context = validateContext(input, png, now);
    const fileName = [
      context.playerId,
      context.observedAtMs,
      `q${context.mediaSequence}`,
      `s${context.sampleIndex}`,
      context.evidenceHash.slice(0, 16),
    ].join("-") + ".png";
    return serialized(async () => {
      await cleanupInternal(now, false);
      if (knownFileCount >= maxFiles) await cleanupInternal(now, true);
      const destination = path.join(directory, fileName);
      try {
        await fs.promises.access(destination, fs.constants.F_OK);
        return fileName;
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      const temporary = path.join(
        directory,
        `.tmp-${process.pid}-${crypto.randomBytes(8).toString("hex")}`,
      );
      let descriptor;
      try {
        descriptor = await fs.promises.open(temporary, "wx", 0o600);
        await descriptor.writeFile(png);
        await descriptor.sync();
        await descriptor.close();
        descriptor = undefined;
        await fs.promises.rename(temporary, destination);
        await fs.promises.chmod(destination, 0o600);
        knownFileCount += 1;
        return fileName;
      } finally {
        if (descriptor !== undefined) await descriptor.close();
        await fs.promises.rm(temporary, { force: true });
      }
    });
  }

  async function read(reference) {
    if (typeof reference !== "string" || !ARCHIVE_REF_PATTERN.test(reference)) {
      fail("invalid_reference", "후보 frame 참조 형식이 올바르지 않습니다.");
    }
    const png = await fs.promises.readFile(path.join(directory, reference));
    validatePng(png);
    const hashPrefix = reference.slice(reference.lastIndexOf("-") + 1, -4);
    const actualHash = crypto.createHash("sha256").update(png).digest("hex");
    if (!actualHash.startsWith(hashPrefix)) {
      fail("invalid_png", "보존된 후보 frame hash가 일치하지 않습니다.");
    }
    return png;
  }

  return Object.freeze({ archive, cleanup, directory, maxFiles, read, retentionMs });
}

module.exports = {
  DEFAULT_MAX_FILES,
  DEFAULT_RETENTION_MS,
  SamgukCandidateFrameArchiveError,
  createCandidateFrameArchive,
};
