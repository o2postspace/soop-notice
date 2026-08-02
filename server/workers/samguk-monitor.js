#!/usr/bin/env node
"use strict";

// 방송 화면은 권리자/플랫폼 허용 범위에서만 관측한다. 이 worker는 명시적으로
// 활성화하기 전에는 파일 생성, SOOP 조회, 화면 캡처를 전혀 하지 않는다.
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const {
  ALLOWED_FIELDS,
  MIN_BROADCAST_CONFIDENCE,
  PLAYER_ID_PATTERN,
  appendObservationQueue,
  normalizeObservation,
  sourceHostAllowed,
} = require("../lib/samguk-observations");

const DEFAULT_IDLE_POLL_MS = 60_000;
const DEFAULT_LIVE_POLL_MS = 15_000;
const DEFAULT_CAPTURE_TIMEOUT_MS = 8_000;
const DEFAULT_OCR_TIMEOUT_MS = 5_000;
const DEFAULT_OCR_MAX_OUTPUT_BYTES = 4_096;
const DEFAULT_MAX_CROP_BYTES = 20 * 1024 * 1024;
const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_CROP_RETENTION_MS = 5 * 60_000;
const MAX_TARGETS = 20;
const MAX_ROIS_PER_TARGET = 20;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const BJ_ID_PATTERN = /^[A-Za-z0-9_]{1,30}$/;
const DISPLAY_PATTERN = /^:\d+(?:\.\d+)?$/;
const TEMPLATE_PATTERN = /\{([A-Za-z][A-Za-z0-9]*)\}/g;
const TEMPLATE_KEYS = new Set(["input", "field", "playerId", "targetId", "roiId"]);
const SOOP_LIVE_HEADERS = Object.freeze({
  Referer: "https://www.sooplive.co.kr/",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  Accept: "application/json",
});

class SamgukMonitorError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SamgukMonitorError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new SamgukMonitorError(code, message);
}

function integerInRange(value, fallback, min, max, label) {
  const candidate = value === undefined || value === null ? fallback : value;
  if (!Number.isInteger(candidate) || candidate < min || candidate > max) {
    fail("invalid_config", `${label}은(는) ${min} 이상 ${max} 이하의 정수여야 합니다.`);
  }
  return candidate;
}

function numberInRange(value, fallback, min, max, label) {
  const candidate = value === undefined || value === null ? fallback : value;
  if (typeof candidate !== "number" || !Number.isFinite(candidate) || candidate < min || candidate > max) {
    fail("invalid_config", `${label}은(는) ${min} 이상 ${max} 이하의 숫자여야 합니다.`);
  }
  return candidate;
}

function strictKeys(value, allowed, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid_config", `${label}은(는) 객체여야 합니다.`);
  }
  const unexpected = Object.keys(value).filter(key => !allowed.has(key));
  if (unexpected.length > 0) {
    fail("invalid_config", `${label}에 허용되지 않은 항목이 있습니다: ${unexpected.join(", ")}`);
  }
}

function nonemptyString(value, label, pattern = null) {
  if (typeof value !== "string" || !value.trim()) {
    fail("invalid_config", `${label}이(가) 필요합니다.`);
  }
  const normalized = value.normalize("NFKC").trim();
  if (pattern && !pattern.test(normalized)) fail("invalid_config", `${label} 형식이 올바르지 않습니다.`);
  return normalized;
}

function absoluteCommand(value, label) {
  const command = nonemptyString(value, label);
  if (!path.isAbsolute(command) || command.includes("\u0000")) {
    fail("invalid_config", `${label}은(는) 절대 경로여야 합니다.`);
  }
  return path.normalize(command);
}

function normalizeSourceUrl(value) {
  let parsed;
  try {
    parsed = new URL(nonemptyString(value, "target.sourceUrl"));
  } catch (error) {
    if (error instanceof SamgukMonitorError) throw error;
    fail("invalid_config", "target.sourceUrl 형식이 올바르지 않습니다.");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password
    || !sourceHostAllowed("broadcast", parsed.hostname.toLowerCase())) {
    fail("invalid_config", "target.sourceUrl은 인증정보가 없는 SOOP HTTPS URL이어야 합니다.");
  }
  parsed.hostname = parsed.hostname.toLowerCase();
  return parsed.toString();
}

