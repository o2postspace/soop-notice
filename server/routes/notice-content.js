const { Router } = require("express");
const { select, inPlaceholders } = require("../db");
const { BJ_LIST } = require("../lib/bj-list");

const DEFAULT_RATE_LIMIT = 120;
const DEFAULT_RATE_WINDOW_MS = 60_000;
const PUBLIC_ORIGINS = Object.freeze([
  "https://soopnotice.com",
  "https://www.soopnotice.com",
]);

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeOrigin(value) {
  try {
    const origin = new URL(String(value));
    if (origin.protocol !== "https:" && origin.protocol !== "http:") return null;
    return origin.origin;
  } catch {
    return null;
  }
}

function createAllowedOrigins(env = process.env) {
  const configured = [env.CORS_ALLOWED_ORIGINS, env.COMMUNITY_ALLOWED_ORIGINS]
    .filter(Boolean)
    .join(",")
    .split(",")
    .map(value => normalizeOrigin(value.trim()))
    .filter(Boolean);
  return new Set([...PUBLIC_ORIGINS, ...configured]);
}

function isRequestOriginAllowed(req, allowedOrigins, env = process.env) {
  const rawOrigin = req.get("Origin");
  if (!rawOrigin) return true;

  const origin = normalizeOrigin(rawOrigin);
  if (!origin) return false;
  if (allowedOrigins.has(origin)) return true;

  const host = req.get("Host");
  const requestOrigin = host ? normalizeOrigin(`${req.protocol}://${host}`) : null;
  if (requestOrigin === origin) return true;

  return env.NODE_ENV !== "production"
    && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

function createFixedWindowRateLimiter({
  limit = DEFAULT_RATE_LIMIT,
  windowMs = DEFAULT_RATE_WINDOW_MS,
  now = Date.now,
} = {}) {
  const normalizedLimit = positiveInteger(limit, DEFAULT_RATE_LIMIT);
  const normalizedWindowMs = positiveInteger(windowMs, DEFAULT_RATE_WINDOW_MS);
  const clients = new Map();
  let requestCount = 0;

  return function fixedWindowRateLimiter(req, res, next) {
    const currentTime = now();
    const clientKey = req.ip || req.socket?.remoteAddress || "unknown";
    let state = clients.get(clientKey);
    if (!state || currentTime >= state.resetAt) {
      state = { count: 0, resetAt: currentTime + normalizedWindowMs };
      clients.set(clientKey, state);
    }

    if (++requestCount % 256 === 0) {
      for (const [key, value] of clients) {
        if (currentTime >= value.resetAt) clients.delete(key);
      }
    }

    const resetSeconds = Math.max(1, Math.ceil((state.resetAt - currentTime) / 1000));
    res.setHeader("RateLimit-Limit", String(normalizedLimit));
    res.setHeader("RateLimit-Reset", String(resetSeconds));
    if (state.count >= normalizedLimit) {
      res.setHeader("RateLimit-Remaining", "0");
      res.setHeader("Retry-After", String(resetSeconds));
      res.setHeader("Cache-Control", "no-store");
      return res.status(429).json({ error: "Too many requests" });
    }

    state.count += 1;
    res.setHeader("RateLimit-Remaining", String(normalizedLimit - state.count));
    return next();
  };
}

function createRouter({
  selectFn = select,
  bjList = BJ_LIST,
  env = process.env,
  allowedOrigins = createAllowedOrigins(env),
  rateLimiter,
  rateLimit = positiveInteger(env.NOTICE_CONTENT_RATE_LIMIT, DEFAULT_RATE_LIMIT),
  rateWindowMs = positiveInteger(env.NOTICE_CONTENT_RATE_WINDOW_MS, DEFAULT_RATE_WINDOW_MS),
  now = Date.now,
} = {}) {
  const router = Router();
  const validIds = Object.keys(bjList);
  const normalizedAllowedOrigins = new Set(
    [...allowedOrigins].map(normalizeOrigin).filter(Boolean)
  );
  const limitRequests = rateLimiter || createFixedWindowRateLimiter({
    limit: rateLimit,
    windowMs: rateWindowMs,
    now,
  });
  const sql = `SELECT content_html FROM notices
    WHERE title_no = ? AND bj_id IN (${inPlaceholders(validIds)}) LIMIT 1`;

  router.use((req, res, next) => {
    res.setHeader("X-Robots-Tag", "noindex, noarchive, nosnippet");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");
    res.vary("Origin");
    if (!isRequestOriginAllowed(req, normalizedAllowedOrigins, env)) {
      return res.status(403).json({ error: "Origin not allowed" });
    }
    return next();
  });
  router.use(limitRequests);

  router.get("/", async (req, res) => {
    const rawTitleNo = String(req.query.title_no || "");
    const titleNo = Number(rawTitleNo);
    if (!/^\d+$/.test(rawTitleNo) || !Number.isSafeInteger(titleNo) || titleNo <= 0) {
      return res.status(400).json({ error: "valid title_no required" });
    }

    try {
      const rows = await selectFn(sql, [titleNo, ...validIds]);
      if (rows.length === 0) return res.status(404).json({ error: "Not found" });
      res.setHeader("Cache-Control", "private, max-age=300");
      return res.json({ content_html: rows[0].content_html || "" });
    } catch (error) {
      console.error("[notice-content] query failed:", error.message);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
}

const router = createRouter();

module.exports = router;
module.exports.createRouter = createRouter;
module.exports._test = {
  DEFAULT_RATE_LIMIT,
  DEFAULT_RATE_WINDOW_MS,
  PUBLIC_ORIGINS,
  createAllowedOrigins,
  createFixedWindowRateLimiter,
  createRouter,
  isRequestOriginAllowed,
  normalizeOrigin,
};
