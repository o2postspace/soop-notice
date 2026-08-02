"use strict";

const crypto = require("node:crypto");

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024;
const DEFAULT_MAX_SEGMENT_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_BATCH_BYTES = 32 * 1024 * 1024;
const MAX_BATCH_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_SEGMENTS = 6;
const MAX_SEGMENTS = 12;
const DEFAULT_INITIAL_SEGMENT_COUNT = 1;
const MAX_SEGMENT_BYTES = 64 * 1024 * 1024;
const MAX_URL_LENGTH = 16 * 1024;
const MAX_FFMPEG_STDIN_BYTES = 64 * 1024;
const MAX_REDIRECTS = 3;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const URL_CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F]/;
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";
const FRAME_FETCH_OPTION_KEYS = new Set(["fetchImpl", "timeoutMs", "maxResponseBytes"]);
const SEGMENT_FETCH_OPTION_KEYS = new Set([
  ...FRAME_FETCH_OPTION_KEYS,
  "maxSegmentBytes",
]);
const SEGMENT_BATCH_FETCH_OPTION_KEYS = new Set([
  ...SEGMENT_FETCH_OPTION_KEYS,
  "maxBatchBytes",
  "maxSegments",
]);
const FETCH_CALL_OPTION_KEYS = new Set(["signal"]);
const BATCH_FETCH_CALL_OPTION_KEYS = new Set([
  "afterSegmentId",
  "initialSegmentCount",
  "signal",
]);
const SEGMENT_ID_PATTERN = /^[0-9a-f]{64}$/;
const ABORTED_GETTER = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted").get;
const ADD_EVENT_LISTENER = EventTarget.prototype.addEventListener;
const REMOVE_EVENT_LISTENER = EventTarget.prototype.removeEventListener;

const ERROR_MESSAGES = Object.freeze({
  invalid_config: "SOOP HLS frame 설정이 올바르지 않습니다.",
  invalid_hls_url: "SOOP HLS URL이 올바르지 않습니다.",
  upstream_timeout: "SOOP HLS playlist 조회 시간이 초과되었습니다.",
  upstream_error: "SOOP HLS playlist 조회에 실패했습니다.",
  upstream_http: "SOOP HLS playlist 응답이 올바르지 않습니다.",
  response_too_large: "SOOP HLS playlist가 크기 제한을 초과했습니다.",
  invalid_playlist: "SOOP HLS media playlist 형식이 올바르지 않습니다.",
  unsafe_segment_url: "SOOP HLS segment URL이 허용되지 않습니다.",
  invalid_ffmpeg_input: "ffmpeg HLS 입력 형식이 올바르지 않습니다.",
  aborted: "SOOP HLS frame 조회가 중단되었습니다.",
});
const ERROR_STAGES = new Set(["config", "parse", "playlist", "segment", "ffmpeg"]);

const FFMPEG_FRAME_ARGS = Object.freeze([
  "-hide_banner",
  "-loglevel", "error",
  "-protocol_whitelist", "pipe,https,tcp,tls,crypto",
  "-threads", "1",
  "-skip_frame", "nokey",
  "-f", "hls",
  "-i", "pipe:0",
  "-map", "0:v:0",
  "-an",
  "-sn",
  "-dn",
  "-vf", "scale=48:27:flags=fast_bilinear",
  "-pix_fmt", "gray",
  "-frames:v", "1",
  "-f", "rawvideo",
  "pipe:1",
]);

const FFMPEG_MPEGTS_FRAME_ARGS = Object.freeze([
  "-hide_banner",
  "-loglevel", "error",
  "-threads", "1",
  "-skip_frame", "nokey",
  "-f", "mpegts",
  "-i", "pipe:0",
  "-map", "0:v:0",
  "-an",
  "-sn",
  "-dn",
  "-vf", "scale=48:27:flags=fast_bilinear",
  "-pix_fmt", "gray",
  "-frames:v", "1",
  "-f", "rawvideo",
  "pipe:1",
]);

