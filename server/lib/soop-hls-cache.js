"use strict";

const DEFAULT_TTL_MS = 60_000;
const MAX_TTL_MS = 10 * 60_000;
const MAX_BJ_IDS = 90;
const QUALITIES = Object.freeze(["SD", "HD", "ORIGINAL"]);
const BJ_ID_PATTERN = /^[A-Za-z0-9_]{1,30}$/;
const BROAD_NO_PATTERN = /^[1-9][0-9]{0,19}$/;
const MAX_URL_LENGTH = 16 * 1024;
const URL_CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F]/;
const CACHE_OPTION_KEYS = new Set(["resolvers", "ttlMs", "maxBjIds", "clock"]);
const GET_CALL_OPTION_KEYS = new Set(["signal"]);
const ABORTED_GETTER = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted").get;
const ADD_EVENT_LISTENER = EventTarget.prototype.addEventListener;
const REMOVE_EVENT_LISTENER = EventTarget.prototype.removeEventListener;

const ERROR_MESSAGES = Object.freeze({
  invalid_config: "SOOP HLS cache 설정이 올바르지 않습니다.",
  invalid_bj_id: "SOOP BJ ID가 올바르지 않습니다.",
  invalid_quality: "SOOP HLS 품질이 올바르지 않습니다.",
  invalid_time: "SOOP HLS cache 시간이 올바르지 않습니다.",
  invalid_result: "SOOP HLS resolver 결과가 올바르지 않습니다.",
  not_live: "현재 공개 LIVE 방송이 없습니다.",
  restricted_broadcast: "로그인 없는 공개 방송만 지원합니다.",
  upstream_timeout: "SOOP HLS 조회 시간이 초과되었습니다.",
  upstream_error: "SOOP HLS upstream 조회에 실패했습니다.",
  upstream_http: "SOOP HLS upstream 응답이 올바르지 않습니다.",
  invalid_response: "SOOP HLS upstream 응답 형식이 올바르지 않습니다.",
  resolve_failed: "SOOP HLS 조회에 실패했습니다.",
  aborted: "SOOP HLS 조회가 중단되었습니다.",
});
const SAFE_RESOLVER_CODES = new Set([
  "not_live",
  "restricted_broadcast",
  "upstream_timeout",
  "upstream_error",
  "upstream_http",
  "invalid_response",
  "aborted",
]);

class SoopHlsCacheError extends Error {
  constructor(code) {
    const safeCode = typeof code === "string" && Object.hasOwn(ERROR_MESSAGES, code)
      ? code
      : "resolve_failed";
    super(ERROR_MESSAGES[safeCode]);
    this.name = "SoopHlsCacheError";
    this.code = safeCode;
  }
}

function fail(code) {
  throw new SoopHlsCacheError(code);
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

function normalizeGetCallOptions(value = {}) {
  const options = strictOptions(value, GET_CALL_OPTION_KEYS);
  if (options.signal !== undefined) abortSignalState(options.signal);
  return { signal: options.signal };
}

function validBjId(value) {
  if (typeof value !== "string" || !BJ_ID_PATTERN.test(value)) fail("invalid_bj_id");
  return value;
}

function validQuality(value) {
  if (typeof value !== "string" || !QUALITIES.includes(value)) fail("invalid_quality");
  return value;
}

function positiveInteger(value, fallback, max) {
  const candidate = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(candidate) || candidate <= 0 || candidate > max) fail("invalid_config");
  return candidate;
}

function hostMatches(hostname, root) {
  return hostname === root || hostname.endsWith(`.${root}`);
}

function isOfficialHlsUrl(value) {
  if (typeof value !== "string" || !value || value.length > MAX_URL_LENGTH
    || URL_CONTROL_CHARACTER_PATTERN.test(value)) return false;
  try {
    const parsed = new URL(value);
    const hostname = parsed.hostname.toLowerCase();
    return parsed.protocol === "https:" && !parsed.username && !parsed.password
      && (!parsed.port || parsed.port === "443")
      && (hostMatches(hostname, "sooplive.com") || hostMatches(hostname, "sooplive.co.kr"));
  } catch {
    return false;
  }
}

function normalizeResult(result, bjId, quality) {
  if (!result || typeof result !== "object" || Array.isArray(result)
    || result.bjId !== bjId || result.quality !== quality || !isOfficialHlsUrl(result.hlsUrl)) {
    fail("invalid_result");
  }
  const broadNo = String(result.broadNo ?? "").trim();
  if (!BROAD_NO_PATTERN.test(broadNo)) fail("invalid_result");
  return Object.freeze({
    bjId,
    broadNo,
    quality,
    hlsUrl: result.hlsUrl,
  });
}

