#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createSamgukFfmpegFrame } = require("../lib/samguk-ffmpeg-frame");
const {
  DEFAULT_CONFIRMATION_WINDOW_MS,
} = require("../lib/samguk-broadcast-change-tracker");
const { BATCH_FIELDS } = require("../lib/samguk-broadcast-batch");
const {
  DEFAULT_SCHEDULER_OPTIONS,
  buildBaselinesFromMembers,
  buildFallbackTargets,
  createSamgukHlsMonitor,
} = require("../lib/samguk-hls-monitor");
const { createSamgukSheetService } = require("../lib/samguk-sheet");
const { createSamgukOcrCommand } = require("../lib/samguk-ocr-command");
const {
  acquireObservationQueueLock,
  readObservationQueue,
  resolveLatestAccepted,
} = require("../lib/samguk-observations");
const { createSoopHlsResolver } = require("../lib/soop-hls");
const { createSoopHlsCache } = require("../lib/soop-hls-cache");
const { createSoopHlsFrameSegmentBatchFetcher } = require("../lib/soop-hls-frame");

const MAX_CONFIG_BYTES = 64 * 1024;
const BASELINE_OBSERVED_AT = Symbol.for("soop-notice.samguk-baseline-observed-at");
const PLAYER_ID_PATTERN = /^P\d{3}$/;
const PROFILE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const DEFAULT_WORKER_MODE = "all-90";
const WORKER_MODES = Object.freeze([DEFAULT_WORKER_MODE, "single-target-dry-run"]);
const ALL_TARGET_COUNT = 90;
const ALL_TARGET_IDS = Object.freeze(Array.from(
  { length: ALL_TARGET_COUNT },
  (_value, index) => `P${String(index + 1).padStart(3, "0")}`,
));
const DEFAULT_HLS_CONFIG = Object.freeze({
  cacheTtlMs: 60_000,
  timeoutMs: 5_000,
  maxResponseBytes: 256 * 1024,
  maxSegmentBytes: 8 * 1024 * 1024,
  maxBatchBytes: 32 * 1024 * 1024,
  maxCatchupSegments: 6,
});
const DEFAULT_FFMPEG_CONFIG = Object.freeze({
  path: "/usr/bin/ffmpeg",
  timeoutMs: 8_000,
  maxInputBytes: 8 * 1024 * 1024,
  maxPngOutputBytes: 4 * 1024 * 1024,
});
const DEFAULT_OCR_CONFIG = Object.freeze({
  enabled: false,
  profileId: "stats-panel-v1",
  command: null,
  args: Object.freeze([]),
  timeoutMs: 15_000,
  maxOutputBytes: 64 * 1024,
  baselineRefreshMs: 60_000,
});

class SamgukHlsWorkerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SamgukHlsWorkerError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new SamgukHlsWorkerError(code, message);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function strictObject(input, allowed, label) {
  if (!isPlainObject(input)) fail("invalid_config", `${label}은(는) 객체여야 합니다.`);
  const unexpected = Object.keys(input).filter(key => !allowed.has(key));
  if (unexpected.length > 0) {
    fail("invalid_config", `${label}에 허용되지 않은 항목이 있습니다: ${unexpected.join(", ")}`);
  }
}

function integerInRange(value, fallback, min, max, label) {
  const candidate = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(candidate) || candidate < min || candidate > max) {
    fail("invalid_config", `${label}은(는) ${min}~${max} 정수여야 합니다.`);
  }
  return candidate;
}

function numberInRange(value, fallback, min, max, label) {
  const candidate = value === undefined ? fallback : value;
  if (typeof candidate !== "number" || !Number.isFinite(candidate)
    || candidate < min || candidate > max) {
    fail("invalid_config", `${label}은(는) ${min}~${max} 숫자여야 합니다.`);
  }
  return candidate;
}

function absolutePath(value, label) {
  if (typeof value !== "string" || !value || value.length > 4_096
    || /[\u0000-\u001F\u007F]/.test(value) || !path.isAbsolute(value)) {
    fail("invalid_config", `${label}은(는) 절대경로여야 합니다.`);
  }
  return path.normalize(value);
}

