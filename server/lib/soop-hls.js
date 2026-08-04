"use strict";

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_RESPONSE_BYTES = 512 * 1024;
const BJ_ID_PATTERN = /^[A-Za-z0-9_]{1,30}$/;
const BROAD_NO_PATTERN = /^[1-9][0-9]{0,19}$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F]/;
const DEFAULT_QUALITY = "HD";
const QUALITY_SUFFIX = Object.freeze({
  SD: "sd",
  HD: "hd",
  ORIGINAL: "original",
});
const PLAYER_ORIGIN = "https://play.sooplive.com";
const STATION_ORIGIN = "https://chapi.sooplive.co.kr";
const PLAYER_API_ORIGIN = "https://live.sooplive.com";
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";
const RESOLVER_OPTION_KEYS = new Set([
  "fetchImpl",
  "timeoutMs",
  "maxResponseBytes",
  "random",
  "quality",
]);
const RESOLVE_CALL_OPTION_KEYS = new Set(["signal"]);
const ABORTED_GETTER = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted").get;
const ADD_EVENT_LISTENER = EventTarget.prototype.addEventListener;
const REMOVE_EVENT_LISTENER = EventTarget.prototype.removeEventListener;

const ERROR_MESSAGES = Object.freeze({
  invalid_bj_id: "SOOP BJ ID가 올바르지 않습니다.",
  invalid_config: "SOOP HLS resolver 설정이 올바르지 않습니다.",
  not_live: "현재 공개 LIVE 방송이 없습니다.",
  restricted_broadcast: "로그인 없는 공개 방송만 지원합니다.",
  upstream_timeout: "SOOP HLS 조회 시간이 초과되었습니다.",
  upstream_error: "SOOP HLS upstream 조회에 실패했습니다.",
  upstream_http: "SOOP HLS upstream 응답이 올바르지 않습니다.",
  response_too_large: "SOOP HLS upstream 응답이 크기 제한을 초과했습니다.",
  invalid_response: "SOOP HLS upstream 응답 형식이 올바르지 않습니다.",
  aborted: "SOOP HLS 조회가 중단되었습니다.",
});

class SoopHlsError extends Error {
  constructor(code, stage = null) {
    const safeCode = typeof code === "string" && Object.hasOwn(ERROR_MESSAGES, code)
      ? code
      : "upstream_error";
    super(ERROR_MESSAGES[safeCode]);
    this.name = "SoopHlsError";
    this.code = safeCode;
    if (typeof stage === "string" && /^[a-z]{2,16}$/.test(stage)) this.stage = stage;
  }
}

function fail(code, stage = null) {
  throw new SoopHlsError(code, stage);
}

function integerInRange(value, fallback, min, max) {
  const candidate = value === undefined ? fallback : value;
  if (!Number.isInteger(candidate) || candidate < min || candidate > max) fail("invalid_config");
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
    fail("invalid_config");
  }
  return normalized;
}

function abortSignalState(signal) {
  try {
    const aborted = ABORTED_GETTER.call(signal);
    if (typeof aborted !== "boolean") fail("invalid_config");
    return aborted;
  } catch {
    fail("invalid_config");
  }
}

function addAbortListener(signal, listener) {
  try {
    ADD_EVENT_LISTENER.call(signal, "abort", listener, { once: true });
  } catch {
    fail("invalid_config");
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

function isSoopHlsError(error) {
  try {
    return error instanceof SoopHlsError;
  } catch {
    return false;
  }
}

function normalizeResolveCallOptions(value = {}) {
  const options = strictOptions(value, RESOLVE_CALL_OPTION_KEYS);
  if (options.signal !== undefined) abortSignalState(options.signal);
  return { signal: options.signal };
}

function validQuality(value) {
  const quality = value === undefined ? DEFAULT_QUALITY : value;
  if (typeof quality !== "string" || !Object.hasOwn(QUALITY_SUFFIX, quality)) {
    fail("invalid_config");
  }
  return quality;
}

function hostMatches(hostname, root) {
  return hostname === root || hostname.endsWith(`.${root}`);
}

function isOfficialSoopHost(hostname) {
  const normalized = String(hostname || "").toLowerCase();
  return hostMatches(normalized, "sooplive.com") || hostMatches(normalized, "sooplive.co.kr");
}

function parseOfficialHttpsUrl(value, stage) {
  if (typeof value !== "string" || !value.trim() || value.length > 4_096
    || CONTROL_CHARACTER_PATTERN.test(value)) {
    fail("invalid_response", stage);
  }
  const raw = value.trim().startsWith("//") ? `https:${value.trim()}` : value.trim();
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    fail("invalid_response", stage);
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || !isOfficialSoopHost(parsed.hostname)) {
    fail("invalid_response", stage);
  }
  return parsed;
}

async function readTextLimited(response, maxBytes, stage) {
  const declaredLength = Number.parseInt(response.headers?.get?.("content-length") || "", 10);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) fail("response_too_large", stage);

  if (response.body && typeof response.body.getReader === "function") {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.length;
      if (total > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // 크기 초과 오류만 외부에 전달하고 stream 내부 정보는 숨긴다.
        }
        fail("response_too_large", stage);
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, total).toString("utf8");
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > maxBytes) fail("response_too_large", stage);
  return buffer.toString("utf8");
}