class SoopHlsFrameError extends Error {
  constructor(code, stage = null) {
    const safeCode = typeof code === "string" && Object.hasOwn(ERROR_MESSAGES, code)
      ? code
      : "upstream_error";
    super(ERROR_MESSAGES[safeCode]);
    this.name = "SoopHlsFrameError";
    this.code = safeCode;
    if (ERROR_STAGES.has(stage)) this.stage = stage;
  }
}

function fail(code, stage = null) {
  throw new SoopHlsFrameError(code, stage);
}

function integerInRange(value, fallback, min, max) {
  const candidate = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(candidate) || candidate < min || candidate > max) {
    fail("invalid_config", "config");
  }
  return candidate;
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function strictOptions(value, allowedKeys) {
  let normalized = null;
  try {
    if (isPlainObject(value)) {
      const keys = Reflect.ownKeys(value);
      const entries = keys.map((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (typeof key !== "string" || !allowedKeys.has(key)
          || !descriptor || !Object.hasOwn(descriptor, "value")) {
          throw new TypeError("invalid options");
        }
        return [key, descriptor.value];
      });
      normalized = Object.fromEntries(entries);
    }
  } catch {
    normalized = null;
  }
  if (!normalized) {
    fail("invalid_config", "config");
  }
  return normalized;
}

function abortSignalState(signal) {
  try {
    const aborted = ABORTED_GETTER.call(signal);
    if (typeof aborted !== "boolean") fail("invalid_config", "config");
    return aborted;
  } catch {
    fail("invalid_config", "config");
  }
}

function addAbortListener(signal, listener) {
  try {
    ADD_EVENT_LISTENER.call(signal, "abort", listener, { once: true });
  } catch {
    fail("invalid_config", "config");
  }
}

function removeAbortListener(signal, listener) {
  try {
    REMOVE_EVENT_LISTENER.call(signal, "abort", listener);
  } catch {
    // 검증된 signal의 정리 실패는 원래 결과를 덮어쓰지 않는다.
  }
}

function safeErrorProperty(error, property) {
  try {
    return error && (typeof error === "object" || typeof error === "function")
      ? error[property]
      : null;
  } catch {
    return null;
  }
}

function isSoopHlsFrameError(error) {
  try {
    return error instanceof SoopHlsFrameError;
  } catch {
    return false;
  }
}

function normalizeFetchCallOptions(value = {}) {
  const options = strictOptions(value, FETCH_CALL_OPTION_KEYS);
  if (options.signal !== undefined) abortSignalState(options.signal);
  return { signal: options.signal };
}

function normalizeBatchFetchCallOptions(value, maxSegments) {
  const options = strictOptions(value, BATCH_FETCH_CALL_OPTION_KEYS);
  if (options.signal !== undefined) abortSignalState(options.signal);
  const afterSegmentId = options.afterSegmentId;
  if (afterSegmentId !== undefined
    && (typeof afterSegmentId !== "string" || !SEGMENT_ID_PATTERN.test(afterSegmentId))) {
    fail("invalid_config", "config");
  }
  const initialSegmentCount = integerInRange(
    options.initialSegmentCount,
    DEFAULT_INITIAL_SEGMENT_COUNT,
    0,
    maxSegments,
  );
  return { afterSegmentId, initialSegmentCount, signal: options.signal };
}

function hostMatches(hostname, root) {
  return hostname === root || hostname.endsWith(`.${root}`);
}

function isOfficialSoopHost(hostname) {
  const normalized = String(hostname || "").toLowerCase();
  return hostMatches(normalized, "sooplive.com") || hostMatches(normalized, "sooplive.co.kr");
}