function normalizeHlsConfig(input = {}) {
  strictObject(
    input,
    new Set([
      "cacheTtlMs",
      "timeoutMs",
      "maxResponseBytes",
      "maxSegmentBytes",
      "maxBatchBytes",
      "maxCatchupSegments",
    ]),
    "hls",
  );
  return Object.freeze({
    cacheTtlMs: integerInRange(input.cacheTtlMs, DEFAULT_HLS_CONFIG.cacheTtlMs, 1, 10 * 60_000, "hls.cacheTtlMs"),
    timeoutMs: integerInRange(input.timeoutMs, DEFAULT_HLS_CONFIG.timeoutMs, 10, 30_000, "hls.timeoutMs"),
    maxResponseBytes: integerInRange(
      input.maxResponseBytes,
      DEFAULT_HLS_CONFIG.maxResponseBytes,
      128,
      4 * 1024 * 1024,
      "hls.maxResponseBytes",
    ),
    maxSegmentBytes: integerInRange(
      input.maxSegmentBytes,
      DEFAULT_HLS_CONFIG.maxSegmentBytes,
      128,
      64 * 1024 * 1024,
      "hls.maxSegmentBytes",
    ),
    maxBatchBytes: integerInRange(
      input.maxBatchBytes,
      DEFAULT_HLS_CONFIG.maxBatchBytes,
      128,
      64 * 1024 * 1024,
      "hls.maxBatchBytes",
    ),
    maxCatchupSegments: integerInRange(
      input.maxCatchupSegments,
      DEFAULT_HLS_CONFIG.maxCatchupSegments,
      1,
      12,
      "hls.maxCatchupSegments",
    ),
  });
}

function normalizeFfmpegConfig(input = {}) {
  strictObject(input, new Set(["path", "timeoutMs", "maxInputBytes", "maxPngOutputBytes"]), "ffmpeg");
  return Object.freeze({
    path: absolutePath(input.path ?? DEFAULT_FFMPEG_CONFIG.path, "ffmpeg.path"),
    timeoutMs: integerInRange(input.timeoutMs, DEFAULT_FFMPEG_CONFIG.timeoutMs, 10, 60_000, "ffmpeg.timeoutMs"),
    maxInputBytes: integerInRange(
      input.maxInputBytes,
      DEFAULT_FFMPEG_CONFIG.maxInputBytes,
      1,
      64 * 1024 * 1024,
      "ffmpeg.maxInputBytes",
    ),
    maxPngOutputBytes: integerInRange(
      input.maxPngOutputBytes,
      DEFAULT_FFMPEG_CONFIG.maxPngOutputBytes,
      64,
      16 * 1024 * 1024,
      "ffmpeg.maxPngOutputBytes",
    ),
  });
}