async function readJsonLimited(response, maxBytes, stage) {
  const text = await readTextLimited(response, maxBytes, stage);
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) fail("invalid_response", stage);
    return parsed;
  } catch (error) {
    if (error instanceof SoopHlsError) throw error;
    fail("invalid_response", stage);
  }
}

async function requestJson(fetchImpl, url, init, options) {
  if (options.signal && abortSignalState(options.signal)) fail("aborted", options.stage);
  const controller = new AbortController();
  let timeoutId;
  let abortListener;
  let didTimeout = false;
  let didAbort = false;
  const timeout = new Promise((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      didTimeout = true;
      controller.abort();
      reject(new SoopHlsError("upstream_timeout", options.stage));
    }, options.timeoutMs);
  });
  const aborted = options.signal ? new Promise((_resolve, reject) => {
    abortListener = () => {
      didAbort = true;
      controller.abort();
      reject(new SoopHlsError("aborted", options.stage));
    };
    addAbortListener(options.signal, abortListener);
    if (abortSignalState(options.signal)) abortListener();
  }) : null;
  const request = (async () => {
    const response = await fetchImpl(url, {
      ...init,
      credentials: "omit",
      redirect: "follow",
      signal: controller.signal,
    });
    if (!response || typeof response.ok !== "boolean") fail("invalid_response", options.stage);
    if (!response.ok) fail("upstream_http", options.stage);
    return readJsonLimited(response, options.maxResponseBytes, options.stage);
  })();
  try {
    const result = await Promise.race(aborted ? [request, timeout, aborted] : [request, timeout]);
    if (didAbort || (options.signal && abortSignalState(options.signal))) {
      fail("aborted", options.stage);
    }
    return result;
  } catch (error) {
    const errorCode = safeErrorProperty(error, "code");
    const errorName = safeErrorProperty(error, "name");
    if (didAbort || (options.signal && abortSignalState(options.signal)) || errorCode === "aborted") {
      fail("aborted", options.stage);
    }
    if (didTimeout || errorCode === "upstream_timeout") fail("upstream_timeout", options.stage);
    if (isSoopHlsError(error)) {
      throw new SoopHlsError(errorCode, safeErrorProperty(error, "stage"));
    }
    if (errorName === "AbortError") fail("upstream_timeout", options.stage);
    fail("upstream_error", options.stage);
  } finally {
    clearTimeout(timeoutId);
    if (abortListener) removeAbortListener(options.signal, abortListener);
  }
}

function requestHeaders(bjId, contentType = false) {
  const headers = {
    Accept: "application/json",
    Origin: PLAYER_ORIGIN,
    Referer: `${PLAYER_ORIGIN}/${bjId}`,
    "User-Agent": USER_AGENT,
  };
  if (contentType) headers["Content-Type"] = "application/x-www-form-urlencoded;charset=UTF-8";
  return headers;
}

function validBroadNo(value, stage) {
  const normalized = String(value ?? "").trim();
  if (!BROAD_NO_PATTERN.test(normalized)) fail("invalid_response", stage);
  return normalized;
}

function enabledFlag(value) {
  if (value === true || value === 1) return true;
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "y" || normalized === "yes";
}

function isRestrictedBroad(broad) {
  const grade = Number(broad.broad_grade ?? 0);
  return enabledFlag(broad.is_password)
    || enabledFlag(broad.subscription_only)
    || (Number.isFinite(grade) && grade > 0);
}

function playerBody(bjId, broadNo, type, quality) {
  return new URLSearchParams({
    bid: bjId,
    bno: broadNo,
    type,
    pwd: "",
    player_type: "html5",
    stream_type: "common",
    quality,
    mode: "landing",
    from_api: "0",
    is_revive: "false",
  });
}

function channelFrom(data, stage) {
  const channel = data?.CHANNEL;
  if (!channel || typeof channel !== "object" || Array.isArray(channel)
    || ![1, "1"].includes(channel.RESULT)) {
    fail("invalid_response", stage);
  }
  return channel;
}

function returnTypeForCdn(value, stage) {
  const cdn = String(value || "lg_cdn").trim().toLowerCase();
  if (cdn.includes("gs_cdn")) return "gs_cdn_pc_web";
  if (cdn.includes("lg_cdn")) return "lg_cdn_pc_web";
  if (["aws_cf", "azure_cdn", "gcp_cdn"].includes(cdn)) return cdn;
  fail("invalid_response", stage);
}

function normalizeAid(value, stage) {
  if (typeof value !== "string" || !value || value.length > 4_096 || CONTROL_CHARACTER_PATTERN.test(value)) {
    fail("invalid_response", stage);
  }
  return value;
}