function normalizeOcrConfig(input = {}) {
  strictKeys(input, new Set(["command", "args", "timeoutMs", "maxOutputBytes", "minConfidence"]), "ocr");
  const args = input.args === undefined ? ["--input", "{input}", "--field", "{field}"] : input.args;
  if (!Array.isArray(args) || args.length === 0 || args.length > 40
    || args.some(arg => typeof arg !== "string" || arg.length > 512 || arg.includes("\u0000"))) {
    fail("invalid_config", "ocr.args는 1~40개의 문자열 인자여야 합니다.");
  }
  for (const arg of args) {
    for (const match of arg.matchAll(TEMPLATE_PATTERN)) {
      if (!TEMPLATE_KEYS.has(match[1])) {
        fail("invalid_config", `ocr.args에 알 수 없는 template이 있습니다: {${match[1]}}`);
      }
    }
  }
  if (!args.some(arg => arg.includes("{input}"))) {
    fail("invalid_config", "ocr.args에는 {input} template이 필요합니다.");
  }
  return {
    command: absoluteCommand(input.command, "ocr.command"),
    args: [...args],
    timeoutMs: integerInRange(input.timeoutMs, DEFAULT_OCR_TIMEOUT_MS, 250, 30_000, "ocr.timeoutMs"),
    maxOutputBytes: integerInRange(
      input.maxOutputBytes,
      DEFAULT_OCR_MAX_OUTPUT_BYTES,
      128,
      64 * 1024,
      "ocr.maxOutputBytes",
    ),
    minConfidence: numberInRange(
      input.minConfidence,
      MIN_BROADCAST_CONFIDENCE,
      MIN_BROADCAST_CONFIDENCE,
      1,
      "ocr.minConfidence",
    ),
  };
}

function normalizeRoi(input, index) {
  strictKeys(
    input,
    new Set(["id", "field", "x", "y", "width", "height"]),
    `roi[${index}]`,
  );
  const field = nonemptyString(input.field, `roi[${index}].field`);
  if (!ALLOWED_FIELDS.includes(field)) {
    fail("invalid_config", `roi[${index}].field가 허용된 관측 필드가 아닙니다.`);
  }
  const width = integerInRange(input.width, undefined, 1, 4_096, `roi[${index}].width`);
  const height = integerInRange(input.height, undefined, 1, 4_096, `roi[${index}].height`);
  if (width * height > 4_000_000) fail("invalid_config", `roi[${index}] 영역이 너무 큽니다.`);
  return {
    id: nonemptyString(input.id, `roi[${index}].id`, ID_PATTERN),
    field,
    x: integerInRange(input.x, undefined, 0, 16_384, `roi[${index}].x`),
    y: integerInRange(input.y, undefined, 0, 16_384, `roi[${index}].y`),
    width,
    height,
  };
}

function normalizeTarget(input, index, livePollMs) {
  strictKeys(
    input,
    new Set(["id", "enabled", "playerId", "bjId", "sourceUrl", "sampleIntervalMs", "rois"]),
    `target[${index}]`,
  );
  if (typeof input.enabled !== "boolean") {
    fail("invalid_config", `target[${index}].enabled는 boolean이어야 합니다.`);
  }
  if (!Array.isArray(input.rois) || input.rois.length === 0 || input.rois.length > MAX_ROIS_PER_TARGET) {
    fail("invalid_config", `target[${index}].rois는 1~${MAX_ROIS_PER_TARGET}개여야 합니다.`);
  }
  const rois = input.rois.map(normalizeRoi);
  if (new Set(rois.map(roi => roi.id)).size !== rois.length) {
    fail("invalid_config", `target[${index}] 안의 roi id가 중복되었습니다.`);
  }
  return {
    id: nonemptyString(input.id, `target[${index}].id`, ID_PATTERN),
    enabled: input.enabled,
    playerId: nonemptyString(input.playerId, `target[${index}].playerId`, PLAYER_ID_PATTERN),
    bjId: nonemptyString(input.bjId, `target[${index}].bjId`, BJ_ID_PATTERN),
    sourceUrl: normalizeSourceUrl(input.sourceUrl),
    sampleIntervalMs: integerInRange(
      input.sampleIntervalMs,
      livePollMs,
      livePollMs,
      60 * 60_000,
      `target[${index}].sampleIntervalMs`,
    ),
    rois,
  };
}

