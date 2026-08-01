const { Router } = require("express");
const { createEncodedJsonCache, sendEncodedJson } = require("../lib/encoded-json-cache");
const { createSamgukSheetService } = require("../lib/samguk-sheet");

const DEFAULT_CACHE_TTL_MS = 60_000;
const CACHE_CONTROL = "public, max-age=15, s-maxage=60, stale-while-revalidate=300, stale-if-error=86400";
const CDN_CACHE_CONTROL = "public, s-maxage=60, stale-while-revalidate=300, stale-if-error=86400";

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function createRouter(options = {}) {
  const router = Router();
  const service = options.service || createSamgukSheetService();
  const cache = options.cache || createEncodedJsonCache({
    load: () => service.load(),
    ttlMs: positiveInt(options.ttlMs ?? process.env.SAMGUK_CACHE_TTL_MS, DEFAULT_CACHE_TTL_MS),
    staleIfErrorMs: 15_000,
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
};