function cacheBustValue(random) {
  let value;
  try {
    value = Number(random());
  } catch {
    value = 0;
  }
  if (!Number.isFinite(value)) value = 0;
  return String(Math.floor(Math.min(0.9999, Math.max(0, value)) * 10_000));
}

function createSoopHlsResolver(options = {}) {
  options = strictOptions(options, RESOLVER_OPTION_KEYS);
  const fetchImpl = options.fetchImpl === undefined ? ((...args) => fetch(...args)) : options.fetchImpl;
  if (typeof fetchImpl !== "function") fail("invalid_config");
  const quality = validQuality(options.quality);
  const timeoutMs = integerInRange(options.timeoutMs, DEFAULT_TIMEOUT_MS, 10, 30_000);
  const maxResponseBytes = integerInRange(
    options.maxResponseBytes,
    DEFAULT_MAX_RESPONSE_BYTES,
    128,
    4 * 1024 * 1024,
  );
  const random = options.random === undefined ? Math.random : options.random;
  if (typeof random !== "function") fail("invalid_config");

  const requestOptions = (stage, signal) => ({ stage, timeoutMs, maxResponseBytes, signal });

  return async function resolve(bjId, callOptions = {}) {
    const { signal } = normalizeResolveCallOptions(callOptions);
    if (signal && abortSignalState(signal)) fail("aborted");
    if (typeof bjId !== "string" || !BJ_ID_PATTERN.test(bjId)) fail("invalid_bj_id");

    const stationUrl = new URL(`/api/${encodeURIComponent(bjId)}/station`, STATION_ORIGIN);
    const station = await requestJson(fetchImpl, stationUrl, {
      method: "GET",
      headers: requestHeaders(bjId),
    }, requestOptions("station", signal));
    const broad = station.broad;
    if (!broad || typeof broad !== "object" || Array.isArray(broad)) fail("not_live", "station");
    if (isRestrictedBroad(broad)) fail("restricted_broadcast", "station");
    let broadNo = validBroadNo(broad.broad_no, "station");

    const playerUrl = new URL("/afreeca/player_live_api.php", PLAYER_API_ORIGIN);
    playerUrl.searchParams.set("bjid", bjId);
    const liveData = await requestJson(fetchImpl, playerUrl, {
      method: "POST",
      headers: requestHeaders(bjId, true),
      body: playerBody(bjId, broadNo, "live", quality),
    }, requestOptions("live", signal));
    const liveChannel = channelFrom(liveData, "live");
    if (liveChannel.BNO !== undefined && liveChannel.BNO !== null && liveChannel.BNO !== "") {
      broadNo = validBroadNo(liveChannel.BNO, "live");
    }
    const resourceDomain = parseOfficialHttpsUrl(liveChannel.RMD, "live");
    const returnType = returnTypeForCdn(liveChannel.CDN, "live");

    const aidData = await requestJson(fetchImpl, playerUrl, {
      method: "POST",
      headers: requestHeaders(bjId, true),
      body: playerBody(bjId, broadNo, "aid", quality),
    }, requestOptions("aid", signal));
    const aid = normalizeAid(channelFrom(aidData, "aid").AID, "aid");

    const assignUrl = new URL("/broad_stream_assign.html", resourceDomain);
    assignUrl.search = new URLSearchParams({
      return_type: returnType,
      use_cors: "true",
      cors_origin_url: "play.sooplive.com",
      broad_key: `${broadNo}-common-${QUALITY_SUFFIX[quality]}-hls`,
      player_mode: "landing",
      time: cacheBustValue(random),
    }).toString();
    const assigned = await requestJson(fetchImpl, assignUrl, {
      method: "GET",
      headers: requestHeaders(bjId, true),
    }, requestOptions("assign", signal));
    if (![1, "1"].includes(assigned.result)) fail("invalid_response", "assign");
    const hlsUrl = parseOfficialHttpsUrl(assigned.view_url, "assign");
    hlsUrl.searchParams.set("aid", aid);

    return {
      bjId,
      broadNo,
      quality,
      hlsUrl: hlsUrl.toString(),
    };
  };
}

function resolveSoopHls(bjId, options = {}) {
  const combinedKeys = new Set([...RESOLVER_OPTION_KEYS, ...RESOLVE_CALL_OPTION_KEYS]);
  options = strictOptions(options, combinedKeys);
  const resolverOptions = {};
  for (const key of RESOLVER_OPTION_KEYS) {
    if (Object.hasOwn(options, key)) resolverOptions[key] = options[key];
  }
  const callOptions = Object.hasOwn(options, "signal") ? { signal: options.signal } : {};
  return createSoopHlsResolver(resolverOptions)(bjId, callOptions);
}

module.exports = {
  BJ_ID_PATTERN,
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_TIMEOUT_MS,
  SoopHlsError,
  createSoopHlsResolver,
  resolveSoopHls,
};