function normalizeMonitorConfig(input) {
  strictKeys(
    input,
    new Set([
      "version", "permissionConfirmed", "display", "ffmpegPath", "idlePollMs", "livePollMs",
      "captureTimeoutMs", "cropRetentionMs", "ocr", "targets",
    ]),
    "config",
  );
  if (input.version !== 1) fail("invalid_config", "config.version은 1이어야 합니다.");
  if (typeof input.permissionConfirmed !== "boolean") {
    fail("invalid_config", "permissionConfirmed는 boolean이어야 합니다.");
  }
  const idlePollMs = integerInRange(input.idlePollMs, DEFAULT_IDLE_POLL_MS, 15_000, 10 * 60_000, "idlePollMs");
  const livePollMs = integerInRange(input.livePollMs, DEFAULT_LIVE_POLL_MS, 5_000, 5 * 60_000, "livePollMs");
  if (livePollMs > idlePollMs) fail("invalid_config", "livePollMs는 idlePollMs보다 클 수 없습니다.");
  if (!Array.isArray(input.targets) || input.targets.length > MAX_TARGETS) {
    fail("invalid_config", `targets는 최대 ${MAX_TARGETS}개인 배열이어야 합니다.`);
  }
  const targets = input.targets.map((target, index) => normalizeTarget(target, index, livePollMs));
  if (new Set(targets.map(target => target.id)).size !== targets.length) {
    fail("invalid_config", "target id가 중복되었습니다.");
  }
  return {
    version: 1,
    permissionConfirmed: input.permissionConfirmed,
    display: nonemptyString(input.display ?? ":0.0", "display", DISPLAY_PATTERN),
    ffmpegPath: absoluteCommand(input.ffmpegPath ?? "/usr/bin/ffmpeg", "ffmpegPath"),
    idlePollMs,
    livePollMs,
    captureTimeoutMs: integerInRange(
      input.captureTimeoutMs,
      DEFAULT_CAPTURE_TIMEOUT_MS,
      500,
      30_000,
      "captureTimeoutMs",
    ),
    cropRetentionMs: integerInRange(
      input.cropRetentionMs,
      0,
      0,
      MAX_CROP_RETENTION_MS,
      "cropRetentionMs",
    ),
    ocr: normalizeOcrConfig(input.ocr),
    targets,
  };
}

function loadMonitorConfig(filePath) {
  const resolved = path.resolve(nonemptyString(filePath, "SAMGUK_MONITOR_CONFIG"));
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_CONFIG_BYTES) {
    fail("invalid_config", "monitor config는 64KiB 이하의 일반 파일이어야 합니다.");
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(resolved, "utf8"));
  } catch {
    fail("invalid_config", "monitor config JSON을 읽을 수 없습니다.");
  }
  return normalizeMonitorConfig(parsed);
}

function isMonitorEnabled(env = process.env) {
  return env.SAMGUK_MONITOR_ENABLED === "1";
}

function activeTargets(config) {
  return config.targets.filter(target => target.enabled);
}

function assertActivationAllowed(config) {
  if (!config.permissionConfirmed) {
    fail("permission_required", "방송 관측 권한을 확인한 뒤 permissionConfirmed를 true로 설정하세요.");
  }
  if (activeTargets(config).length === 0) {
    fail("no_targets", "활성화된 target이 없습니다.");
  }
}

function restrictedEnv(env = process.env) {
  return Object.fromEntries([
    "PATH", "LANG", "LC_ALL", "XAUTHORITY",
  ].filter(key => typeof env[key] === "string").map(key => [key, env[key]]));
}

function execFileText(command, args, options = {}, execFileImpl = execFile) {
  return new Promise((resolve, reject) => {
    execFileImpl(command, args, {
      shell: false,
      windowsHide: true,
      encoding: "utf8",
      ...options,
    }, (error, stdout) => {
      if (error) {
        const reason = error.code === "ETIMEDOUT" || error.killed ? "timeout" : (error.code || "failed");
        reject(new SamgukMonitorError("command_failed", `외부 명령 실행에 실패했습니다: ${reason}`));
        return;
      }
      resolve(stdout || "");
    });
  });
}

async function captureRoi({ ffmpegPath, display, captureTimeoutMs, roi, outputPath }, options = {}) {
  const args = [
    "-nostdin", "-hide_banner", "-loglevel", "error", "-threads", "1",
    "-f", "x11grab", "-draw_mouse", "0",
    "-video_size", `${roi.width}x${roi.height}`,
    "-i", `${display}+${roi.x},${roi.y}`,
    "-frames:v", "1", "-compression_level", "9", "-y", outputPath,
  ];
  await execFileText(ffmpegPath, args, {
    timeout: captureTimeoutMs,
    maxBuffer: 64 * 1024,
    env: restrictedEnv(options.env),
  }, options.execFileImpl);
  const stat = fs.statSync(outputPath);
  if (!stat.isFile() || stat.size === 0 || stat.size > DEFAULT_MAX_CROP_BYTES) {
    fail("invalid_crop", "ROI crop 결과가 비어 있거나 너무 큽니다.");
  }
  fs.chmodSync(outputPath, 0o600);
  return outputPath;
}