function parseOfficialHttpsUrl(value, code, stage, baseUrl) {
  if (typeof value !== "string" || !value.trim() || value.length > MAX_URL_LENGTH
    || URL_CONTROL_CHARACTER_PATTERN.test(value)) {
    fail(code, stage);
  }
  let parsed;
  try {
    parsed = baseUrl ? new URL(value.trim(), baseUrl) : new URL(value.trim());
  } catch {
    fail(code, stage);
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password
    || (parsed.port && parsed.port !== "443") || !isOfficialSoopHost(parsed.hostname)) {
    fail(code, stage);
  }
  parsed.hash = "";
  return parsed;
}

function parseDecimalInteger(value) {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function segmentIdForUrl(segmentUrl) {
  return crypto.createHash("sha256").update(segmentUrl, "utf8").digest("hex");
}

function splitPlaylistLines(playlist, maxBytes) {
  if (typeof playlist !== "string" || !playlist || Buffer.byteLength(playlist) > maxBytes
    || CONTROL_CHARACTER_PATTERN.test(playlist)) {
    fail("invalid_playlist", "parse");
  }
  const normalized = playlist.startsWith("\uFEFF") ? playlist.slice(1) : playlist;
  const lines = normalized.split("\n").map(line => (
    line.endsWith("\r") ? line.slice(0, -1) : line
  ));
  if (lines.some(line => line.includes("\r")) || lines[0] !== "#EXTM3U") {
    fail("invalid_playlist", "parse");
  }
  return lines;
}

function parseMediaPlaylistDetails(playlist, playlistUrl, maxBytes = DEFAULT_MAX_RESPONSE_BYTES) {
  const baseUrl = parseOfficialHttpsUrl(playlistUrl, "invalid_hls_url", "parse");
  const lines = splitPlaylistLines(playlist, maxBytes);
  let versionLine = null;
  let targetDurationLine = null;
  let mediaSequence = 0;
  let sawMediaSequence = false;
  let pendingSegment = null;
  const completedSegments = [];

  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line) continue;

    if (line.startsWith("#EXT-X-STREAM-INF:") || line.startsWith("#EXT-X-I-FRAME-STREAM-INF:")
      || line.startsWith("#EXT-X-MAP:") || line.startsWith("#EXT-X-BYTERANGE:")
      || (line.startsWith("#EXT-X-KEY:") && !/^#EXT-X-KEY:METHOD=NONE(?:,|$)/.test(line))) {
      fail("invalid_playlist", "parse");
    }

    if (line.startsWith("#EXT-X-VERSION:")) {
      const value = line.slice("#EXT-X-VERSION:".length);
      if (versionLine || parseDecimalInteger(value) === null) fail("invalid_playlist", "parse");
      versionLine = line;
      continue;
    }

    if (line.startsWith("#EXT-X-TARGETDURATION:")) {
      const value = line.slice("#EXT-X-TARGETDURATION:".length);
      const duration = parseDecimalInteger(value);
      if (targetDurationLine || duration === null || duration === 0) fail("invalid_playlist", "parse");
      targetDurationLine = line;
      continue;
    }

    if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
      const value = line.slice("#EXT-X-MEDIA-SEQUENCE:".length);
      const sequence = parseDecimalInteger(value);
      if (sawMediaSequence || sequence === null) fail("invalid_playlist", "parse");
      sawMediaSequence = true;
      mediaSequence = sequence;
      continue;
    }

    if (line.startsWith("#EXTINF:")) {
      if (pendingSegment) fail("invalid_playlist", "parse");
      const match = /^#EXTINF:([0-9]+(?:\.[0-9]+)?)(?:,.*)?$/.exec(line);
      const duration = match ? Number(match[1]) : Number.NaN;
      if (!Number.isFinite(duration) || duration <= 0) fail("invalid_playlist", "parse");
      pendingSegment = { durationLine: line };
      continue;
    }

    if (line.startsWith("#")) continue;
    if (!pendingSegment) fail("invalid_playlist", "parse");
    const segmentUrl = parseOfficialHttpsUrl(line, "unsafe_segment_url", "parse", baseUrl);
    completedSegments.push({
      durationLine: pendingSegment.durationLine,
      segmentUrl: segmentUrl.toString(),
    });
    pendingSegment = null;
  }

  if (!targetDurationLine || completedSegments.length === 0) fail("invalid_playlist", "parse");
  const lastSegmentIndex = completedSegments.length - 1;
  const lastMediaSequence = mediaSequence + lastSegmentIndex;
  if (!Number.isSafeInteger(lastMediaSequence)) fail("invalid_playlist", "parse");
  const segments = completedSegments.map((segment, index) => {
    const currentMediaSequence = mediaSequence + index;
    if (!Number.isSafeInteger(currentMediaSequence) || currentMediaSequence < 0) {
      fail("invalid_playlist", "parse");
    }
    return {
      durationLine: segment.durationLine,
      mediaSequence: currentMediaSequence,
      segmentId: segmentIdForUrl(segment.segmentUrl),
      segmentUrl: segment.segmentUrl,
    };
  });
  if (new Set(segments.map(segment => segment.segmentId)).size !== segments.length) {
    fail("invalid_playlist", "parse");
  }
  const lastSegment = segments[lastSegmentIndex];
  const output = ["#EXTM3U"];
  if (versionLine) output.push(versionLine);
  output.push(targetDurationLine);
  output.push(`#EXT-X-MEDIA-SEQUENCE:${lastMediaSequence}`);
  output.push(lastSegment.durationLine);
  output.push(lastSegment.segmentUrl);
  output.push("#EXT-X-ENDLIST", "");
  return {
    finitePlaylist: output.join("\n"),
    segmentUrl: lastSegment.segmentUrl,
    segments,
  };
}

