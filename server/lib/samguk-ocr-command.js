"use strict";

const path = require("node:path");
const { spawn } = require("node:child_process");

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_PNG_BYTES = 16 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const PROFILE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const PLAYER_ID_PATTERN = /^P\d{3}$/;
const TARGET_ID_PATTERN = PROFILE_ID_PATTERN;
const BJ_ID_PATTERN = /^[A-Za-z0-9_]{1,30}$/;
const TEMPLATE_PATTERN = /\{(profileId|playerId|targetId|bjId|observedAt)\}/g;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F]/;
const CONFIG_KEYS = new Set([
  "command",
  "args",
  "profileId",
  "timeoutMs",
  "maxOutputBytes",
  "spawnImpl",
]);
const CONTEXT_KEYS = new Set(["playerId", "targetId", "bjId", "observedAt"]);
const SAFE_ENV_KEYS = Object.freeze(["PATH", "LANG", "LC_ALL"]);

const ERROR_MESSAGES = Object.freeze({
  invalid_config: "OCR command 설정이 올바르지 않습니다.",
  invalid_context: "OCR command 실행 문맥이 올바르지 않습니다.",
  invalid_png: "OCR command 입력 PNG가 올바르지 않습니다.",
  input_too_large: "OCR command 입력 PNG가 크기 제한을 초과했습니다.",
  invalid_signal: "OCR command 취소 signal이 올바르지 않습니다.",
  aborted: "OCR command 실행이 취소되었습니다.",
  spawn_failed: "OCR command 프로세스를 시작하지 못했습니다.",
  timeout: "OCR command 실행 시간이 초과되었습니다.",
  stdin_error: "OCR command stdin 전달에 실패했습니다.",
  stdout_error: "OCR command stdout 처리에 실패했습니다.",
  stderr_error: "OCR command stderr 처리에 실패했습니다.",
  stdout_too_large: "OCR command stdout이 크기 제한을 초과했습니다.",
  stderr_too_large: "OCR command stderr가 크기 제한을 초과했습니다.",
  command_failed: "OCR command 실행에 실패했습니다.",
});

class SamgukOcrCommandError extends Error {
  constructor(code) {
    const safeCode = Object.hasOwn(ERROR_MESSAGES, code) ? code : "command_failed";
    super(ERROR_MESSAGES[safeCode]);
    this.name = "SamgukOcrCommandError";
    this.code = safeCode;
  }
}

function makeError(code) {
  return new SamgukOcrCommandError(code);
}

function fail(code) {
  throw makeError(code);
}

function integerInRange(value, fallback, min, max) {
  const candidate = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(candidate) || candidate < min || candidate > max) {
    fail("invalid_config");
  }
  return candidate;
}

function normalizeIdentifier(value, pattern, code) {
  if (typeof value !== "string" || !pattern.test(value)) fail(code);
  return value;
}

function normalizeCommand(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 4_096
    || CONTROL_CHARACTER_PATTERN.test(value) || !path.isAbsolute(value)) {
    fail("invalid_config");
  }
  return path.normalize(value);
}

function normalizeArgs(value) {
  const args = value === undefined ? [] : value;
  if (!Array.isArray(args) || args.length > 64) fail("invalid_config");
  return Object.freeze(args.map(arg => {
    if (typeof arg !== "string" || arg.length > 1_024 || CONTROL_CHARACTER_PATTERN.test(arg)) {
      fail("invalid_config");
    }
    const withoutAllowedTemplates = arg.replace(TEMPLATE_PATTERN, "");
    if (withoutAllowedTemplates.includes("{") || withoutAllowedTemplates.includes("}")) {
      fail("invalid_config");
    }
    return arg;
  }));
}

function restrictedEnv(env = process.env) {
  const result = {};
  for (const key of SAFE_ENV_KEYS) {
    if (typeof env[key] === "string") result[key] = env[key];
  }
  return result;
}

function normalizeConfig(options) {
  if (!options || typeof options !== "object" || Array.isArray(options)) fail("invalid_config");
  for (const key of Object.keys(options)) if (!CONFIG_KEYS.has(key)) fail("invalid_config");
  const spawnImpl = options.spawnImpl === undefined ? spawn : options.spawnImpl;
  if (typeof spawnImpl !== "function") fail("invalid_config");
  return Object.freeze({
    command: normalizeCommand(options.command),
    args: normalizeArgs(options.args),
    profileId: normalizeIdentifier(options.profileId, PROFILE_ID_PATTERN, "invalid_config"),
    timeoutMs: integerInRange(options.timeoutMs, DEFAULT_TIMEOUT_MS, 1, 60_000),
    maxOutputBytes: integerInRange(
      options.maxOutputBytes,
      DEFAULT_MAX_OUTPUT_BYTES,
      1,
      1024 * 1024,
    ),
    spawnImpl,
    env: Object.freeze(restrictedEnv()),
  });
}

function normalizeObservedAt(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 64
    || CONTROL_CHARACTER_PATTERN.test(value)) {
    fail("invalid_context");
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) fail("invalid_context");
  const date = new Date(timestamp);
  const year = date.getUTCFullYear();
  if (year < 2000 || year > 2100) fail("invalid_context");
  return date.toISOString();
}