function normalizeSchedulerConfig(input = {}) {
  strictObject(input, new Set(Object.keys(DEFAULT_SCHEDULER_OPTIONS)), "scheduler");
  const config = {
    idleIntervalMs: integerInRange(input.idleIntervalMs, DEFAULT_SCHEDULER_OPTIONS.idleIntervalMs, 10_000, 10 * 60_000, "scheduler.idleIntervalMs"),
    liveIntervalMs: integerInRange(input.liveIntervalMs, DEFAULT_SCHEDULER_OPTIONS.liveIntervalMs, 500, 60_000, "scheduler.liveIntervalMs"),
    burstIntervalMs: integerInRange(input.burstIntervalMs, DEFAULT_SCHEDULER_OPTIONS.burstIntervalMs, 250, 10_000, "scheduler.burstIntervalMs"),
    burstDurationMs: integerInRange(input.burstDurationMs, DEFAULT_SCHEDULER_OPTIONS.burstDurationMs, 1_000, 5 * 60_000, "scheduler.burstDurationMs"),
    normalConcurrency: integerInRange(input.normalConcurrency, DEFAULT_SCHEDULER_OPTIONS.normalConcurrency, 1, 90, "scheduler.normalConcurrency"),
    burstConcurrency: integerInRange(input.burstConcurrency, DEFAULT_SCHEDULER_OPTIONS.burstConcurrency, 1, 90, "scheduler.burstConcurrency"),
    jitterRatio: numberInRange(input.jitterRatio, DEFAULT_SCHEDULER_OPTIONS.jitterRatio, 0, 0.5, "scheduler.jitterRatio"),
    backoffBaseMs: integerInRange(input.backoffBaseMs, DEFAULT_SCHEDULER_OPTIONS.backoffBaseMs, 500, 10 * 60_000, "scheduler.backoffBaseMs"),
    backoffMaxMs: integerInRange(input.backoffMaxMs, DEFAULT_SCHEDULER_OPTIONS.backoffMaxMs, 500, 30 * 60_000, "scheduler.backoffMaxMs"),
    taskLeaseMs: integerInRange(input.taskLeaseMs, DEFAULT_SCHEDULER_OPTIONS.taskLeaseMs, 1_000, 180_000, "scheduler.taskLeaseMs"),
    initialSpreadMs: integerInRange(input.initialSpreadMs, DEFAULT_SCHEDULER_OPTIONS.initialSpreadMs, 0, 60_000, "scheduler.initialSpreadMs"),
  };
  if (config.burstIntervalMs > config.liveIntervalMs || config.liveIntervalMs > config.idleIntervalMs
    || config.burstDurationMs < config.burstIntervalMs
    || config.backoffMaxMs < config.backoffBaseMs) {
    fail("invalid_config", "scheduler 주기 순서가 올바르지 않습니다.");
  }
  return Object.freeze(config);
}

function normalizeOcrConfig(input = {}) {
  strictObject(
    input,
    new Set([
      "enabled",
      "profileId",
      "command",
      "args",
      "timeoutMs",
      "maxOutputBytes",
      "baselineRefreshMs",
    ]),
    "ocr",
  );
  const enabled = input.enabled === undefined ? DEFAULT_OCR_CONFIG.enabled : input.enabled;
  if (typeof enabled !== "boolean") fail("invalid_config", "ocr.enabled는 boolean이어야 합니다.");
  const profileId = input.profileId ?? DEFAULT_OCR_CONFIG.profileId;
  if (typeof profileId !== "string" || !PROFILE_ID_PATTERN.test(profileId)) {
    fail("invalid_config", "ocr.profileId 형식이 올바르지 않습니다.");
  }
  const args = input.args === undefined ? [...DEFAULT_OCR_CONFIG.args] : input.args;
  if (!Array.isArray(args) || args.length > 40
    || args.some(arg => typeof arg !== "string" || arg.length > 512 || arg.includes("\u0000"))) {
    fail("invalid_config", "ocr.args는 최대 40개의 문자열이어야 합니다.");
  }
  let command = null;
  if (enabled) command = absolutePath(input.command, "ocr.command");
  else if (input.command !== undefined && input.command !== null) command = absolutePath(input.command, "ocr.command");
  return Object.freeze({
    enabled,
    profileId,
    command,
    args: Object.freeze([...args]),
    timeoutMs: integerInRange(input.timeoutMs, DEFAULT_OCR_CONFIG.timeoutMs, 100, 60_000, "ocr.timeoutMs"),
    maxOutputBytes: integerInRange(
      input.maxOutputBytes,
      DEFAULT_OCR_CONFIG.maxOutputBytes,
      128,
      1024 * 1024,
      "ocr.maxOutputBytes",
    ),
    baselineRefreshMs: integerInRange(
      input.baselineRefreshMs,
      DEFAULT_OCR_CONFIG.baselineRefreshMs,
      10_000,
      60 * 60_000,
      "ocr.baselineRefreshMs",
    ),
  });
}

function normalizeEnabledPlayerIds(value) {
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.length > 90) {
    fail("invalid_config", "enabledPlayerIds는 최대 90개 배열이어야 합니다.");
  }
  const normalized = value.map(item => String(item).normalize("NFKC").trim());
  if (normalized.some(item => !PLAYER_ID_PATTERN.test(item))
    || new Set(normalized).size !== normalized.length) {
    fail("invalid_config", "enabledPlayerIds 형식 또는 중복을 확인하세요.");
  }
  return Object.freeze(normalized);
}