function parseSoopHlsMediaPlaylist(playlist, playlistUrl) {
  return parseMediaPlaylistDetails(playlist, playlistUrl).finitePlaylist;
}

async function readBufferLimited(response, maxBytes, stage) {
  const contentLength = response.headers?.get?.("content-length");
  if (typeof contentLength === "string" && /^[0-9]+$/.test(contentLength)) {
    const declaredLength = Number(contentLength);
    if (!Number.isSafeInteger(declaredLength) || declaredLength > maxBytes) {
      fail("response_too_large", stage);
    }
  }

  if (response.body && typeof response.body.getReader === "function") {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      let chunk;
      try {
        chunk = Buffer.from(value);
      } catch {
        fail("invalid_playlist", stage);
      }
      total += chunk.length;
      if (total > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // stream 내부 오류는 URL이나 token을 포함할 수 있어 외부에 전달하지 않는다.
        }
        fail("response_too_large", stage);
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, total);
  }

  if (typeof response.arrayBuffer !== "function") fail("invalid_playlist", stage);
  const body = Buffer.from(await response.arrayBuffer());
  if (body.length > maxBytes) fail("response_too_large", stage);
  return body;
}

function normalizeFetchOptions(options, includeSegmentLimit = false) {
  options = strictOptions(
    options,
    includeSegmentLimit ? SEGMENT_FETCH_OPTION_KEYS : FRAME_FETCH_OPTION_KEYS,
  );
  const fetchImpl = options.fetchImpl === undefined ? ((...args) => fetch(...args)) : options.fetchImpl;
  if (typeof fetchImpl !== "function") fail("invalid_config", "config");
  const timeoutMs = integerInRange(options.timeoutMs, DEFAULT_TIMEOUT_MS, 10, 30_000);
  const maxResponseBytes = integerInRange(
    options.maxResponseBytes,
    DEFAULT_MAX_RESPONSE_BYTES,
    128,
    4 * 1024 * 1024,
  );
  const maxSegmentBytes = includeSegmentLimit
    ? integerInRange(options.maxSegmentBytes, DEFAULT_MAX_SEGMENT_BYTES, 128, MAX_SEGMENT_BYTES)
    : DEFAULT_MAX_SEGMENT_BYTES;
  return { fetchImpl, timeoutMs, maxResponseBytes, maxSegmentBytes };
}

