const { Router } = require("express");
const {
  createEncodedJsonCache,
  readCacheInvalidationToken,
  sendEncodedJson,
} = require("../lib/encoded-json-cache");
const { createSamgukSheetService } = require("../lib/samguk-sheet");
const { DEFAULT_QUEUE_PATH, resolveCacheStampPath } = require("../scripts/samguk-promote-observations");

const DEFAULT_CACHE_TTL_MS = 60_000;
const CACHE_CONTROL = "public, max-age=0, s-maxage=10, stale-while-revalidate=5, stale-if-error=86400";
const CDN_CACHE_CONTROL = "public, s-maxage=10, stale-while-revalidate=5, stale-if-error=86400";

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function createRouter(options = {}) {
  const router = Router();
  const service = options.service || createSamgukSheetService();
  const cacheStampPath = Object.prototype.hasOwnProperty.call(options, "cacheStampPath")
    ? options.cacheStampPath
    : resolveCacheStampPath(
      process.env.SAMGUK_OBSERVATION_QUEUE_PATH || DEFAULT_QUEUE_PATH,
      process.env.SAMGUK_API_CACHE_STAMP_PATH,
    );
  let lastCacheStampToken = null;
  const getInvalidationToken = cacheStampPath ? () => {
    try {
      lastCacheStampToken = readCacheInvalidationToken(cacheStampPath);
    } catch (error) {
      console.error("Samguk cache stamp read error:", error.message);
    }
    return lastCacheStampToken;
  } : undefined;
  const cache = options.cache || createEncodedJsonCache({
    load: () => service.load(),
    ttlMs: positiveInt(options.ttlMs ?? process.env.SAMGUK_CACHE_TTL_MS, DEFAULT_CACHE_TTL_MS),
    staleIfErrorMs: 15_000,
    getInvalidationToken,
    onRefreshError: error => console.error("Samguk cache refresh error:", error.message),
  });

  router.get("/", async (req, res) => {
    try {
      const entry = await cache.get();
      res.setHeader("CDN-Cache-Control", CDN_CACHE_CONTROL);
      res.setHeader("X-Content-Type-Options", "nosniff");
      return sendEncodedJson(req, res, entry, { cacheControl: CACHE_CONTROL });
    } catch (error) {
      console.error("Samguk data error:", error.message);
      return res.status(503).set("Cache-Control", "no-store").json({
        error: "삼국지 현황을 불러올 수 없습니다.",
      });
    }
  });

  return router;
}

const router = createRouter();

module.exports = router;
module.exports._test = {
  CACHE_CONTROL,
  CDN_CACHE_CONTROL,
  DEFAULT_CACHE_TTL_MS,
  createRouter,
  resolveCacheStampPath,
};
