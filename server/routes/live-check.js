const { Router } = require("express");
const { BJ_LIST } = require("../lib/bj-list");

const HEADERS = {
  Referer: "https://www.sooplive.co.kr/",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  Accept: "application/json",
};
const BJ_ID_PATTERN = /^[A-Za-z0-9_]{1,30}$/;
const MAX_IDS = 50;

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseBjIds(rawIds, maxIds = MAX_IDS) {
  if (typeof rawIds !== "string" || rawIds.trim() === "") {
    return { ids: [] };
  }

  const rawList = rawIds.split(",").map((id) => id.trim());
  if (rawList.length > maxIds) {
    return { error: `ids는 최대 ${maxIds}개까지 요청할 수 있습니다.` };
  }

  const ids = [];
  const seen = new Set();
  for (const id of rawList) {
    if (!BJ_ID_PATTERN.test(id)) {
      return { error: "유효하지 않은 BJ ID가 포함되어 있습니다." };
    }
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return { ids };
}

function createConcurrencyLimiter(maxConcurrency) {
  const limit = positiveInt(maxConcurrency, 8);
  const queue = [];
  let active = 0;

  function drain() {
    while (active < limit && queue.length > 0) {
      const { task, resolve, reject } = queue.shift();
      active += 1;
      Promise.resolve()
        .then(task)
        .then(resolve, reject)
        .finally(() => {
          active -= 1;
          drain();
        });
    }
  }

  return function run(task) {
    return new Promise((resolve, reject) => {
      queue.push({ task, resolve, reject });
      drain();
    });
  };
}

function createLiveStatusService(options = {}) {
  const fetchImpl = options.fetchImpl || ((...args) => fetch(...args));
  const now = options.now || Date.now;
  const ttlMs = positiveInt(options.ttlMs, 20_000);
  const failureTtlMs = positiveInt(options.failureTtlMs, 5_000);
  const timeoutMs = positiveInt(options.timeoutMs, 5_000);
  const maxCacheEntries = positiveInt(options.maxCacheEntries, 1_000);
  const runLimited = createConcurrencyLimiter(options.concurrency || 8);
  const cache = new Map();
  const inFlight = new Map();

  function setCache(bjId, value, lifetimeMs) {
    if (!cache.has(bjId) && cache.size >= maxCacheEntries) {
      cache.delete(cache.keys().next().value);
    }
    cache.delete(bjId);
    cache.set(bjId, {
      value,
      expiresAt: now() + lifetimeMs,
    });
  }

  function getFreshCache(bjId) {
    const cached = cache.get(bjId);
    if (!cached || cached.expiresAt <= now()) return undefined;

    // 자주 조회되는 BJ가 캐시 정리 때 먼저 제거되지 않도록 순서를 갱신한다.
    cache.delete(bjId);
    cache.set(bjId, cached);
    return cached.value;
  }

  function getStatus(bjId) {
    const cached = getFreshCache(bjId);
    if (cached !== undefined) return Promise.resolve(cached);

    const pending = inFlight.get(bjId);
    if (pending) return pending;

    const request = runLimited(async () => {
      const stale = cache.get(bjId);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await fetchImpl(
          `https://chapi.sooplive.co.kr/api/${bjId}/station`,
          { headers: HEADERS, signal: controller.signal }
        );
        if (!response.ok) throw new Error(`SOOP HTTP ${response.status}`);

        const data = await response.json();
        const isLive = Boolean(data && data.broad);
        setCache(bjId, isLive, ttlMs);
        return isLive;
      } catch {
        // 일시 오류 때 이미 알던 상태를 유지해 LIVE 표시가 깜빡이지 않게 한다.
        const fallback = stale ? stale.value : false;
        setCache(bjId, fallback, failureTtlMs);
        return fallback;
      } finally {
        clearTimeout(timeout);
      }
    });

    inFlight.set(bjId, request);
    request.finally(() => {
      if (inFlight.get(bjId) === request) inFlight.delete(bjId);
    });
    return request;
  }

  async function getStatuses(bjIds) {
    const statuses = await Promise.all(bjIds.map(getStatus));
    return Object.fromEntries(bjIds.map((bjId, index) => [bjId, statuses[index]]));
  }

  return {
    getStatus,
    getStatuses,
    cache,
    inFlight,
  };
}

function createRouter(options = {}) {
  const router = Router();
  const allowedBjIds = options.allowedBjIds || new Set(Object.keys(BJ_LIST));
  const service = options.service || createLiveStatusService({
    ttlMs: positiveInt(process.env.LIVE_CHECK_TTL_MS, 20_000),
    failureTtlMs: positiveInt(process.env.LIVE_CHECK_FAILURE_TTL_MS, 5_000),
    timeoutMs: positiveInt(process.env.LIVE_CHECK_TIMEOUT_MS, 5_000),
    concurrency: positiveInt(process.env.LIVE_CHECK_CONCURRENCY, 8),
  });

  router.get("/", async (req, res) => {
    const parsed = parseBjIds(req.query.ids);
    if (parsed.error) {
      return res.status(400).json({ error: parsed.error });
    }

    res.set({
      "Cache-Control": "public, max-age=10, s-maxage=15, stale-while-revalidate=30",
      "CDN-Cache-Control": "public, s-maxage=15, stale-while-revalidate=30",
      "X-Content-Type-Options": "nosniff",
    });
    if (parsed.ids.length === 0) return res.json({});

    const knownIds = parsed.ids.filter(id => allowedBjIds.has(id));
    const results = Object.fromEntries(parsed.ids.map(id => [id, false]));
    if (knownIds.length > 0) {
      Object.assign(results, await service.getStatuses(knownIds));
    }
    return res.json(results);
  });

  return router;
}

const router = createRouter();

module.exports = router;
module.exports._test = {
  BJ_ID_PATTERN,
  MAX_IDS,
  createConcurrencyLimiter,
  createLiveStatusService,
  createRouter,
  parseBjIds,
};