function normalizeBatchFetchOptions(options) {
  options = strictOptions(options, SEGMENT_BATCH_FETCH_OPTION_KEYS);
  const segmentOptions = {};
  for (const key of SEGMENT_FETCH_OPTION_KEYS) {
    if (Object.hasOwn(options, key)) segmentOptions[key] = options[key];
  }
  return {
    ...normalizeFetchOptions(segmentOptions, true),
    maxBatchBytes: integerInRange(
      options.maxBatchBytes,
      DEFAULT_MAX_BATCH_BYTES,
      128,
      MAX_BATCH_BYTES,
    ),
    maxSegments: integerInRange(
      options.maxSegments,
      DEFAULT_MAX_SEGMENTS,
      1,
      MAX_SEGMENTS,
    ),
  };
}

async function fetchOfficialBody(url, config) {
  if (config.signal && abortSignalState(config.signal)) fail("aborted", config.stage);
  const requestUrl = parseOfficialHttpsUrl(url, config.urlErrorCode, config.stage);
  const controller = new AbortController();
  let timeoutId;
  let abortListener;
  let didTimeout = false;
  let didAbort = false;
  const timeout = new Promise((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      didTimeout = true;
      controller.abort();
      reject(new SoopHlsFrameError("upstream_timeout", config.stage));
    }, config.timeoutMs);
  });
  const aborted = config.signal ? new Promise((_resolve, reject) => {
    abortListener = () => {
      didAbort = true;
      controller.abort();
      reject(new SoopHlsFrameError("aborted", config.stage));
    };
    addAbortListener(config.signal, abortListener);
    if (abortSignalState(config.signal)) abortListener();
  }) : null;
  const request = (async () => {
    let currentUrl = requestUrl;
    for (let redirectCount = 0; ; redirectCount += 1) {
      const response = await config.fetchImpl(currentUrl, {
        method: "GET",
        credentials: "omit",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          Accept: config.accept,
          Origin: "https://play.sooplive.com",
          Referer: "https://play.sooplive.com/",
          "User-Agent": USER_AGENT,
        },
      });
      if (!response || typeof response.ok !== "boolean" || !Number.isInteger(response.status)) {
        fail("invalid_playlist", config.stage);
      }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers?.get?.("location");
        try {
          await response.body?.cancel?.();
        } catch {
          // redirect body 내부 정보는 오류에 포함하지 않는다.
        }
        const nextUrl = parseOfficialHttpsUrl(
          location,
          config.urlErrorCode,
          config.stage,
          currentUrl,
        );
        if (redirectCount >= MAX_REDIRECTS) fail("upstream_http", config.stage);
        currentUrl = nextUrl;
        continue;
      }
      if (!response.ok) fail("upstream_http", config.stage);
      const responseUrl = response.url
        ? parseOfficialHttpsUrl(response.url, config.urlErrorCode, config.stage)
        : currentUrl;
      const body = await readBufferLimited(response, config.maxBytes, config.stage);
      return { body, responseUrl };
    }
  })();

  try {
    const result = await Promise.race(aborted ? [request, timeout, aborted] : [request, timeout]);
    if (didAbort || (config.signal && abortSignalState(config.signal))) {
      fail("aborted", config.stage);
    }
    return result;
  } catch (error) {
    const errorCode = safeErrorProperty(error, "code");
    const errorName = safeErrorProperty(error, "name");
    if (didAbort || (config.signal && abortSignalState(config.signal)) || errorCode === "aborted") {
      fail("aborted", config.stage);
    }
    if (isSoopHlsFrameError(error)) {
      throw new SoopHlsFrameError(errorCode, safeErrorProperty(error, "stage"));
    }
    if (didTimeout || errorName === "AbortError") {
      fail("upstream_timeout", config.stage);
    }
    fail("upstream_error", config.stage);
  } finally {
    clearTimeout(timeoutId);
    if (abortListener) removeAbortListener(config.signal, abortListener);
  }
}