function normalizeWorkerMode(value) {
  const mode = value === undefined ? DEFAULT_WORKER_MODE : value;
  if (typeof mode !== "string" || !WORKER_MODES.includes(mode)) {
    fail("invalid_config", `mode는 ${WORKER_MODES.join(" 또는 ")}이어야 합니다.`);
  }
  return mode;
}

function normalizeWorkerConfig(input) {
  strictObject(
    input,
    new Set(["version", "mode", "permissionConfirmed", "enabledPlayerIds", "hls", "ffmpeg", "scheduler", "ocr"]),
    "config",
  );
  if (input.version !== 2) fail("invalid_config", "config.version은 2여야 합니다.");
  if (typeof input.permissionConfirmed !== "boolean") {
    fail("invalid_config", "permissionConfirmed는 boolean이어야 합니다.");
  }
  const mode = normalizeWorkerMode(input.mode);
  const enabledPlayerIds = normalizeEnabledPlayerIds(input.enabledPlayerIds);
  if (mode === DEFAULT_WORKER_MODE
    && enabledPlayerIds !== null && enabledPlayerIds.length !== ALL_TARGET_COUNT) {
    fail("invalid_config", "all-90 mode에서는 P001~P090 전체만 활성화할 수 있습니다.");
  }
  if (mode === "single-target-dry-run"
    && (enabledPlayerIds === null || enabledPlayerIds.length !== 1)) {
    fail("invalid_config", "single-target-dry-run mode에는 enabledPlayerIds 한 개가 필요합니다.");
  }
  return Object.freeze({
    version: 2,
    mode,
    permissionConfirmed: input.permissionConfirmed,
    enabledPlayerIds,
    hls: normalizeHlsConfig(input.hls === undefined ? {} : input.hls),
    ffmpeg: normalizeFfmpegConfig(input.ffmpeg === undefined ? {} : input.ffmpeg),
    scheduler: normalizeSchedulerConfig(input.scheduler === undefined ? {} : input.scheduler),
    ocr: normalizeOcrConfig(input.ocr === undefined ? {} : input.ocr),
  });
}

function loadWorkerConfig(filePath) {
  const resolved = absolutePath(filePath, "SAMGUK_HLS_MONITOR_CONFIG");
  let stat;
  try {
    stat = fs.lstatSync(resolved);
  } catch {
    fail("invalid_config", "monitor config 파일을 읽을 수 없습니다.");
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_CONFIG_BYTES) {
    fail("invalid_config", "monitor config는 64KiB 이하 일반 파일이어야 합니다.");
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(resolved, "utf8"));
  } catch {
    fail("invalid_config", "monitor config JSON을 읽을 수 없습니다.");
  }
  return normalizeWorkerConfig(parsed);
}

function configuredTargets(config, rosterTargets = buildFallbackTargets()) {
  const rosterIds = rosterTargets.map(target => target?.playerId);
  const rosterIdSet = new Set(rosterIds);
  const hasExactAllRoster = rosterTargets.length === ALL_TARGET_COUNT
    && rosterIdSet.size === ALL_TARGET_COUNT
    && ALL_TARGET_IDS.every(playerId => rosterIdSet.has(playerId));
  const enabled = config.enabledPlayerIds === null ? null : new Set(config.enabledPlayerIds);
  if (config.mode === DEFAULT_WORKER_MODE) {
    if (!hasExactAllRoster || rosterTargets.some(target => target?.enabled === false)) {
      fail("invalid_config", "all-90 mode의 roster는 활성 P001~P090 정확히 90명이어야 합니다.");
    }
    if (enabled && (enabled.size !== ALL_TARGET_COUNT
      || ALL_TARGET_IDS.some(playerId => !enabled.has(playerId)))) {
      fail("invalid_config", "all-90 mode에서는 enabledPlayerIds 부분집합을 사용할 수 없습니다.");
    }
    return rosterTargets.map(target => Object.freeze({ ...target, enabled: true }));
  }

  if (config.mode !== "single-target-dry-run" || !enabled || enabled.size !== 1) {
    fail("invalid_config", "single-target-dry-run mode에는 target 한 개가 필요합니다.");
  }
  const unknown = [...enabled].filter(playerId => !rosterIdSet.has(playerId));
  if (unknown.length > 0) fail("invalid_config", "enabledPlayerIds에 roster에 없는 ID가 있습니다.");
  return rosterTargets.map(target => Object.freeze({
    ...target,
    enabled: enabled.has(target.playerId),
  }));
}