function renderOcrArgs(args, context) {
  return args.map(arg => arg.replace(TEMPLATE_PATTERN, (_whole, key) => String(context[key])));
}

function parseOcrOutput(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    fail("invalid_ocr_output", "OCR adapter는 JSON 한 개만 stdout에 출력해야 합니다.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail("invalid_ocr_output", "OCR 결과는 JSON 객체여야 합니다.");
  }
  const unexpected = Object.keys(parsed).filter(key => key !== "value" && key !== "confidence");
  if (unexpected.length > 0) {
    fail("invalid_ocr_output", `OCR 결과에 허용되지 않은 항목이 있습니다: ${unexpected.join(", ")}`);
  }
  if (!("value" in parsed) || !("confidence" in parsed)) {
    fail("invalid_ocr_output", "OCR 결과에는 value와 confidence가 필요합니다.");
  }
  if (typeof parsed.confidence !== "number" || !Number.isFinite(parsed.confidence)
    || parsed.confidence < 0 || parsed.confidence > 1) {
    fail("invalid_ocr_output", "OCR confidence는 0 이상 1 이하의 숫자여야 합니다.");
  }
  return { value: parsed.value, confidence: parsed.confidence };
}

async function runOcrAdapter(ocr, context, options = {}) {
  const stdout = await execFileText(
    ocr.command,
    renderOcrArgs(ocr.args, context),
    {
      timeout: ocr.timeoutMs,
      maxBuffer: ocr.maxOutputBytes,
      env: restrictedEnv(options.env),
    },
    options.execFileImpl,
  );
  return parseOcrOutput(stdout);
}

function createSoopLiveChecker(options = {}) {
  const fetchImpl = options.fetchImpl || ((...args) => fetch(...args));
  const timeoutMs = options.timeoutMs || 5_000;
  return async function getLiveStatus(bjId) {
    if (!BJ_ID_PATTERN.test(bjId)) fail("invalid_bj_id", "BJ ID 형식이 올바르지 않습니다.");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`https://chapi.sooplive.co.kr/api/${bjId}/station`, {
        headers: SOOP_LIVE_HEADERS,
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`SOOP HTTP ${response.status}`);
      const data = await response.json();
      return Boolean(data && data.broad);
    } finally {
      clearTimeout(timeout);
    }
  };
}

function hashFile(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function safeSegment(value) {
  return value.replace(/[^A-Za-z0-9_.-]/g, "_");
}

function cleanupExpiredCrops(directory, retentionMs, now = Date.now()) {
  if (!fs.existsSync(directory)) return 0;
  let removed = 0;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".png")) continue;
    const filePath = path.join(directory, entry.name);
    const stat = fs.lstatSync(filePath);
    if (!stat.isSymbolicLink() && now - stat.mtimeMs >= retentionMs) {
      fs.rmSync(filePath, { force: true });
      removed += 1;
    }
  }
  return removed;
}