async function fetchPlaylistDetails(hlsUrl, config) {
  const { body, responseUrl } = await fetchOfficialBody(hlsUrl, {
    ...config,
    accept: "application/vnd.apple.mpegurl,application/x-mpegURL,*/*",
    maxBytes: config.maxResponseBytes,
    stage: "playlist",
    urlErrorCode: "invalid_hls_url",
  });
  return parseMediaPlaylistDetails(body.toString("utf8"), responseUrl.toString(), config.maxResponseBytes);
}

async function fetchSegmentBody(segmentUrl, config, maxBytes = config.maxSegmentBytes) {
  const { body } = await fetchOfficialBody(segmentUrl, {
    ...config,
    accept: "video/mp2t,video/*,*/*",
    maxBytes,
    stage: "segment",
    urlErrorCode: "unsafe_segment_url",
  });
  if (body.length === 0) fail("invalid_playlist", "segment");
  return body;
}

function tailSegments(segments, count) {
  return count === 0 ? [] : segments.slice(-count);
}

function selectBatchSegments(segments, callOptions, maxSegments) {
  if (callOptions.afterSegmentId === undefined) {
    return tailSegments(segments, callOptions.initialSegmentCount);
  }
  let cursorIndex = -1;
  for (let index = 0; index < segments.length; index += 1) {
    if (segments[index].segmentId === callOptions.afterSegmentId) cursorIndex = index;
  }
  if (cursorIndex < 0) return tailSegments(segments, callOptions.initialSegmentCount);
  return tailSegments(segments.slice(cursorIndex + 1), maxSegments);
}

function createSoopHlsFrameFetcher(options = {}) {
  const config = normalizeFetchOptions(options);

  return async function fetchFramePlaylist(hlsUrl, callOptions = {}) {
    const { signal } = normalizeFetchCallOptions(callOptions);
    return (await fetchPlaylistDetails(hlsUrl, { ...config, signal })).finitePlaylist;
  };
}

function fetchSoopHlsFramePlaylist(hlsUrl, options = {}) {
  const combinedKeys = new Set([...FRAME_FETCH_OPTION_KEYS, ...FETCH_CALL_OPTION_KEYS]);
  options = strictOptions(options, combinedKeys);
  const factoryOptions = {};
  for (const key of FRAME_FETCH_OPTION_KEYS) {
    if (Object.hasOwn(options, key)) factoryOptions[key] = options[key];
  }
  const callOptions = Object.hasOwn(options, "signal") ? { signal: options.signal } : {};
  return createSoopHlsFrameFetcher(factoryOptions)(hlsUrl, callOptions);
}

function createSoopHlsFrameSegmentFetcher(options = {}) {
  const config = normalizeFetchOptions(options, true);
  return async function fetchFrameSegment(hlsUrl, callOptions = {}) {
    const { signal } = normalizeFetchCallOptions(callOptions);
    const requestConfig = { ...config, signal };
    const { segmentUrl } = await fetchPlaylistDetails(hlsUrl, requestConfig);
    return fetchSegmentBody(segmentUrl, requestConfig);
  };
}

function createSoopHlsFrameSegmentBatchFetcher(options = {}) {
  const config = normalizeBatchFetchOptions(options);
  return async function fetchFrameSegmentBatch(hlsUrl, callOptions = {}) {
    const normalizedCallOptions = normalizeBatchFetchCallOptions(
      callOptions,
      config.maxSegments,
    );
    const requestConfig = { ...config, signal: normalizedCallOptions.signal };
    const { segments } = await fetchPlaylistDetails(hlsUrl, requestConfig);
    const selected = selectBatchSegments(segments, normalizedCallOptions, config.maxSegments);
    const fetched = [];
    let batchBytes = 0;
    for (const segment of selected) {
      const remainingBytes = config.maxBatchBytes - batchBytes;
      if (remainingBytes <= 0) fail("response_too_large", "segment");
      const body = await fetchSegmentBody(
        segment.segmentUrl,
        requestConfig,
        Math.min(config.maxSegmentBytes, remainingBytes),
      );
      batchBytes += body.length;
      if (!Number.isSafeInteger(batchBytes) || batchBytes > config.maxBatchBytes) {
        fail("response_too_large", "segment");
      }
      fetched.push(Object.freeze({
        segmentId: segment.segmentId,
        mediaSequence: segment.mediaSequence,
        body,
      }));
    }
    return Object.freeze(fetched);
  };
}

