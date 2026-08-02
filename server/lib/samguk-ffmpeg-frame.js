"use strict";

const path = require("node:path");
const { spawn } = require("node:child_process");

const GRAY_WIDTH = 48;
const GRAY_HEIGHT = 27;
const GRAY_FRAME_BYTES = GRAY_WIDTH * GRAY_HEIGHT;
const GRAY_FRAME_COUNT = 8;
const GRAY_OUTPUT_BYTES = GRAY_FRAME_BYTES * GRAY_FRAME_COUNT;
const OCR_WIDTH = 960;
const OCR_HEIGHT = 540;
const OCR_SAMPLE_INDEX_DEFAULT = 4;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

const DEFAULTS = Object.freeze({
  timeoutMs: 8_000,
  maxInputBytes: 8 * 1024 * 1024,
  maxGrayOutputBytes: GRAY_OUTPUT_BYTES,
  maxPngOutputBytes: 4 * 1024 * 1024,
  maxStderrBytes: 16 * 1024,
});

const GRAY_ARGS = Object.freeze([
  "-hide_banner",
  "-loglevel", "error",
  "-filter_threads", "1",
  "-threads", "1",
  "-f", "mpegts",
  "-i", "pipe:0",
  "-map", "0:v:0",
  "-an",
  "-sn",
  "-dn",
  "-vf", `fps=4,scale=${GRAY_WIDTH}:${GRAY_HEIGHT}:flags=fast_bilinear`,
  "-pix_fmt", "gray",
  "-frames:v", String(GRAY_FRAME_COUNT),
  "-threads", "1",
  "-f", "rawvideo",
  "pipe:1",
]);

const ERROR_MESSAGES = Object.freeze({
  invalid_config: "ffmpeg frame 설정이 올바르지 않습니다.",
  invalid_input: "MPEG-TS 입력이 올바르지 않습니다.",
  input_too_large: "MPEG-TS 입력이 크기 제한을 초과했습니다.",
  invalid_signal: "ffmpeg 취소 signal이 올바르지 않습니다.",
  invalid_sample_index: "ffmpeg OCR sampleIndex가 올바르지 않습니다.",
  aborted: "ffmpeg frame 변환이 취소되었습니다.",
  spawn_failed: "ffmpeg 프로세스를 시작하지 못했습니다.",
  timeout: "ffmpeg frame 변환 시간이 초과되었습니다.",
  stdin_error: "ffmpeg stdin 전달에 실패했습니다.",
  stdout_error: "ffmpeg stdout 처리에 실패했습니다.",
  stderr_error: "ffmpeg stderr 처리에 실패했습니다.",
  stdout_too_large: "ffmpeg 출력이 크기 제한을 초과했습니다.",
  stderr_too_large: "ffmpeg 진단 출력이 크기 제한을 초과했습니다.",
  ffmpeg_failed: "ffmpeg frame 변환에 실패했습니다.",
  invalid_gray_frame: "ffmpeg gray frame 크기가 올바르지 않습니다.",
  invalid_png: "ffmpeg OCR PNG 형식이 올바르지 않습니다.",
});

class SamgukFfmpegFrameError extends Error {
  constructor(code) {
    const safeCode = Object.hasOwn(ERROR_MESSAGES, code) ? code : "ffmpeg_failed";
    super(ERROR_MESSAGES[safeCode]);
    this.name = "SamgukFfmpegFrameError";
    this.code = safeCode;
  }
}

function makeError(code) {
  return new SamgukFfmpegFrameError(code);
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

function normalizeFfmpegPath(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 4_096
    || /[\u0000-\u001F\u007F]/.test(value) || !path.isAbsolute(value)) {
    fail("invalid_config");
  }
  return path.normalize(value);
}

function normalizeOptions(options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)) fail("invalid_config");
  const allowed = new Set([
    "ffmpegPath",
    "timeoutMs",
    "maxInputBytes",
    "maxGrayOutputBytes",
    "maxPngOutputBytes",
    "maxStderrBytes",
    "spawnImpl",
  ]);
  for (const key of Object.keys(options)) if (!allowed.has(key)) fail("invalid_config");

  const spawnImpl = options.spawnImpl === undefined ? spawn : options.spawnImpl;
  if (typeof spawnImpl !== "function") fail("invalid_config");
  return Object.freeze({
    ffmpegPath: normalizeFfmpegPath(options.ffmpegPath),
    timeoutMs: integerInRange(options.timeoutMs, DEFAULTS.timeoutMs, 10, 60_000),
    maxInputBytes: integerInRange(
      options.maxInputBytes,
      DEFAULTS.maxInputBytes,
      1,
      64 * 1024 * 1024,
    ),
    maxGrayOutputBytes: integerInRange(
      options.maxGrayOutputBytes,
      DEFAULTS.maxGrayOutputBytes,
      GRAY_OUTPUT_BYTES,
      1024 * 1024,
    ),
    maxPngOutputBytes: integerInRange(
      options.maxPngOutputBytes,
      DEFAULTS.maxPngOutputBytes,
      64,
      16 * 1024 * 1024,
    ),
    maxStderrBytes: integerInRange(
      options.maxStderrBytes,
      DEFAULTS.maxStderrBytes,
      0,
      1024 * 1024,
    ),
    spawnImpl,
  });
}

