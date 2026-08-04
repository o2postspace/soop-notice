"use strict";

const crypto = require("node:crypto");
const FALLBACK = require("../data/samguk-fallback.json");
const {
  BATCH_FIELDS,
  PROFILE_ID_PATTERN,
  flattenBroadcastBatch,
  normalizeBatchObject,
  parseBroadcastBatchOutput,
} = require("./samguk-broadcast-batch");
const { createBroadcastChangeTracker } = require("./samguk-broadcast-change-tracker");
const { CURRENT_SEASON_ID, appendObservationQueue } = require("./samguk-observations");
const { createSamgukStreamScheduler } = require("./samguk-stream-scheduler");
const { FRAME_BYTES, analyzeGrayFrame } = require("./samguk-ui-gate");

const MAX_TARGETS = 90;
const MAX_SEGMENTS_PER_BATCH = 12;
const MAX_GRAY_FRAMES_PER_SEGMENT = 8;
const MAX_OCR_SAMPLES_PER_CANDIDATE_SEGMENT = MAX_GRAY_FRAMES_PER_SEGMENT;
const OCR_STREAM_QUALITY = "ORIGINAL";
// SOOP media playlist가 유지하는 최근 구간을 후보 순간에 한 번에 당겨 둔다.
// 2초 segment 기준 약 12초라 normal→burst 전환이 밀려도 짧은 UI를 복구할 수 있다.
const MAX_PREFETCHED_OCR_SEGMENTS = 6;
const MAX_ARCHIVED_FRAMES_PER_CANDIDATE = 4;
// burst lane 수와 맞춰 서로 다른 방송 12곳의 순간 화면을 동시에 선점한다.
// target별 FIFO는 길게 열린 패널이 여러 segment에 걸쳐도 다음 화면을 덮지 않는다.
const MAX_EAGER_CANDIDATE_PREFETCHES = 12;
const MAX_QUEUED_CANDIDATES_PER_TARGET = 64;
// 90채널이 동시에 UI 후보를 내는 짧은 burst도 SD 원본을 놓치지 않도록
// 실측 peak(약 5GiB)에서 12GiB service 한도 안의 48 lane까지 흡수한다.
const MAX_FALLBACK_ARCHIVE_PREFETCHES = 48;
const MAX_SD_FALLBACK_SEGMENT_BYTES = 8 * 1024 * 1024;
const MAX_SD_FALLBACK_FRAMES = 2;
const ARCHIVED_CANDIDATE_TTL_MS = 10 * 60_000;
const HUD_COMBAT_PROFILE_ID = "hud-combat-v1";
const DEFAULT_HUD_PROBE_INTERVAL_MS = 10 * 60_000;
const MIN_HUD_PROBE_INTERVAL_MS = 60_000;
const MAX_HUD_PROBE_INTERVAL_MS = 24 * 60 * 60_000;
const MIN_TASK_LEASE_MS = 100;
const MIN_TASK_DEADLINE_MARGIN_MS = 25;
const MAX_TASK_DEADLINE_MARGIN_MS = 5_000;
const BASELINE_OBSERVED_AT = Symbol.for("soop-notice.samguk-baseline-observed-at");
const PLAYER_ID_PATTERN = /^P\d{3}$/;
const BJ_ID_PATTERN = /^[A-Za-z0-9_]{1,30}$/;
const BROAD_NO_PATTERN = /^[1-9][0-9]{0,19}$/;
const SEGMENT_ID_PATTERN = /^[a-f0-9]{64}$/;
const RETRYABLE_HLS_CODES = new Set([
  "upstream_timeout",
  "upstream_error",
  "upstream_http",
  "invalid_playlist",
]);
const HLS_URL_REFRESH_CODES = new Set([
  "upstream_http",
  "invalid_playlist",
]);
const HLS_ERROR_STAGES = new Set(["playlist", "segment"]);
const SAFE_ERROR_CODES = new Set([
  "aborted",
  "capacity_exceeded",
  "command_failed",
  "duplicate_batch_key",
  "duplicate_field",
  "expired_task",
  "ffmpeg_failed",
  "input_too_large",
  "invalid_batch",
  "invalid_callback",
  "invalid_confidence",
  "invalid_context",
  "invalid_ffmpeg_input",
  "invalid_field",
  "invalid_gate_result",
  "invalid_gray_frame",
  "invalid_hls_result",
  "invalid_hls_url",
  "invalid_json",
  "invalid_observation",
  "invalid_playlist",
  "invalid_png",
  "invalid_png_frame",
  "invalid_profile",
  "invalid_response",
  "invalid_result",
  "invalid_season",
  "invalid_schema",
  "invalid_segment",
  "invalid_version",
  "low_confidence",
  "mixed_frame",
  "not_live",
  "ocr_failed",
  "observation_id_conflict",
  "profile_mismatch",
  "season_mismatch",
  "queue_corrupt",
  "queue_too_large",
  "response_too_large",
  "restricted_broadcast",
  "scan_failed",
  "spawn_failed",
  "stderr_error",
  "stderr_too_large",
  "stdin_error",
  "stdout_error",
  "stdout_too_large",
  "timeout",
  "task_deadline",
  "unknown_task",
  "unsafe_segment_url",
  "upstream_error",
  "upstream_http",
  "upstream_timeout",
]);
const DEFAULT_SCHEDULER_OPTIONS = Object.freeze({
  idleIntervalMs: 60_000,
  liveIntervalMs: 1_000,
  burstIntervalMs: 500,
  burstDurationMs: 30_000,
  normalConcurrency: 56,
  burstConcurrency: 8,
  maxActiveTasks: 64,
  jitterRatio: 0.08,
  backoffBaseMs: 5_000,
  backoffMaxMs: 5 * 60_000,
  taskLeaseMs: 120_000,
  initialSpreadMs: 2_000,
});

class SamgukHlsMonitorError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SamgukHlsMonitorError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new SamgukHlsMonitorError(code, message);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeTarget(input, index) {
  if (!isPlainObject(input)) fail("invalid_targets", `target[${index}] 형식이 올바르지 않습니다.`);
  const allowed = new Set(["id", "playerId", "bjId", "sourceUrl", "enabled", "name"]);
  const unexpected = Object.keys(input).filter(key => !allowed.has(key));
  if (unexpected.length > 0) {
    fail("invalid_targets", `target[${index}]에 허용되지 않은 항목이 있습니다: ${unexpected.join(", ")}`);
  }
  const id = String(input.id || "").normalize("NFKC").trim();
  const playerId = String(input.playerId || "").normalize("NFKC").trim();
  const bjId = String(input.bjId || "").normalize("NFKC").trim();
  if (!PLAYER_ID_PATTERN.test(id) || id !== playerId || !BJ_ID_PATTERN.test(bjId)) {
    fail("invalid_targets", `target[${index}]의 ID 형식이 올바르지 않습니다.`);
  }
  if (input.enabled !== undefined && typeof input.enabled !== "boolean") {
    fail("invalid_targets", `target[${index}].enabled는 boolean이어야 합니다.`);
  }
  let sourceUrl;
  try {
    sourceUrl = new URL(input.sourceUrl);
  } catch {
    fail("invalid_targets", `target[${index}].sourceUrl 형식이 올바르지 않습니다.`);
  }
  const host = sourceUrl.hostname.toLowerCase();
  const expectedPath = `/${bjId}`;
  if (sourceUrl.protocol !== "https:" || sourceUrl.username || sourceUrl.password
    || sourceUrl.port || host !== "play.sooplive.com" || sourceUrl.search
    || ![expectedPath, `${expectedPath}/`].includes(sourceUrl.pathname)) {
    fail("invalid_targets", `target[${index}].sourceUrl은 해당 BJ의 공개 SOOP player URL이어야 합니다.`);
  }
  const name = input.name === undefined ? null : String(input.name).normalize("NFKC").trim();
  return Object.freeze({
    id,
    playerId,
    bjId,
    sourceUrl: `https://play.sooplive.com/${bjId}`,
    enabled: input.enabled !== false,
    name: name || null,
  });
}

function normalizeTargets(inputs) {
  if (!Array.isArray(inputs) || inputs.length === 0 || inputs.length > MAX_TARGETS) {
    fail("invalid_targets", `targets는 1~${MAX_TARGETS}개여야 합니다.`);
  }
  const targets = inputs.map(normalizeTarget);
  if (new Set(targets.map(target => target.id)).size !== targets.length
    || new Set(targets.map(target => target.bjId)).size !== targets.length) {
    fail("invalid_targets", "target playerId 또는 BJ ID가 중복되었습니다.");
  }
  return Object.freeze(targets);
}

function buildFallbackTargets(members = FALLBACK.members) {
  if (!Array.isArray(members)) fail("invalid_roster", "삼국지 roster가 배열이 아닙니다.");
  return normalizeTargets(members.map((member, index) => {
    const playerId = `P${String(index + 1).padStart(3, "0")}`;
    return {
      id: playerId,
      playerId,
      bjId: member?.soopId,
      name: member?.name,
      sourceUrl: `https://play.sooplive.com/${member?.soopId || ""}`,
      enabled: true,
    };
  }));
}

function buildFallbackBaselines(members = FALLBACK.members) {
  if (!Array.isArray(members) || members.length > MAX_TARGETS) {
    fail("invalid_roster", "삼국지 baseline roster가 올바르지 않습니다.");
  }
  const baselines = [];
  members.forEach((member, index) => {
    const playerId = `P${String(index + 1).padStart(3, "0")}`;
    for (const field of BATCH_FIELDS) {
      const value = member?.[field];
      if (value === undefined || value === null || value === "") continue;
      baselines.push({ playerId, field, value });
    }
  });
  return baselines;
}

function buildBaselinesFromMembers(members, targets = buildFallbackTargets()) {
  if (!Array.isArray(members) || members.length !== targets.length || members.length > MAX_TARGETS) {
    fail("invalid_roster", "현재 Google Sheet 참가자와 monitor target 수가 일치해야 합니다.");
  }
  const normalizedTargets = normalizeTargets(targets);
  const playerIdByBjId = new Map(normalizedTargets.map(target => [target.bjId, target.playerId]));
  const seen = new Set();
  const baselines = [];
  for (const member of members) {
    const bjId = String(member?.soopId || "").normalize("NFKC").trim();
    const playerId = playerIdByBjId.get(bjId);
    if (!playerId || seen.has(bjId)) {
      fail("invalid_roster", "현재 Google Sheet 참가자가 monitor target과 일치하지 않습니다.");
    }
    seen.add(bjId);
    for (const field of BATCH_FIELDS) {
      const value = member?.[field];
      if (value === undefined || value === null || value === "") continue;
      baselines.push({ playerId, field, value });
    }
  }
  if (seen.size !== normalizedTargets.length) {
    fail("invalid_roster", "현재 Google Sheet에 monitor target 참가자가 누락되었습니다.");
  }
  return baselines;
}

function safeErrorCode(error, fallback = "scan_failed") {
  const safeFallback = SAFE_ERROR_CODES.has(fallback) ? fallback : "scan_failed";
  let code = safeFallback;
  try {
    if (typeof error?.code === "string") code = error.code;
  } catch {
    code = safeFallback;
  }
  return SAFE_ERROR_CODES.has(code) ? code : safeFallback;
}