function sanitizedResolverCode(error) {
  let code;
  try {
    code = error && typeof error === "object" ? error.code : null;
  } catch {
    return "resolve_failed";
  }
  if (SAFE_RESOLVER_CODES.has(code)) return code;
  return "resolve_failed";
}

function createSoopHlsCache(options = {}) {
  options = strictOptions(options, CACHE_OPTION_KEYS);
  const resolvers = options.resolvers;
  let validResolvers = false;
  try {
    validResolvers = Boolean(resolvers)
      && typeof resolvers === "object"
      && !Array.isArray(resolvers)
      && typeof resolvers.SD === "function"
      && (typeof resolvers.HD === "function" || typeof resolvers.ORIGINAL === "function")
      && (resolvers.HD === undefined || typeof resolvers.HD === "function")
      && (resolvers.ORIGINAL === undefined || typeof resolvers.ORIGINAL === "function");
  } catch {
    validResolvers = false;
  }
  if (!validResolvers) {
    fail("invalid_config");
  }
  const ttlMs = positiveInteger(options.ttlMs, DEFAULT_TTL_MS, MAX_TTL_MS);
  const maxBjIds = positiveInteger(options.maxBjIds, MAX_BJ_IDS, MAX_BJ_IDS);
  const clock = options.clock === undefined ? Date.now : options.clock;
  if (typeof clock !== "function") fail("invalid_config");

  const entries = new Map();
  const bjAccess = new Map();
  let accessSequence = 0;
  const stats = {
    hits: 0,
    misses: 0,
    deduped: 0,
    resolverErrors: 0,
    invalidations: 0,
    evictions: 0,
  };

  function now() {
    let value;
    try {
      value = clock();
    } catch {
      fail("invalid_time");
    }
    if (!Number.isFinite(value) || value < 0) fail("invalid_time");
    return value;
  }

  function keyFor(bjId, quality) {
    return `${bjId}\u0000${quality}`;
  }

  function touchBj(bjId) {
    accessSequence += 1;
    bjAccess.set(bjId, accessSequence);
  }

  function deleteEntry(key, state) {
    state.generation += 1;
    state.value = null;
    state.expiresAt = 0;
    state.pending = null;
    entries.delete(key);
  }

  function deleteBj(bjId) {
    let removed = 0;
    for (const quality of QUALITIES) {
      const key = keyFor(bjId, quality);
      const state = entries.get(key);
      if (!state) continue;
      deleteEntry(key, state);
      removed += 1;
    }
    bjAccess.delete(bjId);
    return removed;
  }

  function cleanupBjIfEmpty(bjId) {
    if (QUALITIES.every(quality => !entries.has(keyFor(bjId, quality)))) {
      bjAccess.delete(bjId);
    }
  }

  function ensureBjCapacity(bjId) {
    if (bjAccess.has(bjId) || bjAccess.size < maxBjIds) return;
    let oldestBjId = null;
    let oldestAccess = Number.POSITIVE_INFINITY;
    for (const [candidateBjId, lastAccess] of bjAccess) {
      if (lastAccess < oldestAccess) {
        oldestAccess = lastAccess;
        oldestBjId = candidateBjId;
      }
    }
    if (oldestBjId === null) fail("invalid_config");
    deleteBj(oldestBjId);
    stats.evictions += 1;
  }

  function createState(bjId, quality) {
    const key = keyFor(bjId, quality);
    const state = {
      bjId,
      quality,
      generation: 0,
      value: null,
      expiresAt: 0,
      pending: null,
    };
    entries.set(key, state);
    return { key, state };
  }

  function resolveWithSignal(resolver, bjId, signal) {
    if (signal && abortSignalState(signal)) {
      return Promise.reject(new SoopHlsCacheError("aborted"));
    }
    const work = Promise.resolve().then(() => {
      if (signal && abortSignalState(signal)) throw new SoopHlsCacheError("aborted");
      return signal ? resolver(bjId, { signal }) : resolver(bjId);
    });
    if (!signal) return work;

    let abortListener;
    const aborted = new Promise((_resolve, reject) => {
      abortListener = () => reject(new SoopHlsCacheError("aborted"));
      addAbortListener(signal, abortListener);
      if (abortSignalState(signal)) abortListener();
    });
    return Promise.race([work, aborted]).finally(() => {
      removeAbortListener(signal, abortListener);
    });
  }

  function get(bjIdInput, qualityInput, callOptions = {}) {
    const { signal } = normalizeGetCallOptions(callOptions);
    const bjId = validBjId(bjIdInput);
    const quality = validQuality(qualityInput);
    if (typeof resolvers[quality] !== "function") fail("invalid_quality");
    if (signal && abortSignalState(signal)) {
      return Promise.reject(new SoopHlsCacheError("aborted"));
    }
    const currentTime = now();
    ensureBjCapacity(bjId);
    touchBj(bjId);
    const key = keyFor(bjId, quality);
    let state = entries.get(key);
    if (!state) ({ state } = createState(bjId, quality));

    if (state.value && currentTime < state.expiresAt) {
      stats.hits += 1;
      return Promise.resolve(state.value);
    }
    if (state.value) {
      state.value = null;
      state.expiresAt = 0;
    }
    if (state.pending) {
      stats.deduped += 1;
      return state.pending;
    }

    stats.misses += 1;
    state.generation += 1;
    const generation = state.generation;
    const resolver = resolvers[quality];
    let pending;
    pending = resolveWithSignal(resolver, bjId, signal)
      .then(
        (rawResult) => {
          if (signal && abortSignalState(signal)) {
            stats.resolverErrors += 1;
            throw new SoopHlsCacheError("aborted");
          }
          let result;
          try {
            result = normalizeResult(rawResult, bjId, quality);
          } catch {
            stats.resolverErrors += 1;
            throw new SoopHlsCacheError("invalid_result");
          }
          if (entries.get(key) === state && state.generation === generation) {
            state.value = result;
            state.expiresAt = now() + ttlMs;
          }
          return result;
        },
        (error) => {
          stats.resolverErrors += 1;
          throw new SoopHlsCacheError(sanitizedResolverCode(error));
        },
      )
      .finally(() => {
        if (entries.get(key) !== state || state.generation !== generation) return;
        if (state.pending === pending) state.pending = null;
        if (!state.value) {
          entries.delete(key);
          cleanupBjIfEmpty(bjId);
        }
      });
    state.pending = pending;
    return pending;
  }

  function invalidate(bjIdInput, qualityInput) {
    const bjId = validBjId(bjIdInput);
    if (qualityInput === undefined) {
      const removed = deleteBj(bjId);
      if (removed > 0) stats.invalidations += 1;
      return removed;
    }
    const quality = validQuality(qualityInput);
    const key = keyFor(bjId, quality);
    const state = entries.get(key);
    if (!state) return 0;
    deleteEntry(key, state);
    cleanupBjIfEmpty(bjId);
    stats.invalidations += 1;
    return 1;
  }

  function clear() {
    const removed = entries.size;
    for (const [key, state] of entries) deleteEntry(key, state);
    bjAccess.clear();
    if (removed > 0) stats.invalidations += 1;
    return removed;
  }

  function getSnapshot() {
    const currentTime = now();
    const byQuality = {
      SD: { entries: 0, cached: 0, pending: 0 },
      HD: { entries: 0, cached: 0, pending: 0 },
      ORIGINAL: { entries: 0, cached: 0, pending: 0 },
    };
    for (const [key, state] of [...entries]) {
      if (state.value && currentTime >= state.expiresAt) {
        state.value = null;
        state.expiresAt = 0;
      }
      if (!state.value && !state.pending) {
        entries.delete(key);
        cleanupBjIfEmpty(state.bjId);
        continue;
      }
      const qualityStats = byQuality[state.quality];
      qualityStats.entries += 1;
      if (state.value) qualityStats.cached += 1;
      if (state.pending) qualityStats.pending += 1;
    }
    const cachedCount = QUALITIES.reduce((total, quality) => total + byQuality[quality].cached, 0);
    const pendingCount = QUALITIES.reduce((total, quality) => total + byQuality[quality].pending, 0);
    return {
      ttlMs,
      maxBjIds,
      maxEntries: maxBjIds * QUALITIES.length,
      bjCount: bjAccess.size,
      entryCount: entries.size,
      cachedCount,
      pendingCount,
      byQuality,
      stats: { ...stats },
    };
  }

  return Object.freeze({ clear, get, getSnapshot, invalidate });
}

module.exports = {
  BJ_ID_PATTERN,
  DEFAULT_TTL_MS,
  MAX_BJ_IDS,
  MAX_TTL_MS,
  QUALITIES,
  SoopHlsCacheError,
  createSoopHlsCache,
};