function assertActivationAllowed(config, targets) {
  if (!config.permissionConfirmed) {
    fail("permission_required", "방송 관측 권한을 확인한 뒤 permissionConfirmed를 true로 설정하세요.");
  }
  const enabledTargets = targets.filter(target => target.enabled);
  const targetIds = new Set(targets.map(target => target.playerId));
  if (config.mode === DEFAULT_WORKER_MODE) {
    if (targets.length !== ALL_TARGET_COUNT || targetIds.size !== ALL_TARGET_COUNT
      || ALL_TARGET_IDS.some(playerId => !targetIds.has(playerId))
      || enabledTargets.length !== ALL_TARGET_COUNT) {
      fail("invalid_config", "all-90 mode는 활성 P001~P090 정확히 90명을 요구합니다.");
    }
    return;
  }
  if (config.mode === "single-target-dry-run" && enabledTargets.length === 1) return;
  fail("no_targets", "활성화된 방송 target 구성이 mode와 일치하지 않습니다.");
}

function isWorkerEnabled(env = process.env) {
  return env.SAMGUK_HLS_MONITOR_ENABLED === "1";
}

function defaultStateDir(env = process.env) {
  const root = env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
  return path.join(root, "soop-notice", "samguk-hls-monitor");
}

function baselineKey(playerId, field) {
  return `${playerId}\u0000${field}`;
}

function normalizedObservedAtMs(value) {
  try {
    const timestamp = typeof value === "number" ? value : Date.parse(value);
    if (!Number.isSafeInteger(timestamp)) return null;
    const year = new Date(timestamp).getUTCFullYear();
    return year >= 2000 && year <= 2100 ? timestamp : null;
  } catch {
    return null;
  }
}

function buildQueuedBaselineOverlays(observations, baselines, targets, options = {}) {
  if (!Array.isArray(observations) || !Array.isArray(baselines) || !Array.isArray(targets)) {
    fail("invalid_config", "queue overlay 입력 형식이 올바르지 않습니다.");
  }
  const windowMs = options.windowMs ?? DEFAULT_CONFIRMATION_WINDOW_MS;
  const enabledPlayerIds = new Set(
    targets.filter(target => target?.enabled !== false).map(target => target?.playerId),
  );
  const sheetValues = new Map();
  const sheetObservedAt = options.baselineObservedAt || baselines[BASELINE_OBSERVED_AT] || new Map();
  if (!(sheetObservedAt instanceof Map)) {
    fail("invalid_config", "baselineObservedAt은 Map이어야 합니다.");
  }
  for (const baseline of baselines) {
    const key = baselineKey(baseline?.playerId, baseline?.field);
    if (sheetValues.has(key)) fail("invalid_config", "Sheet baseline key가 중복되었습니다.");
    sheetValues.set(key, JSON.stringify(baseline?.value));
  }

  // Only a repeated, high-confidence broadcast consensus can become durable
  // monitor state. Single OCR rows and other collectors remain queue evidence.
  const latest = resolveLatestAccepted(
    observations.filter(observation => observation?.sourceType === "broadcast"
      && typeof observation.sourceId === "string"
      && observation.sourceId.startsWith("screen:")),
    {
      baselines: [],
      windowMs,
      ...(options.now === undefined ? {} : { now: options.now }),
    },
  );
  return Object.freeze(latest
    .filter(candidate => candidate.verification === "broadcast-repeat")
    .filter(candidate => candidate.sourceIds.length >= 2 && candidate.evidenceHashes.length >= 2)
    .filter(candidate => enabledPlayerIds.has(candidate.playerId))
    .filter((candidate) => {
      const key = baselineKey(candidate.playerId, candidate.field);
      if (!sheetObservedAt.has(key)) return true;
      const sheetTime = normalizedObservedAtMs(sheetObservedAt.get(key));
      const candidateTime = normalizedObservedAtMs(candidate.observedAt);
      return candidateTime !== null && (sheetTime === null || candidateTime > sheetTime);
    })
    .filter(candidate => sheetValues.get(baselineKey(candidate.playerId, candidate.field))
      !== JSON.stringify(candidate.value))
    .map(candidate => Object.freeze({
      playerId: candidate.playerId,
      field: candidate.field,
      value: candidate.value,
      observedAtMs: Date.parse(candidate.observedAt),
    })));
}