function safeHlsErrorStage(error, fallback = "unknown") {
  try {
    const stage = error?.stage;
    if (typeof stage === "string" && HLS_ERROR_STAGES.has(stage)) return stage;
  } catch {
    // 외부 오류의 getter나 원문을 heartbeat에 전달하지 않는다.
  }
  return fallback === "resolver" ? "resolver" : "unknown";
}

function shouldRefreshHlsUrl(error) {
  return safeHlsErrorStage(error) === "playlist"
    && HLS_URL_REFRESH_CODES.has(safeErrorCode(error));
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function validateSegment(value) {
  if (!Buffer.isBuffer(value) || value.length === 0 || value.length > 64 * 1024 * 1024) {
    fail("invalid_segment", "HLS segment가 비어 있거나 너무 큽니다.");
  }
  return value;
}

function validateSegmentBatch(value) {
  if (!Array.isArray(value) || value.length > MAX_SEGMENTS_PER_BATCH) {
    fail("invalid_segment", `HLS segment batch는 0~${MAX_SEGMENTS_PER_BATCH}개여야 합니다.`);
  }
  let previousSequence = -1;
  const segmentIds = new Set();
  return value.map((input) => {
    if (!isPlainObject(input)) fail("invalid_segment", "HLS segment 항목이 올바르지 않습니다.");
    const allowed = new Set(["segmentId", "mediaSequence", "body"]);
    if (Object.keys(input).some(key => !allowed.has(key))
      || typeof input.segmentId !== "string" || !SEGMENT_ID_PATTERN.test(input.segmentId)
      || !Number.isSafeInteger(input.mediaSequence) || input.mediaSequence < 0
      || input.mediaSequence <= previousSequence || segmentIds.has(input.segmentId)) {
      fail("invalid_segment", "HLS segment batch 순서 또는 식별자가 올바르지 않습니다.");
    }
    const body = validateSegment(input.body);
    previousSequence = input.mediaSequence;
    segmentIds.add(input.segmentId);
    return Object.freeze({
      segmentId: input.segmentId,
      mediaSequence: input.mediaSequence,
      body,
    });
  });
}

function normalizeBatch(output, profileId) {
  return typeof output === "string"
    ? parseBroadcastBatchOutput(output, {
      expectedProfileId: profileId,
      expectedSeasonId: CURRENT_SEASON_ID,
    })
    : normalizeBatchObject(output, {
      expectedProfileId: profileId,
      expectedSeasonId: CURRENT_SEASON_ID,
    });
}

function keepsOcrBurstAlive(batch) {
  if (batch.panelVisible !== true) return false;
  if (batch.profileId !== HUD_COMBAT_PROFILE_ID) return true;
  // The combat HUD is visible during ordinary play. Player/horse HP-only
  // results must still reach the change tracker, but must not hold a 30-second
  // OCR burst open as though a transient stats/equipment panel were on screen.
  const passiveHudFields = new Set(["maxHealth", "horseMaxHealth"]);
  return batch.results.some(result => !passiveHudFields.has(result.field));
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

function baselineObservedAtState(entries, key) {
  let metadata;
  try {
    metadata = entries?.[BASELINE_OBSERVED_AT];
  } catch {
    return Object.freeze({ present: true, value: null });
  }
  if (!(metadata instanceof Map) || !metadata.has(key)) {
    return Object.freeze({ present: false, value: null });
  }
  try {
    return Object.freeze({ present: true, value: normalizedObservedAtMs(metadata.get(key)) });
  } catch {
    return Object.freeze({ present: true, value: null });
  }
}

function overlayObservedAtState(overlay) {
  const hasMilliseconds = Object.prototype.hasOwnProperty.call(overlay || {}, "observedAtMs");
  const hasTimestamp = Object.prototype.hasOwnProperty.call(overlay || {}, "observedAt");
  if (!hasMilliseconds && !hasTimestamp) {
    return Object.freeze({ present: false, value: null });
  }
  const value = normalizedObservedAtMs(hasMilliseconds ? overlay.observedAtMs : overlay.observedAt);
  return Object.freeze({ present: true, value });
}

function sheetSupersedesOverlay(local, sheetTime, sheetKeyPresent) {
  if (Number.isSafeInteger(local?.observedAtMs)) {
    return sheetTime.present && Number.isSafeInteger(sheetTime.value)
      && sheetTime.value >= local.observedAtMs;
  }
  return sheetKeyPresent || sheetTime.present;
}

function baselineDigest(entries, trackedKeys = []) {
  const canonical = entries.map(entry => ({
    playerId: entry.playerId,
    field: entry.field,
    value: entry.value,
  })).sort((left, right) => (
    String(left.playerId).localeCompare(String(right.playerId))
      || String(left.field).localeCompare(String(right.field))
      || JSON.stringify(left.value).localeCompare(JSON.stringify(right.value))
  ));
  const observedAt = trackedKeys.map((key) => {
    const state = baselineObservedAtState(entries, key);
    return state.present ? [key, state.value === null ? "invalid" : state.value] : null;
  }).filter(Boolean);
  return sha256(JSON.stringify({ canonical, observedAt }));
}

function baselineKey(playerId, field) {
  return `${playerId}\u0000${field}`;
}

function baselineValueKey(value) {
  return JSON.stringify(value);
}

function resolverStreamIdentity(resolved) {
  if (!isPlainObject(resolved) || !Object.prototype.hasOwnProperty.call(resolved, "broadNo")) {
    return null;
  }
  const broadNo = String(resolved.broadNo ?? "").trim();
  if (!BROAD_NO_PATTERN.test(broadNo)) {
    fail("invalid_hls_result", "HLS cache 방송 식별자가 올바르지 않습니다.");
  }
  // Keep only a one-way identity in monitor state; broadNo never reaches
  // snapshots or logs.
  return sha256(`broad-no:${broadNo}`);
}

function abortableDelay(ms, signal) {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

function normalizeSignal(value) {
  if (value === undefined || value === null) return null;
  if (!(value instanceof AbortSignal)) fail("invalid_signal", "signal은 AbortSignal이어야 합니다.");
  return value;
}

function createTaskAbortScope(task, parentSignal) {
  const leaseMs = task?.leaseExpiresAt - task?.issuedAt;
  if (!Number.isSafeInteger(leaseMs) || leaseMs < MIN_TASK_LEASE_MS) {
    fail("invalid_config", `task lease는 ${MIN_TASK_LEASE_MS}ms 이상이어야 합니다.`);
  }
  const marginMs = Math.min(
    MAX_TASK_DEADLINE_MARGIN_MS,
    Math.max(MIN_TASK_DEADLINE_MARGIN_MS, Math.floor(leaseMs * 0.1)),
  );
  const deadlineMs = leaseMs - marginMs;
  if (deadlineMs <= 0) fail("invalid_config", "task deadline을 lease보다 먼저 설정할 수 없습니다.");

  const controller = new AbortController();
  let abortKind = null;
  let rejectCancellation;
  const cancellation = new Promise((_resolve, reject) => { rejectCancellation = reject; });
  const abort = (kind) => {
    if (abortKind !== null) return;
    abortKind = kind;
    const error = new SamgukHlsMonitorError(
      kind === "parent" ? "aborted" : "task_deadline",
      kind === "parent" ? "monitor 작업이 중단되었습니다." : "task deadline을 초과했습니다.",
    );
    controller.abort(error);
    rejectCancellation(error);
  };
  const onParentAbort = () => abort("parent");
  if (parentSignal?.aborted) onParentAbort();
  else parentSignal?.addEventListener("abort", onParentAbort, { once: true });
  const timer = abortKind === null ? setTimeout(() => abort("deadline"), deadlineMs) : null;

  return Object.freeze({
    cancellation,
    deadlineMs,
    signal: controller.signal,
    abortKind: () => abortKind,
    dispose() {
      if (timer !== null) clearTimeout(timer);
      parentSignal?.removeEventListener("abort", onParentAbort);
    },
  });
}

function createSamgukHlsMonitor(options = {}) {
  if (!isPlainObject(options)) fail("invalid_config", "monitor options가 필요합니다.");
  const targets = normalizeTargets(options.targets || buildFallbackTargets());
  const clock = options.clock || Date.now;
  if (typeof clock !== "function") fail("invalid_config", "clock은 함수여야 합니다.");
  const hlsCache = options.hlsCache;
  if (!hlsCache || typeof hlsCache.get !== "function" || typeof hlsCache.invalidate !== "function") {
    fail("invalid_config", "hlsCache.get/invalidate가 필요합니다.");
  }
  const fetchSegment = options.fetchSegment;
  const fetchSegments = options.fetchSegments;
  const fetchOcrSegments = options.fetchOcrSegments;
  const decodeGrayFrame = options.decodeGrayFrame;
  if ((typeof fetchSegment !== "function" && typeof fetchSegments !== "function")
    || (fetchSegment !== undefined && typeof fetchSegment !== "function")
    || (fetchSegments !== undefined && typeof fetchSegments !== "function")
    || (fetchOcrSegments !== undefined && typeof fetchOcrSegments !== "function")
    || (fetchOcrSegments !== undefined && typeof fetchSegments !== "function")
    || typeof decodeGrayFrame !== "function") {
    fail(
      "invalid_config",
      "fetchSegment 또는 fetchSegments와 decodeGrayFrame 함수가 필요하며 fetchOcrSegments는 fetchSegments와 함께 설정해야 합니다.",
    );
  }
  const usesSegmentBatch = typeof fetchSegments === "function";
  const maxCatchupSegments = options.maxCatchupSegments === undefined
    ? MAX_SEGMENTS_PER_BATCH
    : options.maxCatchupSegments;
  if (!Number.isSafeInteger(maxCatchupSegments)
    || maxCatchupSegments < 1 || maxCatchupSegments > MAX_SEGMENTS_PER_BATCH) {
    fail("invalid_config", `maxCatchupSegments는 1~${MAX_SEGMENTS_PER_BATCH} 정수여야 합니다.`);
  }
  const decodePngFrame = options.decodePngFrame;
  const runOcr = options.runOcr;
  if ((decodePngFrame === undefined) !== (runOcr === undefined)
    || (decodePngFrame !== undefined && typeof decodePngFrame !== "function")
    || (runOcr !== undefined && typeof runOcr !== "function")) {
    fail("invalid_config", "OCR은 decodePngFrame과 runOcr를 함께 설정해야 합니다.");
  }
  const ocrEnabled = typeof runOcr === "function";
  const archiveCandidateFrame = options.archiveCandidateFrame;
  const readCandidateFrame = options.readCandidateFrame;
  if ((archiveCandidateFrame === undefined) !== (readCandidateFrame === undefined)
    || (archiveCandidateFrame !== undefined && typeof archiveCandidateFrame !== "function")
    || (readCandidateFrame !== undefined && typeof readCandidateFrame !== "function")) {
    fail("invalid_config", "후보 frame archive/read 함수를 함께 설정해야 합니다.");
  }
  const defaultSignal = normalizeSignal(options.signal);
  const profileId = options.profileId === undefined ? "stats-panel-v1" : options.profileId;
  if (typeof profileId !== "string" || !PROFILE_ID_PATTERN.test(profileId)) {
    fail("invalid_config", "profileId 형식이 올바르지 않습니다.");
  }
  const hudProbeIntervalMs = options.hudProbeIntervalMs === undefined
    ? DEFAULT_HUD_PROBE_INTERVAL_MS
    : options.hudProbeIntervalMs;
  if (!Number.isSafeInteger(hudProbeIntervalMs)
    || hudProbeIntervalMs < MIN_HUD_PROBE_INTERVAL_MS
    || hudProbeIntervalMs > MAX_HUD_PROBE_INTERVAL_MS) {
    fail(
      "invalid_config",
      `hudProbeIntervalMs는 ${MIN_HUD_PROBE_INTERVAL_MS}~${MAX_HUD_PROBE_INTERVAL_MS} 정수여야 합니다.`,
    );
  }
  const queuePath = options.queuePath;
  const appendFn = options.appendFn || appendObservationQueue;
  if (ocrEnabled && (typeof queuePath !== "string" || !queuePath.trim() || typeof appendFn !== "function")) {
    fail("invalid_config", "OCR 활성화에는 queuePath와 appendFn이 필요합니다.");
  }
  const gate = options.gate || analyzeGrayFrame;
  if (typeof gate !== "function") fail("invalid_config", "gate는 함수여야 합니다.");
  const maxActiveTasks = options.schedulerOptions?.maxActiveTasks
    ?? DEFAULT_SCHEDULER_OPTIONS.maxActiveTasks;
  if (!Number.isSafeInteger(maxActiveTasks) || maxActiveTasks < 1 || maxActiveTasks > MAX_TARGETS) {
    fail("invalid_config", `maxActiveTasks는 1~${MAX_TARGETS} 정수여야 합니다.`);
  }
  const scheduler = options.scheduler || createSamgukStreamScheduler({
    ...DEFAULT_SCHEDULER_OPTIONS,
    ...(options.schedulerOptions || {}),
    targets,
    now: options.now === undefined ? clock() : options.now,
    clock,
  });
  if (!scheduler || typeof scheduler.selectDue !== "function"
    || typeof scheduler.applyResult !== "function" || typeof scheduler.cancelTask !== "function"
    || typeof scheduler.getSnapshot !== "function") {
    fail("invalid_config", "scheduler 형식이 올바르지 않습니다.");
  }
  if (scheduler.config?.taskLeaseMs !== undefined
    && (!Number.isSafeInteger(scheduler.config.taskLeaseMs)
      || scheduler.config.taskLeaseMs < MIN_TASK_LEASE_MS)) {
    fail("invalid_config", `scheduler.taskLeaseMs는 ${MIN_TASK_LEASE_MS}ms 이상이어야 합니다.`);
  }
  if (ocrEnabled && !Array.isArray(options.baselines)) {
    fail("invalid_config", "OCR 활성화에는 최신 Google Sheet baseline이 필요합니다.");
  }
  const baselineOverlays = options.baselineOverlays === undefined ? [] : options.baselineOverlays;
  if (!Array.isArray(baselineOverlays) || (!ocrEnabled && baselineOverlays.length > 0)) {
    fail("invalid_config", "baseline overlay는 OCR 활성화 시 배열이어야 합니다.");
  }
  const initialBaselines = [...(options.baselines || [])];
  const trackedBaselineKeys = targets.flatMap(target => (
    BATCH_FIELDS.map(field => baselineKey(target.playerId, field))
  ));
  const initialBaselineIndex = new Map();
  initialBaselines.forEach((entry, index) => {
    const key = baselineKey(entry?.playerId, entry?.field);
    if (!initialBaselineIndex.has(key)) initialBaselineIndex.set(key, index);
  });
  const localStableOverlays = new Map();
  for (const overlay of baselineOverlays) {
    const key = baselineKey(overlay?.playerId, overlay?.field);
    if (localStableOverlays.has(key)) {
      fail("invalid_config", "baseline overlay key가 중복되었습니다.");
    }
    const normalizedOverlay = {
      playerId: overlay?.playerId,
      field: overlay?.field,
      value: overlay?.value,
    };
    const overlayTime = overlayObservedAtState(overlay);
    if (overlayTime.present && overlayTime.value === null) continue;
    const baselineIndex = initialBaselineIndex.get(key);
    const sheetTime = baselineObservedAtState(options.baselines || [], key);
    if ((!overlayTime.present && sheetTime.present)
      || (Number.isSafeInteger(overlayTime.value)
        && Number.isSafeInteger(sheetTime.value)
        && sheetTime.value >= overlayTime.value)) {
      continue;
    }
    if (baselineIndex === undefined) {
      initialBaselineIndex.set(key, initialBaselines.length);
      initialBaselines.push(normalizedOverlay);
      localStableOverlays.set(key, {
        ...normalizedOverlay,
        valueKey: baselineValueKey(normalizedOverlay.value),
        observedAtMs: overlayTime.value,
      });
      continue;
    }
    const sheetValueKey = baselineValueKey(initialBaselines[baselineIndex]?.value);
    if (sheetValueKey === baselineValueKey(normalizedOverlay.value)) {
      localStableOverlays.set(key, {
        ...normalizedOverlay,
        valueKey: baselineValueKey(normalizedOverlay.value),
        observedAtMs: overlayTime.value,
      });
      continue;
    }
    initialBaselines[baselineIndex] = normalizedOverlay;
    localStableOverlays.set(key, {
      ...normalizedOverlay,
      valueKey: baselineValueKey(normalizedOverlay.value),
      observedAtMs: overlayTime.value,
    });
  }
  const tracker = options.changeTracker || createBroadcastChangeTracker({
    baselines: initialBaselines,
    now: options.now === undefined ? clock() : options.now,
  });
  if (!tracker || typeof tracker.observeBatch !== "function"
    || (ocrEnabled && typeof tracker.initializeStable !== "function")) {
    fail("invalid_config", "changeTracker 형식이 올바르지 않습니다.");
  }
  let currentBaselineDigest = baselineDigest(options.baselines || [], trackedBaselineKeys);

  const lastSegmentHash = new Map();
  const lastMediaSequence = new Map();
  const segmentCursors = new Map();
  const streamIdentities = new Map();
  const pendingCandidates = new Map();
  const queuedCandidates = new Map();
  const candidatePrefetches = new Map();
  const candidateFallbackArchives = new Map();
  const active = new Set();
  const stats = {
    tasks: 0,
    liveResults: 0,
    offlineResults: 0,
    failures: 0,
    uiCandidates: 0,
    hudProbes: 0,
    confirmedUiPanels: 0,
    earlyBurstEnds: 0,
    duplicateSegments: 0,
    segmentsFetched: 0,
    segmentsProcessed: 0,
    catchupSegments: 0,
    noNewSegments: 0,
    sequenceGaps: 0,
    segmentsMissed: 0,
    sdSequenceGaps: 0,
    sdSegmentsMissed: 0,
    burstSdSegmentsAdvanced: 0,
    burstSdGateSegments: 0,
    burstSdUiCandidates: 0,
    burstSdSyncErrors: 0,
    hdSequenceGaps: 0,
    hdSegmentsUnobserved: 0,
    staleSegmentsSkipped: 0,
    streamResets: 0,
    hlsRetries: 0,
    hlsResolverRetryErrors: 0,
    hlsPlaylistRetryErrors: 0,
    hlsSegmentRetryErrors: 0,
    hlsUnknownRetryErrors: 0,
    hlsResolverFailures: 0,
    hlsPlaylistFailures: 0,
    hlsSegmentFailures: 0,
    hlsUnknownFailures: 0,
    hlsRetryCacheInvalidations: 0,
    lastHlsErrorStage: null,
    candidateSequenceMisses: 0,
    candidatePrefetchStarts: 0,
    candidatePrefetchSaturated: 0,
    candidateFallbackArchiveStarts: 0,
    candidateFallbackArchiveSaturated: 0,
    candidateQueueAdds: 0,
    candidateQueueDrops: 0,
    candidateSdFallbackArchivedFrames: 0,
    candidateSdFallbackUses: 0,
    candidateFramePrefetches: 0,
    candidateFramesArchived: 0,
    candidateFramesLoaded: 0,
    candidateFramesExpired: 0,
    candidateFrameCaptureErrors: 0,
    candidateFrameArchiveErrors: 0,
    candidateFrameReadErrors: 0,
    ocrRuns: 0,
    ocrErrors: 0,
    confirmedChanges: 0,
    queuedObservations: 0,
    baselineRefreshes: 0,
    baselineOverlayPreserved: 0,
    lastBaselineRefreshAt: null,
    lastErrorCode: null,
    lastErrorAt: null,
  };
  const hiddenBurstFrames = new Map();
  const nextHudProbeAt = new Map();
  const activeHudProbes = new Set();
  const hudProbePhaseIndex = new Map(targets.map((target, index) => [target.id, index]));

  function monotonicNow() {
    return clock();
  }

  function candidatesMatch(left, right) {
    return Number.isSafeInteger(left?.mediaSequence)
      && left.mediaSequence === right?.mediaSequence;
  }

  function noteExpiredCandidate(candidate) {
    stats.candidateFramesExpired += Array.isArray(candidate?.prefetchedFrames)
      ? candidate.prefetchedFrames.length
      : 0;
  }

  function promoteQueuedCandidate(target, now = monotonicNow()) {
    const queue = queuedCandidates.get(target.id) || [];
    while (queue.length > 0) {
      const candidate = queue.shift();
      if (Number.isSafeInteger(candidate.expiresAtMs) && now >= candidate.expiresAtMs) {
        noteExpiredCandidate(candidate);
        continue;
      }
      pendingCandidates.set(target.id, candidate);
      if (queue.length === 0) queuedCandidates.delete(target.id);
      else queuedCandidates.set(target.id, queue);
      if (!Array.isArray(candidate.prefetchedFrames) || candidate.prefetchedFrames.length === 0) {
        startCandidatePrefetch(target, candidate);
      }
      return candidate;
    }
    queuedCandidates.delete(target.id);
    return null;
  }

  function advancePendingCandidate(target, expected, now = monotonicNow()) {
    const current = pendingCandidates.get(target.id);
    if (expected && current !== expected) return current || null;
    pendingCandidates.delete(target.id);
    return promoteQueuedCandidate(target, now);
  }

  function clearTargetCandidates(target) {
    pendingCandidates.delete(target.id);
    queuedCandidates.delete(target.id);
  }

  function pendingCandidateFor(target, now = monotonicNow()) {
    let pending = pendingCandidates.get(target.id);
    if (!pending) return null;
    if (Number.isSafeInteger(pending.expiresAtMs) && now >= pending.expiresAtMs) {
      noteExpiredCandidate(pending);
      pending = advancePendingCandidate(target, pending, now);
    }
    return pending || null;
  }

  function replaceCandidate(target, candidate, replacement) {
    if (pendingCandidates.get(target.id) === candidate) {
      pendingCandidates.set(target.id, replacement);
      return true;
    }
    const queue = queuedCandidates.get(target.id);
    const index = Array.isArray(queue) ? queue.indexOf(candidate) : -1;
    if (index < 0) return false;
    queue[index] = replacement;
    return true;
  }

  function enqueueCandidate(target, candidate, { eager = true, fallbackSegment = null } = {}) {
    const pending = pendingCandidateFor(target);
    const queue = queuedCandidates.get(target.id) || [];
    if (candidatesMatch(pending, candidate)
      || queue.some(item => candidatesMatch(item, candidate))) return false;
    if (!pending) {
      pendingCandidates.set(target.id, candidate);
      if (eager) startCandidatePrefetch(target, candidate, fallbackSegment);
      return true;
    }
    if (queue.length >= MAX_QUEUED_CANDIDATES_PER_TARGET) {
      stats.candidateQueueDrops += 1;
      return false;
    }
    queue.push(candidate);
    queuedCandidates.set(target.id, queue);
    stats.candidateQueueAdds += 1;
    if (eager) startCandidatePrefetch(target, candidate, fallbackSegment);
    return true;
  }

  function archivedSegmentsFor(pending) {
    if (!Array.isArray(pending?.prefetchedFrames) || pending.prefetchedFrames.length === 0) {
      return Object.freeze([]);
    }
    const grouped = new Map();
    for (const frame of pending.prefetchedFrames) {
      const key = frame.segmentId;
      if (!grouped.has(key)) {
        grouped.set(key, {
          segmentId: frame.segmentId,
          mediaSequence: frame.mediaSequence,
          archivedFrames: [],
        });
      }
      grouped.get(key).archivedFrames.push(frame);
    }
    return Object.freeze([...grouped.values()]
      .sort((left, right) => left.mediaSequence - right.mediaSequence)
      .map(segment => Object.freeze({
        ...segment,
        archivedFrames: Object.freeze(segment.archivedFrames),
      })));
  }

  function hudProbeDue(target, now) {
    if (!ocrEnabled || profileId !== HUD_COMBAT_PROFILE_ID) return false;
    if (!nextHudProbeAt.has(target.id)) {
      const phaseIndex = hudProbePhaseIndex.get(target.id) || 0;
      const phaseOffset = Math.floor(hudProbeIntervalMs * phaseIndex / targets.length);
      nextHudProbeAt.set(target.id, now + phaseOffset);
    }
    return now >= nextHudProbeAt.get(target.id);
  }

  function postponeHudProbe(target, now) {
    if (profileId === HUD_COMBAT_PROFILE_ID) {
      nextHudProbeAt.set(target.id, now + hudProbeIntervalMs);
    }
  }

  function throwIfAborted(signal) {
    if (!signal?.aborted) return;
    const reason = signal.reason;
    if (reason instanceof SamgukHlsMonitorError) throw reason;
    fail("aborted", "monitor 작업이 중단되었습니다.");
  }

  function streamKey(target, quality) {
    return `${target.id}:${quality}`;
  }

  function resetStreamProgress(target, quality) {
    const key = streamKey(target, quality);
    lastSegmentHash.delete(key);
    lastMediaSequence.delete(key);
    segmentCursors.delete(key);
  }

  function resetTargetProgress(target) {
    for (const quality of ["SD", OCR_STREAM_QUALITY]) {
      resetStreamProgress(target, quality);
    }
    streamIdentities.delete(target.id);
    clearTargetCandidates(target);
    hiddenBurstFrames.delete(target.id);
    nextHudProbeAt.delete(target.id);
    activeHudProbes.delete(target.id);
  }

  function commitSegment(target, quality, segment, contentHash) {
    const key = streamKey(target, quality);
    if (usesSegmentBatch) {
      const previousSequence = lastMediaSequence.get(key);
      if (Number.isSafeInteger(previousSequence)
        && segment.mediaSequence <= previousSequence) {
        if (segment.mediaSequence === previousSequence) {
          segmentCursors.set(key, segment.segmentId);
        }
        return false;
      }
      if (Number.isSafeInteger(previousSequence)
        && segment.mediaSequence > previousSequence + 1) {
        const missed = segment.mediaSequence - previousSequence - 1;
        stats.sequenceGaps += 1;
        stats.segmentsMissed += missed;
        if (quality === "SD") {
          stats.sdSequenceGaps += 1;
          stats.sdSegmentsMissed += missed;
        } else {
          stats.hdSequenceGaps += 1;
          stats.hdSegmentsUnobserved += missed;
        }
      }
      lastMediaSequence.set(key, segment.mediaSequence);
      segmentCursors.set(key, segment.segmentId);
    }
    lastSegmentHash.set(key, contentHash);
    return true;
  }

  function contentHashFor(segment) {
    return sha256(segment.body);
  }

  function candidateRunsFor(candidateIndices) {
    const runs = [];
    for (const sampleIndex of candidateIndices) {
      const previous = runs.at(-1);
      if (previous && sampleIndex === previous.endIndex + 1) {
        previous.endIndex = sampleIndex;
      } else {
        runs.push({ startIndex: sampleIndex, endIndex: sampleIndex });
      }
    }
    return Object.freeze(runs.map(run => Object.freeze(run)));
  }

  function candidateOcrSampleIndices(pending) {
    if (!Number.isSafeInteger(pending?.sampleCount)
      || pending.sampleCount < 1 || pending.sampleCount > MAX_GRAY_FRAMES_PER_SEGMENT) {
      return Object.freeze([]);
    }
    const rawCandidates = Array.isArray(pending.candidateIndices)
      ? pending.candidateIndices
      : [pending.sampleIndex];
    const candidates = [...new Set(rawCandidates.filter(sampleIndex => (
      Number.isSafeInteger(sampleIndex)
        && sampleIndex >= 0
        && sampleIndex < pending.sampleCount
    )))].sort((left, right) => left - right);
    const selected = new Set();
    for (const sampleIndex of candidates) {
      selected.add(sampleIndex);
      const adjacent = sampleIndex + 1 < pending.sampleCount
        ? sampleIndex + 1
        : sampleIndex - 1;
      if (adjacent >= 0) selected.add(adjacent);
    }
    return Object.freeze([...selected]
      .sort((left, right) => left - right)
      .slice(0, MAX_OCR_SAMPLES_PER_CANDIDATE_SEGMENT));
  }

  function inspectGrayFrames(grayFrames) {
    if (!Buffer.isBuffer(grayFrames) || grayFrames.length < FRAME_BYTES
      || grayFrames.length > FRAME_BYTES * MAX_GRAY_FRAMES_PER_SEGMENT
      || grayFrames.length % FRAME_BYTES !== 0) {
      fail(
        "invalid_gray_frame",
        `gray frame 묶음은 ${FRAME_BYTES}바이트 단위로 최대 ${MAX_GRAY_FRAMES_PER_SEGMENT}개여야 합니다.`,
      );
    }
    const sampleCount = grayFrames.length / FRAME_BYTES;
    const candidateIndices = [];
    let candidateGateResult = null;
    let lastGateResult = null;
    for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
      const offset = sampleIndex * FRAME_BYTES;
      const gateResult = gate(grayFrames.subarray(offset, offset + FRAME_BYTES));
      if (!isPlainObject(gateResult) || typeof gateResult.uiCandidate !== "boolean") {
        fail("invalid_gate_result", "UI gate 결과가 올바르지 않습니다.");
      }
      lastGateResult = gateResult;
      if (gateResult.uiCandidate) {
        candidateIndices.push(sampleIndex);
        if (candidateGateResult === null) candidateGateResult = gateResult;
      }
    }
    const frozenCandidateIndices = Object.freeze(candidateIndices);
    return Object.freeze({
      sampleCount,
      candidateIndices: frozenCandidateIndices,
      candidateRuns: candidateRunsFor(candidateIndices),
      candidateGateResult,
      lastGateResult,
    });
  }

  function isContentDuplicate(target, quality, contentHash) {
    return lastSegmentHash.get(streamKey(target, quality)) === contentHash;
  }

  function onlyFreshSegments(target, quality, segments) {
    if (!usesSegmentBatch || segments.length === 0) return segments;
    const key = streamKey(target, quality);
    const previousSequence = lastMediaSequence.get(key);
    if (!Number.isSafeInteger(previousSequence)) return segments;
    const fresh = [];
    let sameSequence = null;
    for (const segment of segments) {
      if (segment.mediaSequence <= previousSequence) {
        stats.staleSegmentsSkipped += 1;
        if (segment.mediaSequence === previousSequence) sameSequence = segment;
      } else {
        fresh.push(segment);
      }
    }
    if (sameSequence) segmentCursors.set(key, sameSequence.segmentId);
    return fresh;
  }

  async function resolveAndFetch(
    target,
    quality,
    signal = defaultSignal,
    { initialSegmentCount } = {},
  ) {
    if (initialSegmentCount !== undefined
      && (!Number.isSafeInteger(initialSegmentCount)
        || initialSegmentCount < 1 || initialSegmentCount > maxCatchupSegments)) {
      fail("invalid_config", "initialSegmentCount 범위를 확인하세요.");
    }
    let lastError;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let operationStage = "resolver";
      try {
        throwIfAborted(signal);
        const resolved = await hlsCache.get(target.bjId, quality, { signal: signal || undefined });
        throwIfAborted(signal);
        const hlsUrl = typeof resolved === "string" ? resolved : resolved?.hlsUrl;
        if (typeof hlsUrl !== "string" || !hlsUrl) fail("invalid_hls_result", "HLS cache 결과가 올바르지 않습니다.");
        operationStage = "fetch";
        const identity = resolverStreamIdentity(resolved);
        const previousIdentity = streamIdentities.get(target.id);
        const identityChanged = Boolean(identity && previousIdentity && identity !== previousIdentity);
        let segments;
        if (usesSegmentBatch) {
          const batchFetcher = quality === OCR_STREAM_QUALITY && fetchOcrSegments
            ? fetchOcrSegments
            : fetchSegments;
          const key = streamKey(target, quality);
          const cursor = identityChanged ? undefined : segmentCursors.get(key);
          const fetched = await batchFetcher(hlsUrl, {
            ...(cursor ? { afterSegmentId: cursor } : {}),
            initialSegmentCount: initialSegmentCount
              ?? ((cursor || quality === OCR_STREAM_QUALITY) ? maxCatchupSegments : 1),
            signal: signal || undefined,
          });
          throwIfAborted(signal);
          segments = validateSegmentBatch(fetched);
          const previousSequence = lastMediaSequence.get(key);
          const newestSequence = segments.at(-1)?.mediaSequence;
          const rollbackReset = !identity
            && Number.isSafeInteger(previousSequence)
            && Number.isSafeInteger(newestSequence)
            && newestSequence + maxCatchupSegments < previousSequence;
          if (identityChanged) {
            await hlsCache.invalidate(target.bjId);
            throwIfAborted(signal);
          }
          if (identityChanged || rollbackReset) {
            resetTargetProgress(target);
            stats.streamResets += 1;
          }
          if (identity) streamIdentities.set(target.id, identity);
        } else {
          const fetched = await fetchSegment(hlsUrl, {
            signal: signal || undefined,
          });
          throwIfAborted(signal);
          const body = validateSegment(fetched);
          segments = [Object.freeze({
            segmentId: sha256(body),
            mediaSequence: null,
            body,
          })];
        }
        throwIfAborted(signal);
        stats.segmentsFetched += segments.length;
        if (segments.length === 0) stats.noNewSegments += 1;
        else if (segments.length > 1) stats.catchupSegments += segments.length - 1;
        return segments;
      } catch (error) {
        lastError = error;
        const errorCode = safeErrorCode(error);
        const retryable = RETRYABLE_HLS_CODES.has(errorCode);
        const errorStage = safeHlsErrorStage(
          error,
          operationStage === "resolver" ? "resolver" : "unknown",
        );
        if (!retryable) break;
        stats.lastHlsErrorStage = errorStage;
        if (attempt > 0) {
          stats[`hls${errorStage[0].toUpperCase()}${errorStage.slice(1)}Failures`] += 1;
          break;
        }
        stats.hlsRetries += 1;
        stats[`hls${errorStage[0].toUpperCase()}${errorStage.slice(1)}RetryErrors`] += 1;
        throwIfAborted(signal);
        // segment 요청과 timeout은 같은 media playlist를 다시 읽으면 복구할 수 있다.
        // URL 자체가 거절되거나 playlist가 깨졌을 때만 resolver cache를 비운다.
        if (shouldRefreshHlsUrl(error)) {
          await hlsCache.invalidate(target.bjId, quality);
          stats.hlsRetryCacheInvalidations += 1;
          throwIfAborted(signal);
        }
      }
    }
    throw lastError;
  }

  async function prefetchOriginalCandidate(target, candidate, signal) {
    if (!ocrEnabled || typeof archiveCandidateFrame !== "function"
      || typeof readCandidateFrame !== "function") return null;
    const fetched = await resolveAndFetch(target, OCR_STREAM_QUALITY, signal, {
      initialSegmentCount: Math.min(MAX_PREFETCHED_OCR_SEGMENTS, maxCatchupSegments),
    });
    throwIfAborted(signal);
    const segments = fetched.slice(-MAX_PREFETCHED_OCR_SEGMENTS);
    if (segments.length === 0) return null;

    const plans = [];
    const fallbackSamples = candidateOcrSampleIndices(candidate);
    const exactIndex = Number.isSafeInteger(candidate?.mediaSequence)
      ? segments.findIndex(segment => segment.mediaSequence === candidate.mediaSequence)
      : -1;
    const exactSegment = exactIndex >= 0 ? segments[exactIndex] : null;
    const newestSequence = segments.at(-1)?.mediaSequence;

    // ORIGINAL rendition가 아직 SD 후보 sequence에 도달하지 않았으면 과거
    // frame을 후보로 잘못 저장하지 않는다. 다음 burst가 같은 sequence를
    // playlist cursor로 이어서 기다리게 둔다.
    if (!exactSegment
      && Number.isSafeInteger(candidate?.mediaSequence)
      && Number.isSafeInteger(newestSequence)
      && newestSequence < candidate.mediaSequence) {
      return null;
    }

    // sequence가 맞으면 후보 phase를 최우선으로 두고 양쪽 segment 경계도
    // 함께 보존한다. UI가 segment 경계 직전/직후에 잠깐 열린 경우를 복구한다.
    if (exactSegment && fallbackSamples.length > 0) {
      plans.push(Object.freeze({
        segmentId: exactSegment.segmentId,
        sampleIndices: fallbackSamples,
      }));
      const before = segments[exactIndex - 1];
      const after = segments[exactIndex + 1];
      if (before) {
        plans.push(Object.freeze({
          segmentId: before.segmentId,
          sampleIndices: Object.freeze([MAX_GRAY_FRAMES_PER_SEGMENT - 1]),
        }));
      }
      if (after) {
        plans.push(Object.freeze({
          segmentId: after.segmentId,
          sampleIndices: Object.freeze([0]),
        }));
      }
    } else {
      for (const segment of segments) {
        const grayFrames = await decodeGrayFrame(segment.body, { signal: signal || undefined });
        throwIfAborted(signal);
        const inspected = inspectGrayFrames(grayFrames);
        if (inspected.candidateIndices.length === 0) continue;
        plans.push(Object.freeze({
          segmentId: segment.segmentId,
          sampleIndices: candidateOcrSampleIndices(inspected),
        }));
      }
    }
    if (plans.length === 0) {
      if (fallbackSamples.length > 0) {
        // rendition sequence가 달라도 최근 ORIGINAL window 자체를 작은 ring으로
        // 남긴다. gate가 특정 장비/절기 화면을 놓쳐도 OCR이 사후 확인할 수 있다.
        for (const segment of [...segments].reverse()) {
          plans.push(Object.freeze({
            segmentId: segment.segmentId,
            sampleIndices: Object.freeze([fallbackSamples[0]]),
          }));
        }
      }
    }

    // 가능하면 서로 다른 HLS segment에서 한 장씩 먼저 고른다. 같은 segment의
    // 인접 frame 두 장보다 독립적인 교차검증 근거가 된다.
    const captureRequests = [];
    const maxSamples = Math.max(0, ...plans.map(plan => plan.sampleIndices.length));
    for (let sampleOffset = 0; sampleOffset < maxSamples; sampleOffset += 1) {
      for (const plan of plans) {
        const sampleIndex = plan.sampleIndices[sampleOffset];
        if (!Number.isSafeInteger(sampleIndex)) continue;
        captureRequests.push({ plan, sampleIndex });
        if (captureRequests.length >= MAX_ARCHIVED_FRAMES_PER_CANDIDATE) break;
      }
      if (captureRequests.length >= MAX_ARCHIVED_FRAMES_PER_CANDIDATE) break;
    }

    const capturedAtMs = monotonicNow();
    const prefetchedFrames = [];
    for (const { plan, sampleIndex } of captureRequests) {
      const segment = segments.find(item => item.segmentId === plan.segmentId);
      if (!segment) continue;
      const png = await decodePngFrame(segment.body, {
        sampleIndex,
        signal: signal || undefined,
      });
      throwIfAborted(signal);
      if (!Buffer.isBuffer(png) || png.length < 8
        || !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
        fail("invalid_png_frame", "후보 보존 frame이 PNG 형식이 아닙니다.");
      }
      try {
        const archiveRef = await archiveCandidateFrame(png, Object.freeze({
          playerId: target.playerId,
          targetId: target.id,
          observedAtMs: capturedAtMs,
          mediaSequence: segment.mediaSequence,
          sampleIndex,
          evidenceHash: sha256(png),
        }));
        if (typeof archiveRef !== "string" || archiveRef.length < 1 || archiveRef.length > 255
          || !/^[A-Za-z0-9._-]+$/.test(archiveRef)) {
          fail("invalid_response", "후보 frame archive 참조가 올바르지 않습니다.");
        }
        prefetchedFrames.push(Object.freeze({
          archiveRef,
          segmentId: segment.segmentId,
          segmentHash: contentHashFor(segment),
          mediaSequence: segment.mediaSequence,
          sampleIndex,
          observedAtMs: capturedAtMs,
        }));
        stats.candidateFramesArchived += 1;
      } catch {
        stats.candidateFrameArchiveErrors += 1;
      }
    }
    stats.candidateFramePrefetches += 1;
    if (prefetchedFrames.length === 0) return null;
    return Object.freeze({
      capturedAtMs,
      expiresAtMs: capturedAtMs + ARCHIVED_CANDIDATE_TTL_MS,
      frames: Object.freeze(prefetchedFrames),
    });
  }

  async function archiveSdCandidateFallback(target, candidate, segment, signal) {
    if (!segment || !Buffer.isBuffer(segment.body) || segment.body.length === 0
      || segment.body.length > MAX_SD_FALLBACK_SEGMENT_BYTES
      || segment.mediaSequence !== candidate.mediaSequence) return null;
    const sampleIndices = candidateOcrSampleIndices(candidate)
      .slice(0, MAX_SD_FALLBACK_FRAMES);
    if (sampleIndices.length === 0) return null;
    const capturedAtMs = Number.isSafeInteger(candidate.detectedAtMs)
      ? candidate.detectedAtMs
      : monotonicNow();
    const segmentHash = contentHashFor(segment);
    const frames = [];
    for (const sampleIndex of sampleIndices) {
      const png = await decodePngFrame(segment.body, {
        sampleIndex,
        signal: signal || undefined,
      });
      throwIfAborted(signal);
      if (!Buffer.isBuffer(png) || png.length < 8
        || !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
        fail("invalid_png_frame", "SD fallback 후보 frame이 PNG 형식이 아닙니다.");
      }
      try {
        const archiveRef = await archiveCandidateFrame(png, Object.freeze({
          playerId: target.playerId,
          targetId: target.id,
          observedAtMs: capturedAtMs,
          mediaSequence: segment.mediaSequence,
          sampleIndex,
          evidenceHash: sha256(png),
        }));
        if (typeof archiveRef !== "string" || archiveRef.length < 1 || archiveRef.length > 255
          || !/^[A-Za-z0-9._-]+$/.test(archiveRef)) {
          fail("invalid_response", "SD fallback archive 참조가 올바르지 않습니다.");
        }
        frames.push(Object.freeze({
          archiveRef,
          segmentId: segment.segmentId,
          segmentHash,
          mediaSequence: segment.mediaSequence,
          sampleIndex,
          observedAtMs: capturedAtMs,
        }));
        stats.candidateFramesArchived += 1;
        stats.candidateSdFallbackArchivedFrames += 1;
      } catch {
        stats.candidateFrameArchiveErrors += 1;
      }
    }
    return frames.length === 0 ? null : Object.freeze({
      capturedAtMs,
      expiresAtMs: capturedAtMs + ARCHIVED_CANDIDATE_TTL_MS,
      frames: Object.freeze(frames),
    });
  }

  async function prefetchOcrCandidate(target, candidate, signal, fallbackSegment = null) {
    const fallbackPromise = archiveSdCandidateFallback(
      target,
      candidate,
      fallbackSegment,
      signal,
    );
    const originalPromise = prefetchOriginalCandidate(target, candidate, signal);
    const [fallback, original] = await Promise.allSettled([fallbackPromise, originalPromise]);
    if (original.status === "fulfilled" && original.value) return original.value;
    if (fallback.status === "fulfilled" && fallback.value) {
      stats.candidateSdFallbackUses += 1;
      return fallback.value;
    }
    if (original.status === "rejected") throw original.reason;
    if (fallback.status === "rejected") throw fallback.reason;
    return null;
  }

  function startFallbackArchive(target, candidate, fallbackSegment) {
    if (!fallbackSegment || !Buffer.isBuffer(fallbackSegment.body)
      || fallbackSegment.body.length === 0
      || fallbackSegment.body.length > MAX_SD_FALLBACK_SEGMENT_BYTES) return null;
    const existing = candidateFallbackArchives.get(candidate);
    if (existing) return existing.promise;
    if (candidateFallbackArchives.size >= MAX_FALLBACK_ARCHIVE_PREFETCHES) {
      stats.candidateFallbackArchiveSaturated += 1;
      return null;
    }

    stats.candidateFallbackArchiveStarts += 1;
    const entry = { candidate, promise: null };
    const promise = archiveSdCandidateFallback(
      target,
      candidate,
      fallbackSegment,
      defaultSignal,
    )
      .then((prefetched) => {
        if (!prefetched) return prefetched;
        stats.candidateSdFallbackUses += 1;
        replaceCandidate(target, candidate, Object.freeze({
          ...candidate,
          prefetchedCapturedAtMs: prefetched.capturedAtMs,
          prefetchedFrames: prefetched.frames,
          expiresAtMs: prefetched.expiresAtMs,
        }));
        return prefetched;
      })
      .catch(() => {
        stats.candidateFrameCaptureErrors += 1;
        return null;
      })
      .finally(() => {
        if (candidateFallbackArchives.get(candidate) === entry) {
          candidateFallbackArchives.delete(candidate);
        }
      });
    entry.promise = promise;
    candidateFallbackArchives.set(candidate, entry);
    return promise;
  }

  function startCandidatePrefetch(target, candidate, fallbackSegment = null) {
    if (!ocrEnabled || candidate?.hudProbe === true
      || typeof archiveCandidateFrame !== "function"
      || typeof readCandidateFrame !== "function") return null;
    const existing = candidatePrefetches.get(candidate);
    if (existing) return existing.promise;
    if (candidatePrefetches.size >= MAX_EAGER_CANDIDATE_PREFETCHES) {
      stats.candidatePrefetchSaturated += 1;
      return startFallbackArchive(target, candidate, fallbackSegment);
    }

    stats.candidatePrefetchStarts += 1;
    const entry = { candidate, promise: null };
    const promise = prefetchOcrCandidate(target, candidate, defaultSignal, fallbackSegment)
      .then((prefetched) => {
        if (!prefetched) return prefetched;
        replaceCandidate(target, candidate, Object.freeze({
          ...candidate,
          prefetchedCapturedAtMs: prefetched.capturedAtMs,
          prefetchedFrames: prefetched.frames,
          expiresAtMs: prefetched.expiresAtMs,
        }));
        return prefetched;
      })
      .catch(() => {
        stats.candidateFrameCaptureErrors += 1;
        return null;
      })
      .finally(() => {
        if (candidatePrefetches.get(candidate) === entry) {
          candidatePrefetches.delete(candidate);
        }
      });
    entry.promise = promise;
    candidatePrefetches.set(candidate, entry);
    return promise;
  }

  async function scanGate(target, { signal = defaultSignal } = {}) {
    signal = normalizeSignal(signal);
    const preserved = pendingCandidateFor(target);
    if (Array.isArray(preserved?.prefetchedFrames) && preserved.prefetchedFrames.length > 0) {
      return {
        duplicate: false,
        uiCandidate: true,
        archivedCandidate: true,
        gateResult: null,
        mediaSequence: preserved.mediaSequence,
        sampleIndex: preserved.sampleIndex,
        sampleCount: preserved.sampleCount,
        candidateIndices: preserved.candidateIndices,
        candidateRuns: preserved.candidateRuns,
        processedSegments: 0,
      };
    }
    const fetchedSegments = await resolveAndFetch(target, "SD", signal);
    throwIfAborted(signal);
    const segments = onlyFreshSegments(target, "SD", fetchedSegments);
    let processedSegments = 0;
    let duplicateSegments = 0;
    let lastGateResult = null;
    let latestProbeFrame = null;
    for (const segment of segments) {
      const segmentHash = contentHashFor(segment);
      if (isContentDuplicate(target, "SD", segmentHash)) {
        stats.duplicateSegments += 1;
        duplicateSegments += 1;
        commitSegment(target, "SD", segment, segmentHash);
        continue;
      }
      const grayFrames = await decodeGrayFrame(segment.body, { signal: signal || undefined });
      throwIfAborted(signal);
      const inspected = inspectGrayFrames(grayFrames);
      const { candidateIndices, candidateRuns, sampleCount: frameCount } = inspected;
      lastGateResult = inspected.lastGateResult;
      commitSegment(target, "SD", segment, segmentHash);
      stats.segmentsProcessed += 1;
      processedSegments += 1;
      latestProbeFrame = {
        mediaSequence: segment.mediaSequence,
        sampleIndex: Math.min(4, frameCount - 1),
        sampleCount: frameCount,
      };
      if (candidateIndices.length > 0) {
        stats.uiCandidates += 1;
        const detectedAtMs = monotonicNow();
        postponeHudProbe(target, detectedAtMs);
        if (Number.isSafeInteger(segment.mediaSequence)) {
          const candidate = Object.freeze({
            mediaSequence: segment.mediaSequence,
            sampleIndex: candidateIndices[0],
            sampleCount: frameCount,
            candidateIndices,
            candidateRuns,
            detectedAtMs,
            expiresAtMs: detectedAtMs + ARCHIVED_CANDIDATE_TTL_MS,
          });
          // normal lane은 SD cursor를 즉시 반환하되, 별도 12-slot prefetch가
          // burst 예약을 기다리지 않고 ORIGINAL 과거 window를 선점한다.
          enqueueCandidate(target, candidate, { fallbackSegment: segment });
        }
        return {
          duplicate: false,
          uiCandidate: true,
          gateResult: inspected.candidateGateResult,
          mediaSequence: segment.mediaSequence,
          sampleIndex: candidateIndices[0],
          sampleCount: frameCount,
          candidateIndices,
          candidateRuns,
          processedSegments,
        };
      }
    }
    const probeNow = monotonicNow();
    if (latestProbeFrame && hudProbeDue(target, probeNow)) {
      const candidateIndices = Object.freeze([latestProbeFrame.sampleIndex]);
      const candidateRuns = candidateRunsFor(candidateIndices);
      stats.hudProbes += 1;
      postponeHudProbe(target, probeNow);
      activeHudProbes.add(target.id);
      if (Number.isSafeInteger(latestProbeFrame.mediaSequence)) {
        enqueueCandidate(target, Object.freeze({
          ...latestProbeFrame,
          candidateIndices,
          candidateRuns,
          hudProbe: true,
          detectedAtMs: probeNow,
          expiresAtMs: probeNow + ARCHIVED_CANDIDATE_TTL_MS,
        }), { eager: false });
      }
      return {
        duplicate: false,
        uiCandidate: true,
        hudProbe: true,
        gateResult: lastGateResult,
        ...latestProbeFrame,
        candidateIndices,
        candidateRuns,
        processedSegments,
      };
    }
    return {
      duplicate: processedSegments === 0,
      uiCandidate: false,
      gateResult: lastGateResult,
      mediaSequence: null,
      processedSegments,
      duplicateSegments,
      noNew: fetchedSegments.length === 0,
    };
  }

  async function fetchBurstSdCursor(target, { signal = defaultSignal } = {}) {
    signal = normalizeSignal(signal);
    if (!usesSegmentBatch) return Object.freeze([]);
    const fetchedSegments = await resolveAndFetch(target, "SD", signal);
    throwIfAborted(signal);
    const previousSequence = lastMediaSequence.get(streamKey(target, "SD"));
    const fetched = [];
    for (const segment of fetchedSegments) {
      let candidateEnqueued = false;
      const isFresh = !Number.isSafeInteger(previousSequence)
        || segment.mediaSequence > previousSequence;
      if (isFresh) {
        const grayFrames = await decodeGrayFrame(segment.body, { signal: signal || undefined });
        throwIfAborted(signal);
        const inspected = inspectGrayFrames(grayFrames);
        stats.burstSdGateSegments += 1;
        if (inspected.candidateIndices.length > 0) {
          const detectedAtMs = monotonicNow();
          const candidate = Object.freeze({
            mediaSequence: segment.mediaSequence,
            sampleIndex: inspected.candidateIndices[0],
            sampleCount: inspected.sampleCount,
            candidateIndices: inspected.candidateIndices,
            candidateRuns: inspected.candidateRuns,
            detectedAtMs,
            expiresAtMs: detectedAtMs + ARCHIVED_CANDIDATE_TTL_MS,
          });
          candidateEnqueued = enqueueCandidate(target, candidate, { fallbackSegment: segment });
          if (candidateEnqueued) {
            stats.uiCandidates += 1;
            stats.burstSdUiCandidates += 1;
            postponeHudProbe(target, detectedAtMs);
          }
        }
      }
      fetched.push(Object.freeze({
        segment: Object.freeze({
          segmentId: segment.segmentId,
          mediaSequence: segment.mediaSequence,
        }),
        segmentHash: contentHashFor(segment),
        candidateEnqueued,
        gateInspected: isFresh,
      }));
    }
    return Object.freeze(fetched);
  }

  function commitBurstSdCursor(target, fetched) {
    if (!Array.isArray(fetched)) fail("invalid_segment", "burst SD batch가 올바르지 않습니다.");
    const freshSegmentIds = new Set(
      onlyFreshSegments(target, "SD", fetched.map(item => item.segment)).map(segment => segment.segmentId),
    );
    let advancedSegments = 0;
    let gateInspectedSegments = 0;
    let candidateSegments = 0;
    for (const { segment, segmentHash, candidateEnqueued, gateInspected } of fetched) {
      if (!freshSegmentIds.has(segment.segmentId)) continue;
      if (gateInspected) gateInspectedSegments += 1;
      if (candidateEnqueued) candidateSegments += 1;
      if (isContentDuplicate(target, "SD", segmentHash)) {
        stats.duplicateSegments += 1;
        commitSegment(target, "SD", segment, segmentHash);
        continue;
      }
      if (commitSegment(target, "SD", segment, segmentHash)) advancedSegments += 1;
    }
    stats.burstSdSegmentsAdvanced += advancedSegments;
    stats.segmentsProcessed += gateInspectedSegments;
    return Object.freeze({ advancedSegments, candidateSegments, gateInspectedSegments });
  }

  async function syncBurstSdCursor(target, { signal = defaultSignal } = {}) {
    const fetched = await fetchBurstSdCursor(target, { signal });
    return commitBurstSdCursor(target, fetched);
  }

  async function scanOcr(target, { initialHiddenFrames = 0, signal = defaultSignal } = {}) {
    signal = normalizeSignal(signal);
    if (!Number.isSafeInteger(initialHiddenFrames)
      || initialHiddenFrames < 0 || initialHiddenFrames > 1) {
      fail("invalid_config", "initialHiddenFrames는 0 또는 1이어야 합니다.");
    }
    let pending = pendingCandidateFor(target);
    const eagerPrefetch = pending
      ? candidatePrefetches.get(pending) || candidateFallbackArchives.get(pending)
      : null;
    if (pending && eagerPrefetch) {
      await eagerPrefetch.promise;
      throwIfAborted(signal);
      pending = pendingCandidateFor(target);
    }
    if (pending && pending.hudProbe !== true
      && (!Array.isArray(pending.prefetchedFrames) || pending.prefetchedFrames.length === 0)) {
      let prefetched = null;
      try {
        prefetched = await prefetchOcrCandidate(target, pending, signal);
      } catch (error) {
        if (signal?.aborted) throw error;
        stats.candidateFrameCaptureErrors += 1;
      }
      if (prefetched) {
        const candidateToReplace = pending;
        const prefetchedCandidate = Object.freeze({
          ...candidateToReplace,
          prefetchedCapturedAtMs: prefetched.capturedAtMs,
          prefetchedFrames: prefetched.frames,
          expiresAtMs: prefetched.expiresAtMs,
        });
        if (replaceCandidate(target, candidateToReplace, prefetchedCandidate)) {
          pending = prefetchedCandidate;
        } else {
          pending = pendingCandidateFor(target);
        }
      }
    }
    const archivedSegments = archivedSegmentsFor(pending);
    const usingArchivedFrames = archivedSegments.length > 0;
    const allFetchedSegments = usingArchivedFrames
      ? archivedSegments
      : await resolveAndFetch(target, OCR_STREAM_QUALITY, signal, {
        // Cold ORIGINAL 복구에서도 전체 playlist window를 다시 받지 않는다.
        // cursor가 있으면 fetcher가 cursor 이후를 우선하므로 후속 burst catch-up은 유지된다.
        initialSegmentCount: Math.min(MAX_PREFETCHED_OCR_SEGMENTS, maxCatchupSegments),
      });
    throwIfAborted(signal);
    const fetchedSegments = usingArchivedFrames
      ? allFetchedSegments
      : onlyFreshSegments(target, OCR_STREAM_QUALITY, allFetchedSegments);
    const pendingSequence = pending?.mediaSequence;
    let segments = fetchedSegments;
    let sequenceMatched = false;
    let sequenceMissed = false;

    if (!usingArchivedFrames
      && Number.isSafeInteger(pendingSequence) && fetchedSegments.length > 0
      && fetchedSegments.every(segment => Number.isSafeInteger(segment.mediaSequence))) {
      const exactIndex = fetchedSegments.findIndex(segment => segment.mediaSequence === pendingSequence);
      if (exactIndex >= 0) {
        sequenceMatched = true;
        for (const skipped of fetchedSegments.slice(0, exactIndex)) {
          commitSegment(target, OCR_STREAM_QUALITY, skipped, contentHashFor(skipped));
        }
        segments = fetchedSegments.slice(exactIndex);
      } else if (fetchedSegments.at(-1).mediaSequence < pendingSequence) {
        for (const skipped of fetchedSegments) {
          commitSegment(target, OCR_STREAM_QUALITY, skipped, contentHashFor(skipped));
        }
        return {
          duplicate: true,
          panelVisible: null,
          observationCount: 0,
          processedSegments: 0,
          gateOnlyHiddenSegments: 0,
          frames: Object.freeze([]),
          consecutiveHiddenFrames: initialHiddenFrames,
          endBurst: false,
          sequenceMatched: false,
          sequenceMissed: false,
          waitingForCandidateSequence: true,
          noNew: false,
        };
      } else {
        sequenceMissed = true;
        stats.candidateSequenceMisses += 1;
      }
    }

    const frames = [];
    let observationCount = 0;
    let duplicateSegments = 0;
    let processedSegments = 0;
    let gateOnlyHiddenSegments = 0;
    let consecutiveHiddenFrames = initialHiddenFrames;
    let endBurst = false;
    for (const segment of segments) {
      let hudSegmentCountedAsHidden = false;
      const segmentHash = usingArchivedFrames
        ? segment.archivedFrames[0].segmentHash
        : contentHashFor(segment);
      if (!usingArchivedFrames && isContentDuplicate(target, OCR_STREAM_QUALITY, segmentHash)) {
        stats.duplicateSegments += 1;
        duplicateSegments += 1;
        commitSegment(target, OCR_STREAM_QUALITY, segment, segmentHash);
        if (Number.isSafeInteger(pendingSequence)
          && Number.isSafeInteger(segment.mediaSequence)
          && segment.mediaSequence >= pendingSequence) {
          advancePendingCandidate(target, pending);
        }
        continue;
      }
      let sampleIndices = [null];
      let mustEvaluateAllCandidateSamples = false;
      let gateOnlyHidden = false;
      const isExactCandidateSegment = sequenceMatched && segment.mediaSequence === pendingSequence;
      if (usingArchivedFrames && segment.archivedFrames.length > 0) {
        sampleIndices = segment.archivedFrames.map(frame => frame.sampleIndex);
        mustEvaluateAllCandidateSamples = true;
      } else if (isExactCandidateSegment) {
        const plannedSamples = candidateOcrSampleIndices(pending);
        if (plannedSamples.length > 0) {
          sampleIndices = pending.hudProbe === true ? plannedSamples.slice(0, 1) : plannedSamples;
          mustEvaluateAllCandidateSamples = true;
        }
      } else if (profileId === HUD_COMBAT_PROFILE_ID && activeHudProbes.has(target.id)) {
        // A periodic HUD probe deliberately bypasses the generic panel gate for
        // one sample of the next segment so maxHealth can receive independent
        // segment evidence without opening a sustained OCR burst.
        sampleIndices = [usesSegmentBatch ? 4 : null];
        mustEvaluateAllCandidateSamples = true;
      } else if (usesSegmentBatch) {
        const grayFrames = await decodeGrayFrame(segment.body, { signal: signal || undefined });
        throwIfAborted(signal);
        const inspected = inspectGrayFrames(grayFrames);
        if (inspected.candidateIndices.length > 0) {
          sampleIndices = candidateOcrSampleIndices(inspected);
          mustEvaluateAllCandidateSamples = true;
        } else {
          sampleIndices = [];
          gateOnlyHidden = true;
        }
      }

      if (gateOnlyHidden) {
        gateOnlyHiddenSegments += 1;
        consecutiveHiddenFrames += 1;
        if (consecutiveHiddenFrames >= 2) endBurst = true;
      }

      for (const sampleIndex of sampleIndices) {
        const archivedFrame = usingArchivedFrames
          ? segment.archivedFrames.find(frame => frame.sampleIndex === sampleIndex)
          : null;
        let png;
        if (archivedFrame) {
          try {
            png = await readCandidateFrame(archivedFrame.archiveRef);
            stats.candidateFramesLoaded += 1;
          } catch (error) {
            stats.candidateFrameReadErrors += 1;
            throw error;
          }
        } else {
          png = await decodePngFrame(segment.body, {
            ...(Number.isSafeInteger(sampleIndex) ? { sampleIndex } : {}),
            signal: signal || undefined,
          });
        }
        throwIfAborted(signal);
        if (!Buffer.isBuffer(png) || png.length < 8
          || !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
          fail("invalid_png_frame", "OCR frame이 PNG 형식이 아닙니다.");
        }
        const pngHash = sha256(png);
        const sampleKey = Number.isSafeInteger(sampleIndex) ? String(sampleIndex) : "mid";
        const evidenceHash = sha256(`${segmentHash}:${sampleKey}:${pngHash}`);
        const observedAtMs = Number.isSafeInteger(archivedFrame?.observedAtMs)
          ? archivedFrame.observedAtMs
          : monotonicNow();
        const observedAt = new Date(observedAtMs).toISOString();
        stats.ocrRuns += 1;
        throwIfAborted(signal);
        const output = await runOcr(png, Object.freeze({
          playerId: target.playerId,
          targetId: target.id,
          bjId: target.bjId,
          observedAt,
        }), { signal: signal || undefined });
        throwIfAborted(signal);
        const batch = normalizeBatch(output, profileId);
        const burstVisible = keepsOcrBurstAlive(batch);
        if (profileId === HUD_COMBAT_PROFILE_ID) {
          if (burstVisible) activeHudProbes.delete(target.id);
          else if (batch.results.some(result => (
            result.field === "maxHealth" || result.field === "horseMaxHealth"
          ))) {
            activeHudProbes.add(target.id);
          }
        }
        const observations = flattenBroadcastBatch(batch, {
          profileId,
          seasonId: CURRENT_SEASON_ID,
          playerId: target.playerId,
          sourceId: `screen:${target.playerId}:${observedAtMs}:${segmentHash.slice(0, 16)}:${sampleKey}`,
          sourceUrl: target.sourceUrl,
          observedAt,
          collectedAt: observedAt,
          evidenceHash,
        }, { now: observedAtMs });

        if (observations.length > 0) {
          tracker.observeBatch(observations, {
            now: observedAtMs,
            onConfirmed: (confirmed) => {
              const result = appendFn(queuePath, confirmed, { now: observedAtMs });
              if (result && typeof result.then === "function") return result;
              stats.confirmedChanges += confirmed.length;
              stats.queuedObservations += result?.inserted?.length ?? confirmed.length;
              for (const observation of confirmed) {
                const confirmedAtMs = normalizedObservedAtMs(observation.observedAt);
                localStableOverlays.set(baselineKey(observation.playerId, observation.field), {
                  playerId: observation.playerId,
                  field: observation.field,
                  value: observation.value,
                  valueKey: baselineValueKey(observation.value),
                  observedAtMs: confirmedAtMs,
                });
              }
              return result;
            },
          });
        }
        throwIfAborted(signal);
        observationCount += observations.length;
        frames.push(Object.freeze({
          mediaSequence: segment.mediaSequence,
          sampleIndex,
          panelVisible: batch.panelVisible,
          burstVisible,
          observationCount: observations.length,
        }));
        if (burstVisible) {
          consecutiveHiddenFrames = 0;
          if (usingArchivedFrames) endBurst = false;
          hudSegmentCountedAsHidden = false;
        } else if (profileId === HUD_COMBAT_PROFILE_ID) {
          // Adjacent samples from one HLS segment are one evidence unit. Count
          // HUD-only/hidden samples once per segment so the next segment can
          // still provide the independent confirmation required by tracker.
          if (!hudSegmentCountedAsHidden) {
            consecutiveHiddenFrames += 1;
            hudSegmentCountedAsHidden = true;
          }
        } else if (batch.panelVisible === false) {
          consecutiveHiddenFrames += 1;
        }
        if (consecutiveHiddenFrames >= 2 && !mustEvaluateAllCandidateSamples) {
          endBurst = true;
          break;
        }
      }
      if (mustEvaluateAllCandidateSamples && consecutiveHiddenFrames >= 2) endBurst = true;
      throwIfAborted(signal);
      commitSegment(target, OCR_STREAM_QUALITY, segment, segmentHash);
      stats.segmentsProcessed += 1;
      processedSegments += 1;
      if (Number.isSafeInteger(pendingSequence)
        && !usingArchivedFrames
        && Number.isSafeInteger(segment.mediaSequence)
        && segment.mediaSequence >= pendingSequence) {
        advancePendingCandidate(target, pending);
      }
      // 보존 ring은 후보 앞쪽의 숨김 frame이 먼저 올 수 있다. 저장된 window를
      // 끝까지 확인해야 뒤쪽에 잠깐 나타난 실제 panel을 놓치지 않는다.
      if (endBurst && !usingArchivedFrames) break;
    }

    if (usingArchivedFrames) advancePendingCandidate(target, pending);

    const visibleFrames = frames.filter(frame => frame.panelVisible === true).length;
    const hiddenFrames = frames.filter(frame => frame.panelVisible === false).length;
    return {
      duplicate: frames.length === 0 && gateOnlyHiddenSegments === 0,
      panelVisible: visibleFrames > 0
        ? true
        : ((hiddenFrames > 0 || gateOnlyHiddenSegments > 0) ? false : null),
      observationCount,
      processedSegments,
      duplicateSegments,
      gateOnlyHiddenSegments,
      frames: Object.freeze(frames),
      consecutiveHiddenFrames: Math.min(consecutiveHiddenFrames, 2),
      endBurst,
      sequenceMatched,
      sequenceMissed,
      waitingForCandidateSequence: false,
      noNew: allFetchedSegments.length === 0,
    };
  }

  async function executeTask(task, { signal = defaultSignal } = {}) {
    signal = normalizeSignal(signal);
    if (task.lane === "burst" && ocrEnabled) {
      try {
        const [ocrResult, sdSyncResult] = await Promise.allSettled([
          scanOcr(task.target, {
            initialHiddenFrames: hiddenBurstFrames.get(task.target.id) || 0,
            signal,
          }),
          fetchBurstSdCursor(task.target, { signal }),
        ]);
        if (sdSyncResult.status === "rejected") {
          if (signal?.aborted) throw sdSyncResult.reason;
          stats.burstSdSyncErrors += 1;
        }
        if (ocrResult.status === "rejected") throw ocrResult.reason;
        const sdCursor = sdSyncResult.status === "fulfilled"
          ? commitBurstSdCursor(task.target, sdSyncResult.value)
          : null;
        const ocr = ocrResult.value;
        const visibleFrames = ocr.frames.filter(frame => frame.burstVisible === true).length;
        if (visibleFrames > 0) stats.confirmedUiPanels += visibleFrames;
        if (ocr.endBurst) {
          hiddenBurstFrames.delete(task.target.id);
          const nextCandidate = pendingCandidateFor(task.target);
          if (nextCandidate) {
            return {
              live: true,
              uiCandidate: true,
              ocr,
              sdCursor,
              continuedForQueuedCandidate: true,
            };
          }
          activeHudProbes.delete(task.target.id);
          stats.earlyBurstEnds += 1;
          return { live: true, uiCandidate: false, endBurst: true, ocr };
        }
        if (ocr.consecutiveHiddenFrames > 0) {
          hiddenBurstFrames.set(task.target.id, ocr.consecutiveHiddenFrames);
        } else if (visibleFrames > 0) {
          hiddenBurstFrames.delete(task.target.id);
        }
        const nextCandidate = pendingCandidateFor(task.target);
        return {
          live: true,
          uiCandidate: visibleFrames > 0 || Boolean(nextCandidate),
          ocr,
          sdCursor,
        };
      } catch (error) {
        const errorCode = safeErrorCode(error);
        if ((errorCode === "aborted" || errorCode === "task_deadline") && signal?.aborted) throw error;
        if (errorCode === "not_live") {
          resetTargetProgress(task.target);
          return { live: false };
        }
        stats.ocrErrors += 1;
        stats.lastErrorCode = safeErrorCode(error, "ocr_failed");
        stats.lastErrorAt = monotonicNow();
        throw error;
      }
    }

    // ORIGINAL은 candidate burst에서만 관측한다. normal 구간을 건너뛴
    // sequence를 실제 누락으로 합산하지 않도록 다음 burst의 기준을 새로 잡는다.
    if (usesSegmentBatch) resetStreamProgress(task.target, OCR_STREAM_QUALITY);
    const gateResult = await scanGate(task.target, { signal });
    const uiCandidate = ocrEnabled && gateResult.uiCandidate;
    if (!uiCandidate) {
      hiddenBurstFrames.delete(task.target.id);
      clearTargetCandidates(task.target);
      activeHudProbes.delete(task.target.id);
    }
    return { live: true, uiCandidate, gate: gateResult };
  }

  async function runTask(task, { signal = defaultSignal } = {}) {
    const parentSignal = normalizeSignal(signal);
    const abortScope = createTaskAbortScope(task, parentSignal);
    stats.tasks += 1;
    let result;
    let taskError = null;
    try {
      result = await Promise.race([
        executeTask(task, { signal: abortScope.signal }),
        abortScope.cancellation,
      ]);
      throwIfAborted(abortScope.signal);
    } catch (error) {
      taskError = error;
    } finally {
      abortScope.dispose();
    }
    if (taskError) {
      const abortKind = abortScope.abortKind();
      const errorCode = abortKind === "deadline" ? "task_deadline" : safeErrorCode(taskError);
      if (abortKind === "parent" || (errorCode === "aborted" && parentSignal?.aborted)) {
        try {
          return scheduler.cancelTask(task.taskId, monotonicNow());
        } catch (cancelError) {
          if (safeErrorCode(cancelError) !== "unknown_task") throw cancelError;
          return null;
        }
      }
      if (errorCode === "not_live") {
        resetTargetProgress(task.target);
        result = { live: false };
      } else {
        result = { ok: false, errorCode };
        stats.lastErrorCode = result.errorCode;
        stats.lastErrorAt = monotonicNow();
      }
    }
    if (result.ok === false) stats.failures += 1;
    else if (result.live) stats.liveResults += 1;
    else stats.offlineResults += 1;
    try {
      return scheduler.applyResult(task.taskId, result, monotonicNow());
    } catch (error) {
      if (safeErrorCode(error) !== "expired_task" && safeErrorCode(error) !== "unknown_task") throw error;
      return null;
    }
  }

  function dispatch(now = monotonicNow(), { signal = defaultSignal } = {}) {
    signal = normalizeSignal(signal);
    const availableSlots = Math.max(0, maxActiveTasks - active.size);
    const tasks = scheduler.selectDue(now, {
      expireLeases: false,
      limit: availableSlots,
    });
    const promises = tasks.map((task) => {
      const promise = runTask(task, { signal });
      active.add(promise);
      promise.then(
        () => active.delete(promise),
        () => active.delete(promise),
      );
      return promise;
    });
    return Object.freeze({ tasks, promises });
  }

  async function runLoop(signal, { pollMs = 50 } = {}) {
    signal = normalizeSignal(signal);
    if (!signal) fail("invalid_signal", "AbortSignal이 필요합니다.");
    if (!Number.isSafeInteger(pollMs) || pollMs < 10 || pollMs > 1_000) {
      fail("invalid_config", "pollMs는 10~1000 정수여야 합니다.");
    }
    while (!signal.aborted) {
      dispatch(monotonicNow(), { signal });
      if (active.size === 0) {
        await abortableDelay(pollMs, signal);
      } else {
        await Promise.race([abortableDelay(pollMs, signal), ...active]);
      }
    }
    await Promise.allSettled([
      ...active,
      ...[...candidatePrefetches.values()].map(entry => entry.promise),
      ...[...candidateFallbackArchives.values()].map(entry => entry.promise),
    ]);
  }

  function refreshBaselines(baselines, now = monotonicNow()) {
    if (!ocrEnabled || !Array.isArray(baselines)) {
      fail("invalid_config", "OCR baseline 갱신에는 baseline 배열이 필요합니다.");
    }
    const nextDigest = baselineDigest(baselines, trackedBaselineKeys);
    if (nextDigest === currentBaselineDigest) {
      return Object.freeze({ changed: false, count: baselines.length });
    }
    const merged = [];
    const included = new Set();
    const overlaysToRemove = [];
    let preserved = 0;
    for (const baseline of baselines) {
      const key = baselineKey(baseline.playerId, baseline.field);
      const nextValueKey = baselineValueKey(baseline.value);
      const local = localStableOverlays.get(key);
      included.add(key);
      const sheetTime = baselineObservedAtState(baselines, key);
      const sheetSupersedes = local
        && sheetSupersedesOverlay(local, sheetTime, true);
      if (local && local.valueKey !== nextValueKey && !sheetSupersedes) {
        merged.push({ playerId: local.playerId, field: local.field, value: local.value });
        preserved += 1;
        continue;
      }
      if (local && sheetSupersedes) overlaysToRemove.push(key);
      merged.push(baseline);
    }
    for (const [key, local] of localStableOverlays) {
      if (included.has(key)) continue;
      const sheetTime = baselineObservedAtState(baselines, key);
      if (sheetSupersedesOverlay(local, sheetTime, false)) {
        overlaysToRemove.push(key);
        continue;
      }
      merged.push({ playerId: local.playerId, field: local.field, value: local.value });
      preserved += 1;
    }
    if (typeof tracker.reconcileStable === "function") {
      tracker.reconcileStable(merged, { now });
    } else {
      tracker.initializeStable(merged, { now });
    }
    for (const key of overlaysToRemove) localStableOverlays.delete(key);
    currentBaselineDigest = nextDigest;
    stats.baselineRefreshes += 1;
    stats.baselineOverlayPreserved += preserved;
    stats.lastBaselineRefreshAt = now;
    return Object.freeze({
      changed: true,
      count: baselines.length,
      applied: merged.length - preserved,
      preserved,
    });
  }

  function getSnapshot(now = monotonicNow()) {
    let candidateFramesPending = 0;
    let candidateQueueDepth = 0;
    for (const target of targets) {
      const pending = pendingCandidateFor(target, now);
      candidateFramesPending += Array.isArray(pending?.prefetchedFrames)
        ? pending.prefetchedFrames.length
        : 0;
      const queue = queuedCandidates.get(target.id) || [];
      candidateQueueDepth += queue.length;
      for (const candidate of queue) {
        candidateFramesPending += Array.isArray(candidate?.prefetchedFrames)
          ? candidate.prefetchedFrames.length
          : 0;
      }
    }
    return Object.freeze({
      ocrEnabled,
      activeTasks: active.size,
      maxActiveTasks,
      stats: Object.freeze({
        ...stats,
        candidateFramesPending,
        candidateQueueDepth,
        candidatePrefetchesActive: candidatePrefetches.size,
        candidateFallbackArchivesActive: candidateFallbackArchives.size,
      }),
      scheduler: scheduler.getSnapshot(now),
    });
  }

  return Object.freeze({
    dispatch,
    executeTask,
    getSnapshot,
    refreshBaselines,
    runLoop,
    runTask,
    scanGate,
    scanOcr,
    syncBurstSdCursor,
    scheduler,
    targets,
  });
}

module.exports = {
  DEFAULT_SCHEDULER_OPTIONS,
  DEFAULT_HUD_PROBE_INTERVAL_MS,
  MAX_TARGETS,
  OCR_STREAM_QUALITY,
  SamgukHlsMonitorError,
  abortableDelay,
  buildFallbackBaselines,
  buildBaselinesFromMembers,
  buildFallbackTargets,
  createSamgukHlsMonitor,
  normalizeTargets,
  safeErrorCode,
};