function createMonitor(options) {
  const config = options.config;
  const queuePath = path.resolve(options.queuePath);
  const stateDir = path.resolve(options.stateDir);
  const cropsDir = path.join(stateDir, "crops");
  const getLiveStatus = options.getLiveStatus || createSoopLiveChecker();
  const captureRoiFn = options.captureRoiFn || captureRoi;
  const runOcrFn = options.runOcrFn || runOcrAdapter;
  const appendFn = options.appendFn || appendObservationQueue;
  const now = options.now || Date.now;
  const randomId = options.randomId || (() => crypto.randomBytes(4).toString("hex"));
  const logger = options.logger || console;
  const lastLive = new Map();
  const lastSampleAt = new Map();

  fs.mkdirSync(cropsDir, { recursive: true, mode: 0o700 });

  async function observeRoi(target, roi, observedAtMs) {
    const frameId = `${safeSegment(target.id)}-${safeSegment(roi.id)}-${observedAtMs}-${safeSegment(randomId())}`;
    const cropPath = path.join(cropsDir, `${frameId}.png`);
    let keepUntilCleanup = false;
    try {
      await captureRoiFn({
        ffmpegPath: config.ffmpegPath,
        display: config.display,
        captureTimeoutMs: config.captureTimeoutMs,
        roi,
        outputPath: cropPath,
      });
      const evidenceHash = hashFile(cropPath);
      const ocr = await runOcrFn(config.ocr, {
        input: cropPath,
        field: roi.field,
        playerId: target.playerId,
        targetId: target.id,
        roiId: roi.id,
      });
      if (ocr.confidence < config.ocr.minConfidence) return { appended: false, reason: "low_confidence" };

      const timestamp = new Date(observedAtMs).toISOString();
      const observation = normalizeObservation({
        playerId: target.playerId,
        field: roi.field,
        value: ocr.value,
        sourceType: "broadcast",
        sourceId: `screen:${frameId}`,
        sourceUrl: target.sourceUrl,
        observedAt: timestamp,
        collectedAt: timestamp,
        evidenceHash,
        ocrConfidence: ocr.confidence,
      }, { now: observedAtMs });
      const result = appendFn(queuePath, observation, { now: observedAtMs });
      keepUntilCleanup = config.cropRetentionMs > 0;
      return { appended: result.inserted.length > 0, observation };
    } finally {
      if (!keepUntilCleanup) fs.rmSync(cropPath, { force: true });
    }
  }

  async function runCycle() {
    const cycleTime = now();
    cleanupExpiredCrops(cropsDir, config.cropRetentionMs, cycleTime);
    let liveCount = 0;
    let capturedCount = 0;
    let appendedCount = 0;

    for (const target of activeTargets(config)) {
      let isLive;
      try {
        isLive = await getLiveStatus(target.bjId);
        lastLive.set(target.id, isLive);
      } catch (error) {
        isLive = lastLive.get(target.id) || false;
        logger.warn?.(`[samguk-monitor] LIVE 조회 실패: ${target.id}`);
      }
      if (!isLive) continue;
      liveCount += 1;

      const priorSample = lastSampleAt.get(target.id);
      if (priorSample !== undefined && cycleTime - priorSample < target.sampleIntervalMs) continue;
      lastSampleAt.set(target.id, cycleTime);
      for (const roi of target.rois) {
        capturedCount += 1;
        try {
          const result = await observeRoi(target, roi, cycleTime);
          if (result.appended) appendedCount += 1;
        } catch {
          logger.warn?.(`[samguk-monitor] ROI 관측 실패: ${target.id}/${roi.id}`);
        }
      }
    }
    return {
      liveCount,
      capturedCount,
      appendedCount,
      nextPollMs: liveCount > 0 ? config.livePollMs : config.idlePollMs,
    };
  }

  return { cropsDir, observeRoi, runCycle };
}

function abortableDelay(ms, signal) {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(done, ms);
    function done() {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

async function runMonitorLoop(monitor, signal) {
  while (!signal.aborted) {
    const result = await monitor.runCycle();
    await abortableDelay(result.nextPollMs, signal);
  }
}

function defaultStateDir(env = process.env) {
  const root = env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
  return path.join(root, "soop-notice", "samguk-monitor");
}

async function main(options = {}) {
  const env = options.env || process.env;
  const logger = options.logger || console;
  if (!isMonitorEnabled(env)) {
    logger.log?.("[samguk-monitor] 비활성 상태입니다. 외부 조회와 캡처를 시작하지 않습니다.");
    return { enabled: false };
  }

  const configPath = env.SAMGUK_MONITOR_CONFIG;
  if (!configPath) fail("missing_config", "SAMGUK_MONITOR_CONFIG가 필요합니다.");
  const config = loadMonitorConfig(configPath);
  assertActivationAllowed(config);
  const stateDir = path.resolve(env.SAMGUK_MONITOR_STATE_DIR || defaultStateDir(env));
  const queuePath = path.resolve(
    env.SAMGUK_OBSERVATION_QUEUE_PATH
      || env.SAMGUK_OBSERVATION_QUEUE
      || path.join(stateDir, "observations.ndjson"),
  );
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const monitor = createMonitor({ config, queuePath, stateDir, logger });
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await runMonitorLoop(monitor, controller.signal);
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
  return { enabled: true };
}

if (require.main === module) {
  process.umask(0o077);
  main().catch((error) => {
    console.error(`[samguk-monitor] ${error.code || "failed"}: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  DEFAULT_IDLE_POLL_MS,
  DEFAULT_LIVE_POLL_MS,
  MAX_CROP_RETENTION_MS,
  SOOP_LIVE_HEADERS,
  SamgukMonitorError,
  abortableDelay,
  activeTargets,
  assertActivationAllowed,
  captureRoi,
  cleanupExpiredCrops,
  createMonitor,
  createSoopLiveChecker,
  execFileText,
  isMonitorEnabled,
  loadMonitorConfig,
  main,
  normalizeMonitorConfig,
  parseOcrOutput,
  renderOcrArgs,
  runMonitorLoop,
  runOcrAdapter,
};