function loadQueuedBaselineOverlays(queuePath, baselines, targets, options = {}) {
  const acquireFn = options.acquireFn || acquireObservationQueueLock;
  const readFn = options.readFn || readObservationQueue;
  const lock = acquireFn(queuePath, {
    ...(options.lockTimeoutMs === undefined ? {} : { lockTimeoutMs: options.lockTimeoutMs }),
    ...(options.lockStaleMs === undefined ? {} : { lockStaleMs: options.lockStaleMs }),
  });
  let observations;
  try {
    observations = readFn(queuePath, {
      ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
    });
  } finally {
    lock.release();
  }
  return buildQueuedBaselineOverlays(observations, baselines, targets, options);
}

function createRuntime(config, options = {}) {
  const clock = options.clock || Date.now;
  const targets = options.targets || configuredTargets(config);
  const activeTargetCount = targets.filter(target => target.enabled).length;
  const resolverFactory = options.resolverFactory || createSoopHlsResolver;
  const cacheFactory = options.cacheFactory || createSoopHlsCache;
  const segmentFetcherFactory = options.segmentFetcherFactory || createSoopHlsFrameSegmentBatchFetcher;
  const frameFactory = options.frameFactory || createSamgukFfmpegFrame;
  const ocrFactory = options.ocrFactory || createSamgukOcrCommand;
  const monitorFactory = options.monitorFactory || createSamgukHlsMonitor;
  if (config.ocr.enabled && !Array.isArray(options.baselines)) {
    fail("baseline_required", "OCR runtime에는 최신 Google Sheet baseline이 필요합니다.");
  }
  const sharedFetchOptions = {
    fetchImpl: options.fetchImpl,
    timeoutMs: config.hls.timeoutMs,
    maxResponseBytes: config.hls.maxResponseBytes,
  };
  if (sharedFetchOptions.fetchImpl === undefined) delete sharedFetchOptions.fetchImpl;
  const resolvers = {
    SD: resolverFactory({ ...sharedFetchOptions, quality: "SD" }),
    HD: resolverFactory({ ...sharedFetchOptions, quality: "HD" }),
  };
  const hlsCache = cacheFactory({
    resolvers,
    ttlMs: config.hls.cacheTtlMs,
    maxBjIds: activeTargetCount,
    clock,
  });
  const fetchSegments = segmentFetcherFactory({
    ...sharedFetchOptions,
    maxSegmentBytes: config.hls.maxSegmentBytes,
    maxBatchBytes: config.hls.maxBatchBytes,
    maxSegments: config.hls.maxCatchupSegments,
  });
  const frames = frameFactory({
    ffmpegPath: config.ffmpeg.path,
    timeoutMs: config.ffmpeg.timeoutMs,
    maxInputBytes: config.ffmpeg.maxInputBytes,
    maxPngOutputBytes: config.ffmpeg.maxPngOutputBytes,
  });
  const ocr = config.ocr.enabled ? ocrFactory({
    command: config.ocr.command,
    args: config.ocr.args,
    profileId: config.ocr.profileId,
    timeoutMs: config.ocr.timeoutMs,
    maxOutputBytes: config.ocr.maxOutputBytes,
  }) : null;
  const monitor = monitorFactory({
    targets,
    schedulerOptions: config.scheduler,
    clock,
    hlsCache,
    fetchSegments,
    maxCatchupSegments: config.hls.maxCatchupSegments,
    decodeGrayFrame: frames.captureGrayFrame,
    ...(ocr ? {
      decodePngFrame: frames.captureOcrPng,
      runOcr: ocr.run,
      profileId: config.ocr.profileId,
      queuePath: options.queuePath,
      baselines: options.baselines,
      baselineOverlays: options.baselineOverlays || [],
    } : {}),
    signal: options.signal,
  });
  return Object.freeze({ frames, hlsCache, monitor, ocr, targets });
}