function validateMpegTs(input, maxInputBytes) {
  if (!Buffer.isBuffer(input) || input.length === 0) fail("invalid_input");
  if (input.length > maxInputBytes) fail("input_too_large");
  return input;
}

function normalizeSampleIndex(value) {
  const sampleIndex = value === undefined ? OCR_SAMPLE_INDEX_DEFAULT : value;
  if (!Number.isSafeInteger(sampleIndex) || sampleIndex < 0 || sampleIndex >= GRAY_FRAME_COUNT) {
    fail("invalid_sample_index");
  }
  return sampleIndex;
}

function normalizeRunOptions(options = {}, allowSampleIndex = false) {
  const allowed = allowSampleIndex ? new Set(["signal", "sampleIndex"]) : new Set(["signal"]);
  if (!options || typeof options !== "object" || Array.isArray(options)
    || Object.keys(options).some(key => !allowed.has(key))) {
    fail("invalid_signal");
  }
  const signal = options.signal;
  if (signal !== undefined && (!signal || typeof signal !== "object"
    || typeof signal.aborted !== "boolean"
    || typeof signal.addEventListener !== "function"
    || typeof signal.removeEventListener !== "function")) {
    fail("invalid_signal");
  }
  return Object.freeze({
    signal: signal ?? null,
    sampleIndex: allowSampleIndex ? normalizeSampleIndex(options.sampleIndex) : null,
  });
}

function buildGrayArgs() {
  return [...GRAY_ARGS];
}

function buildOcrPngArgs(sampleIndex = OCR_SAMPLE_INDEX_DEFAULT) {
  const normalizedSampleIndex = normalizeSampleIndex(sampleIndex);
  return [
    "-hide_banner",
    "-loglevel", "error",
    "-filter_threads", "1",
    "-threads", "1",
    "-f", "mpegts",
    "-i", "pipe:0",
    "-map", "0:v:0",
    "-an",
    "-sn",
    "-dn",
    // gray gate와 같은 fps filter phase를 사용한 뒤 정확히 같은 index만 고른다.
    "-vf", `fps=4,select=eq(n\\,${normalizedSampleIndex}),scale=${OCR_WIDTH}:${OCR_HEIGHT}:flags=bicubic`,
    "-frames:v", "1",
    "-threads", "1",
    "-f", "image2pipe",
    "-vcodec", "png",
    "pipe:1",
  ];
}

const OCR_PNG_ARGS = Object.freeze(buildOcrPngArgs());

function validatePipeOnlyArgs(args) {
  if (!Array.isArray(args) || args.length === 0 || args.some(value => typeof value !== "string")) {
    fail("invalid_config");
  }
  const inputIndexes = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "-i") inputIndexes.push(index);
  }
  if (inputIndexes.length !== 1 || args[inputIndexes[0] + 1] !== "pipe:0"
    || args.at(-1) !== "pipe:1" || args.some(value => value.includes("://"))) {
    fail("invalid_config");
  }
  return args;
}

function validateGrayOutput(output) {
  if (output.length !== GRAY_OUTPUT_BYTES) fail("invalid_gray_frame");
  return output;
}

function validatePngOutput(output) {
  if (output.length < 57 || !output.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    fail("invalid_png");
  }

  let offset = PNG_SIGNATURE.length;
  let chunks = 0;
  let sawHeader = false;
  let sawImageData = false;
  let sawEnd = false;
  while (offset < output.length) {
    if (offset + 12 > output.length) fail("invalid_png");
    const length = output.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (!Number.isSafeInteger(end) || end > output.length) fail("invalid_png");
    const type = output.toString("ascii", offset + 4, offset + 8);
    chunks += 1;
    if (chunks === 1 && type !== "IHDR") fail("invalid_png");
    if (type === "IHDR") {
      if (sawHeader || length !== 13) fail("invalid_png");
      const width = output.readUInt32BE(offset + 8);
      const height = output.readUInt32BE(offset + 12);
      if (width !== OCR_WIDTH || height !== OCR_HEIGHT) fail("invalid_png");
      sawHeader = true;
    } else if (type === "IDAT") {
      if (!sawHeader || sawEnd) fail("invalid_png");
      sawImageData = true;
    } else if (type === "IEND") {
      if (!sawHeader || !sawImageData || sawEnd || length !== 0 || end !== output.length) {
        fail("invalid_png");
      }
      sawEnd = true;
    }
    offset = end;
  }
  if (!sawHeader || !sawImageData || !sawEnd) fail("invalid_png");
  return output;
}