function normalizeContext(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("invalid_context");
  const keys = Object.keys(input);
  if (keys.some(key => !CONTEXT_KEYS.has(key))
    || [...CONTEXT_KEYS].some(key => !Object.prototype.hasOwnProperty.call(input, key))) {
    fail("invalid_context");
  }
  return Object.freeze({
    playerId: normalizeIdentifier(input.playerId, PLAYER_ID_PATTERN, "invalid_context"),
    targetId: normalizeIdentifier(input.targetId, TARGET_ID_PATTERN, "invalid_context"),
    bjId: normalizeIdentifier(input.bjId, BJ_ID_PATTERN, "invalid_context"),
    observedAt: normalizeObservedAt(input.observedAt),
  });
}

function normalizePng(input) {
  if (!Buffer.isBuffer(input) || input.length < PNG_SIGNATURE.length
    || !input.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    fail("invalid_png");
  }
  if (input.length > MAX_PNG_BYTES) fail("input_too_large");
  return Buffer.from(input);
}

function renderArgs(args, context) {
  return args.map(arg => arg.replace(TEMPLATE_PATTERN, (_match, key) => context[key]));
}

function normalizeRunOptions(options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)
    || Object.keys(options).some(key => key !== "signal")) {
    fail("invalid_signal");
  }
  const signal = options.signal;
  if (signal === undefined) return null;
  if (!signal || typeof signal !== "object" || typeof signal.aborted !== "boolean"
    || typeof signal.addEventListener !== "function"
    || typeof signal.removeEventListener !== "function") {
    fail("invalid_signal");
  }
  return signal;
}

function runCommand(config, pngBuffer, context, signal) {
  if (signal?.aborted) fail("aborted");
  const input = normalizePng(pngBuffer);
  const normalizedContext = normalizeContext(context);
  const args = renderArgs(config.args, {
    profileId: config.profileId,
    ...normalizedContext,
  });

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = config.spawnImpl(config.command, args, {
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        env: { ...config.env },
      });
    } catch {
      reject(makeError("spawn_failed"));
      return;
    }

    function safeKill() {
      try {
        if (typeof child?.kill === "function") child.kill("SIGKILL");
      } catch {
        // 프로세스 오류 세부 내용은 외부로 전달하지 않는다.
      }
    }

    if (!child || typeof child.once !== "function" || typeof child.kill !== "function"
      || typeof child.stdin?.end !== "function" || typeof child.stdin?.once !== "function"
      || typeof child.stdout?.on !== "function" || typeof child.stdout?.once !== "function"
      || typeof child.stderr?.on !== "function" || typeof child.stderr?.once !== "function") {
      safeKill();
      reject(makeError("spawn_failed"));
      return;
    }

    let settled = false;
    let timer;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutChunks = [];
    let abortHandler = null;

    function clearState() {
      if (timer !== undefined) clearTimeout(timer);
      if (signal && abortHandler) {
        try {
          signal.removeEventListener("abort", abortHandler);
        } catch {
          // signal 구현의 내부 오류는 외부로 전달하지 않는다.
        }
        abortHandler = null;
      }
    }

    function rejectOnce(code, kill = false) {
      if (settled) return;
      settled = true;
      clearState();
      stdoutChunks = [];
      if (kill) safeKill();
      reject(makeError(code));
    }

    function resolveOnce(output) {
      if (settled) return;
      settled = true;
      clearState();
      stdoutChunks = [];
      resolve(output);
    }

    child.stdout.on("data", chunk => {
      if (settled) return;
      let bytes;
      try {
        bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      } catch {
        rejectOnce("stdout_error", true);
        return;
      }
      stdoutBytes += bytes.length;
      if (stdoutBytes > config.maxOutputBytes) {
        rejectOnce("stdout_too_large", true);
        return;
      }
      stdoutChunks.push(bytes);
    });

    child.stderr.on("data", chunk => {
      if (settled) return;
      let byteLength;
      try {
        byteLength = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
      } catch {
        rejectOnce("stderr_error", true);
        return;
      }
      stderrBytes += byteLength;
      if (stderrBytes > config.maxOutputBytes) rejectOnce("stderr_too_large", true);
    });

    child.stdin.once("error", () => rejectOnce("stdin_error", true));
    child.stdout.once("error", () => rejectOnce("stdout_error", true));
    child.stderr.once("error", () => rejectOnce("stderr_error", true));
    child.once("error", () => rejectOnce("spawn_failed", true));
    child.once("close", code => {
      if (settled) return;
      if (code !== 0) {
        rejectOnce("command_failed");
        return;
      }
      resolveOnce(Buffer.concat(stdoutChunks, stdoutBytes).toString("utf8"));
    });

    if (signal) {
      abortHandler = () => rejectOnce("aborted", true);
      try {
        signal.addEventListener("abort", abortHandler, { once: true });
      } catch {
        rejectOnce("invalid_signal", true);
        return;
      }
      if (!settled && signal.aborted) abortHandler();
      if (settled) return;
    }
    timer = setTimeout(() => rejectOnce("timeout", true), config.timeoutMs);
    try {
      child.stdin.end(input);
    } catch {
      rejectOnce("stdin_error", true);
    }
  });
}

function createSamgukOcrCommand(options) {
  const config = normalizeConfig(options);
  return Object.freeze({
    async run(pngBuffer, context, runOptions = {}) {
      const signal = normalizeRunOptions(runOptions);
      if (signal?.aborted) fail("aborted");
      return runCommand(config, pngBuffer, context, signal);
    },
  });
}

module.exports = {
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_TIMEOUT_MS,
  MAX_PNG_BYTES,
  SamgukOcrCommandError,
  createSamgukOcrCommand,
};