async function loadCurrentBaselines(targets, options = {}) {
  const service = options.service || createSamgukSheetService({
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
  const payload = await service.load();
  if (!payload || payload.stale || payload.source !== "google-sheet") {
    fail("baseline_unavailable", "최신 Google Sheet를 읽지 못해 OCR 시작을 중단합니다.");
  }
  const baselines = buildBaselinesFromMembers(payload.members, targets);
  const playerIdByBjId = new Map(targets.map(target => [target.bjId, target.playerId]));
  const observedAt = new Map();
  for (const member of payload.members) {
    const playerId = playerIdByBjId.get(String(member?.soopId || "").normalize("NFKC").trim());
    const timestamp = normalizedObservedAtMs(member?.observedAt);
    if (!playerId) continue;
    for (const field of BATCH_FIELDS) {
      observedAt.set(
        baselineKey(playerId, field),
        timestamp,
      );
    }
  }
  Object.defineProperty(baselines, BASELINE_OBSERVED_AT, {
    configurable: false,
    enumerable: false,
    value: observedAt,
    writable: false,
  });
  return baselines;
}

function safeHeartbeat(snapshot, cacheSnapshot, mode = DEFAULT_WORKER_MODE) {
  const targetStates = Array.isArray(snapshot.scheduler.targets)
    ? snapshot.scheduler.targets
    : [];
  const targetIds = targetStates.map(target => target.targetId).sort();
  const enabledCount = targetStates.filter(target => target.enabled).length;
  return Object.freeze({
    mode,
    totalTargetCount: targetStates.length,
    enabledCount,
    disabledCount: targetStates.length - enabledCount,
    targetSetDigest: crypto.createHash("sha256")
      .update(targetIds.join("\n"), "utf8")
      .digest("hex")
      .slice(0, 16),
    activeTasks: snapshot.activeTasks,
    ocrEnabled: snapshot.ocrEnabled,
    counts: snapshot.scheduler.counts,
    stats: snapshot.stats,
    cache: {
      bjCount: cacheSnapshot.bjCount,
      cachedCount: cacheSnapshot.cachedCount,
      pendingCount: cacheSnapshot.pendingCount,
    },
  });
}

async function main(options = {}) {
  const env = options.env || process.env;
  const logger = options.logger || console;
  const clock = options.clock || Date.now;
  if (!isWorkerEnabled(env)) {
    logger.log?.("[samguk-hls-monitor] 비활성 상태입니다. 외부 조회를 시작하지 않습니다.");
    return { enabled: false };
  }
  const configPath = env.SAMGUK_HLS_MONITOR_CONFIG;
  if (!configPath) fail("missing_config", "SAMGUK_HLS_MONITOR_CONFIG가 필요합니다.");
  const config = (options.loadConfig || loadWorkerConfig)(configPath);
  const targets = configuredTargets(config);
  assertActivationAllowed(config, targets);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  let heartbeat = null;
  let baselineRefreshTimer = null;
  let baselineRefreshPromise = null;
  let baselineRefreshGeneration = 0;
  try {
    const stateDir = path.resolve(env.SAMGUK_HLS_MONITOR_STATE_DIR || defaultStateDir(env));
    const queuePath = path.resolve(
      env.SAMGUK_OBSERVATION_QUEUE_PATH || path.join(stateDir, "observations.ndjson"),
    );
    const baselineLoader = options.baselineLoader || loadCurrentBaselines;
    const baselineLoadOptions = {
      fetchImpl: options.sheetFetchImpl,
    };
    const baselines = config.ocr.enabled
      ? await baselineLoader(targets, baselineLoadOptions)
      : [];
    let baselineOverlays = [];
    if (config.ocr.enabled) {
      try {
        baselineOverlays = (options.queueOverlayLoader || loadQueuedBaselineOverlays)(
          queuePath,
          baselines,
          targets,
          { now: clock() },
        );
      } catch {
        logger.warn?.("[samguk-hls-monitor] queue_overlay_restore_failed");
      }
    }
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const runtime = (options.runtimeFactory || createRuntime)(config, {
      targets,
      queuePath,
      baselines,
      baselineOverlays,
      signal: controller.signal,
      fetchImpl: options.fetchImpl,
      clock,
    });
    const heartbeatMs = options.heartbeatMs || 30_000;
    heartbeat = setInterval(() => {
      logger.log?.(`[samguk-hls-monitor] ${JSON.stringify(safeHeartbeat(
        runtime.monitor.getSnapshot(),
        runtime.hlsCache.getSnapshot(),
        config.mode,
      ))}`);
    }, heartbeatMs);
    heartbeat.unref?.();
    if (config.ocr.enabled) {
      const baselineRefreshMs = integerInRange(
        options.baselineRefreshMs,
        config.ocr.baselineRefreshMs,
        10,
        60 * 60_000,
        "baselineRefreshMs",
      );
      const refreshBaselines = () => {
        if (baselineRefreshPromise || controller.signal.aborted) return;
        const generation = baselineRefreshGeneration;
        const refreshPromise = Promise.resolve()
          .then(() => baselineLoader(targets, baselineLoadOptions))
          .then((nextBaselines) => {
            if (!controller.signal.aborted && generation === baselineRefreshGeneration) {
              runtime.monitor.refreshBaselines(nextBaselines);
            }
          })
          .catch(() => {
            if (!controller.signal.aborted && generation === baselineRefreshGeneration) {
              logger.warn?.("[samguk-hls-monitor] baseline_refresh_failed");
            }
          })
          .finally(() => {
            if (baselineRefreshPromise === refreshPromise) baselineRefreshPromise = null;
          });
        baselineRefreshPromise = refreshPromise;
      };
      baselineRefreshTimer = setInterval(refreshBaselines, baselineRefreshMs);
      baselineRefreshTimer.unref?.();
    } else {
      logger.warn?.("[samguk-hls-monitor] OCR 비활성: UI 감지만 수행합니다.");
    }
    await runtime.monitor.runLoop(controller.signal);
  } finally {
    controller.abort();
    if (heartbeat) clearInterval(heartbeat);
    if (baselineRefreshTimer) clearInterval(baselineRefreshTimer);
    baselineRefreshGeneration += 1;
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
  return { enabled: true };
}

if (require.main === module) {
  process.umask(0o077);
  main().catch((error) => {
    const code = new Set([
      "baseline_required",
      "baseline_unavailable",
      "invalid_config",
      "missing_config",
      "no_targets",
      "permission_required",
    ]).has(error?.code) ? error.code : "failed";
    console.error(`[samguk-hls-monitor] ${code}`);
    process.exitCode = 1;
  });
}

module.exports = {
  ALL_TARGET_COUNT,
  DEFAULT_FFMPEG_CONFIG,
  DEFAULT_HLS_CONFIG,
  DEFAULT_OCR_CONFIG,
  DEFAULT_WORKER_MODE,
  MAX_CONFIG_BYTES,
  SamgukHlsWorkerError,
  WORKER_MODES,
  assertActivationAllowed,
  buildQueuedBaselineOverlays,
  configuredTargets,
  createRuntime,
  defaultStateDir,
  isWorkerEnabled,
  loadWorkerConfig,
  loadCurrentBaselines,
  loadQueuedBaselineOverlays,
  main,
  normalizeWorkerConfig,
  safeHeartbeat,
};