function runFfmpeg(config, args, input, maxOutputBytes, validateOutput, signal) {
  if (signal?.aborted) fail("aborted");
  validateMpegTs(input, config.maxInputBytes);
  validatePipeOnlyArgs(args);

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = config.spawnImpl(config.ffmpegPath, args, {
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch {
      reject(makeError("spawn_failed"));
      return;
    }

    if (!child || typeof child.once !== "function" || typeof child.kill !== "function"
      || typeof child.stdin?.end !== "function" || typeof child.stdin?.once !== "function"
      || typeof child.stdout?.on !== "function" || typeof child.stdout?.once !== "function"
      || typeof child.stderr?.on !== "function" || typeof child.stderr?.once !== "function") {
      reject(makeError("spawn_failed"));
      return;
    }

    let settled = false;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutChunks = [];
    let timer;
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

    function safeKill() {
      try {
        child.kill("SIGKILL");
      } catch {
        // 프로세스 오류의 세부 내용은 외부로 전달하지 않는다.
      }
    }

    function rejectOnce(error, kill = false) {
      if (settled) return;
      settled = true;
      clearState();
      stdoutChunks = [];
      if (kill) safeKill();
      reject(error);
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
        rejectOnce(makeError("stdout_error"), true);
        return;
      }
      stdoutBytes += bytes.length;
      if (stdoutBytes > maxOutputBytes) {
        rejectOnce(makeError("stdout_too_large"), true);
        return;
      }
      stdoutChunks.push(bytes);
    });

    child.stderr.on("data", chunk => {
      if (settled) return;
      let length;
      try {
        length = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
      } catch {
        rejectOnce(makeError("stderr_error"), true);
        return;
      }
      stderrBytes += length;
      if (stderrBytes > config.maxStderrBytes) {
        rejectOnce(makeError("stderr_too_large"), true);
      }
    });

    child.stdin.once("error", () => rejectOnce(makeError("stdin_error"), true));
    child.stdout.once("error", () => rejectOnce(makeError("stdout_error"), true));
    child.stderr.once("error", () => rejectOnce(makeError("stderr_error"), true));
    child.once("error", () => rejectOnce(makeError("spawn_failed")));
    child.once("close", code => {
      if (settled) return;
      if (code !== 0) {
        rejectOnce(makeError("ffmpeg_failed"));
        return;
      }
      let output;
      try {
        output = validateOutput(Buffer.concat(stdoutChunks, stdoutBytes));
      } catch (error) {
        rejectOnce(error instanceof SamgukFfmpegFrameError ? error : makeError("ffmpeg_failed"));
        return;
      }
      resolveOnce(output);
    });

    if (signal) {
      abortHandler = () => rejectOnce(makeError("aborted"), true);
      try {
        signal.addEventListener("abort", abortHandler, { once: true });
      } catch {
        rejectOnce(makeError("invalid_signal"), true);
        return;
      }
      if (!settled && signal.aborted) abortHandler();
      if (settled) return;
    }
    timer = setTimeout(() => rejectOnce(makeError("timeout"), true), config.timeoutMs);
    try {
      child.stdin.end(input);
    } catch {
      rejectOnce(makeError("stdin_error"), true);
    }
  });
}

function createSamgukFfmpegFrame(options = {}) {
  const config = normalizeOptions(options);
  return Object.freeze({
    captureGrayFrame: async (input, runOptions = {}) => {
      const { signal } = normalizeRunOptions(runOptions);
      if (signal?.aborted) fail("aborted");
      return runFfmpeg(
        config,
        buildGrayArgs(),
        input,
        config.maxGrayOutputBytes,
        validateGrayOutput,
        signal,
      );
    },
    captureOcrPng: async (input, runOptions = {}) => {
      const { signal, sampleIndex } = normalizeRunOptions(runOptions, true);
      if (signal?.aborted) fail("aborted");
      return runFfmpeg(
        config,
        buildOcrPngArgs(sampleIndex),
        input,
        config.maxPngOutputBytes,
        validatePngOutput,
        signal,
      );
    },
  });
}

function splitCaptureOptions(options = {}, allowSampleIndex = false) {
  if (!options || typeof options !== "object" || Array.isArray(options)) fail("invalid_config");
  const configOptions = { ...options };
  const signal = configOptions.signal;
  delete configOptions.signal;
  const runOptions = { signal };
  if (allowSampleIndex && Object.hasOwn(configOptions, "sampleIndex")) {
    runOptions.sampleIndex = configOptions.sampleIndex;
    delete configOptions.sampleIndex;
  }
  return { configOptions, runOptions };
}

async function captureGrayFrame(input, options = {}) {
  const { configOptions, runOptions } = splitCaptureOptions(options);
  return createSamgukFfmpegFrame(configOptions).captureGrayFrame(input, runOptions);
}

async function captureOcrPng(input, options = {}) {
  const { configOptions, runOptions } = splitCaptureOptions(options, true);
  return createSamgukFfmpegFrame(configOptions).captureOcrPng(input, runOptions);
}

module.exports = {
  GRAY_WIDTH,
  GRAY_HEIGHT,
  GRAY_FRAME_BYTES,
  GRAY_FRAME_COUNT,
  GRAY_OUTPUT_BYTES,
  OCR_WIDTH,
  OCR_HEIGHT,
  DEFAULTS,
  OCR_PNG_ARGS,
  SamgukFfmpegFrameError,
  buildGrayArgs,
  buildOcrPngArgs,
  captureGrayFrame,
  captureOcrPng,
  createSamgukFfmpegFrame,
  validatePngOutput,
};