function fetchSoopHlsFrameSegment(hlsUrl, options = {}) {
  const combinedKeys = new Set([...SEGMENT_FETCH_OPTION_KEYS, ...FETCH_CALL_OPTION_KEYS]);
  options = strictOptions(options, combinedKeys);
  const factoryOptions = {};
  for (const key of SEGMENT_FETCH_OPTION_KEYS) {
    if (Object.hasOwn(options, key)) factoryOptions[key] = options[key];
  }
  const callOptions = Object.hasOwn(options, "signal") ? { signal: options.signal } : {};
  return createSoopHlsFrameSegmentFetcher(factoryOptions)(hlsUrl, callOptions);
}

function buildSoopHlsFrameArgs() {
  return [...FFMPEG_FRAME_ARGS];
}

function buildSoopMpegTsFrameArgs() {
  return [...FFMPEG_MPEGTS_FRAME_ARGS];
}

function buildSoopHlsFrameFfmpegInput(finitePlaylist) {
  if (typeof finitePlaylist !== "string" || !finitePlaylist.startsWith("#EXTM3U\n")
    || !finitePlaylist.endsWith("#EXT-X-ENDLIST\n")
    || Buffer.byteLength(finitePlaylist) > MAX_FFMPEG_STDIN_BYTES
    || CONTROL_CHARACTER_PATTERN.test(finitePlaylist)) {
    fail("invalid_ffmpeg_input", "ffmpeg");
  }
  try {
    const normalized = parseMediaPlaylistDetails(
      finitePlaylist,
      "https://sooplive.com/frame-input.m3u8",
      MAX_FFMPEG_STDIN_BYTES,
    ).finitePlaylist;
    if (normalized !== finitePlaylist) fail("invalid_ffmpeg_input", "ffmpeg");
  } catch {
    fail("invalid_ffmpeg_input", "ffmpeg");
  }
  return Object.freeze({
    args: buildSoopHlsFrameArgs(),
    stdin: Buffer.from(finitePlaylist, "utf8"),
  });
}

function buildSoopMpegTsFrameFfmpegInput(segment) {
  if (!Buffer.isBuffer(segment) || segment.length === 0 || segment.length > MAX_SEGMENT_BYTES) {
    fail("invalid_ffmpeg_input", "ffmpeg");
  }
  return Object.freeze({
    args: buildSoopMpegTsFrameArgs(),
    stdin: Buffer.from(segment),
  });
}

module.exports = {
  DEFAULT_MAX_BATCH_BYTES,
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_MAX_SEGMENTS,
  DEFAULT_MAX_SEGMENT_BYTES,
  DEFAULT_TIMEOUT_MS,
  FFMPEG_FRAME_ARGS,
  FFMPEG_MPEGTS_FRAME_ARGS,
  SoopHlsFrameError,
  buildSoopHlsFrameArgs,
  buildSoopHlsFrameFfmpegInput,
  buildSoopMpegTsFrameArgs,
  buildSoopMpegTsFrameFfmpegInput,
  createSoopHlsFrameFetcher,
  createSoopHlsFrameSegmentBatchFetcher,
  createSoopHlsFrameSegmentFetcher,
  fetchSoopHlsFramePlaylist,
  fetchSoopHlsFrameSegment,
  parseSoopHlsMediaPlaylist,
};
