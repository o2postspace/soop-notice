require("dotenv").config({ quiet: true });
const express = require("express");
const cors = require("cors");
const { startAdaptiveCluster } = require("./lib/adaptive-cluster");
const { resolveIdentitySecret } = require("./lib/community-security");

function positiveNumber(name, fallback, { integer = false } = {}) {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value) || value <= 0 || (integer && !Number.isInteger(value))) {
    return fallback;
  }
  return value;
}

function nonNegativeNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function createApp(requestMetricsMiddleware) {
  const app = express();
  app.disable("x-powered-by");
  const configuredOrigins = new Set([
    "https://soopnotice.com",
    "https://www.soopnotice.com",
    ...String([process.env.CORS_ALLOWED_ORIGINS, process.env.COMMUNITY_ALLOWED_ORIGINS].filter(Boolean).join(","))
      .split(",")
      .map(value => value.trim())
      .filter(Boolean),
  ]);

  app.set("trust proxy", "loopback");

  // 모든 API 요청을 route 실행 전에 측정해 worker 증감 판단에 사용한다.
  if (requestMetricsMiddleware) app.use(requestMetricsMiddleware);
  app.use(cors({
    credentials: true,
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      if (configuredOrigins.has(origin)) return callback(null, true);
      if (process.env.NODE_ENV !== "production" && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
        return callback(null, true);
      }
      return callback(null, false);
    },
  }));
  // GitHub 서명 검증에는 파싱 전 원문 body가 필요하다.
  app.use("/webhook", require("./routes/webhook"));
  app.use(express.json({ limit: "64kb" }));

  app.use("/api/notices", require("./routes/notices"));
  app.use("/api/notice-content", require("./routes/notice-content"));
  app.use("/api/schedules", require("./routes/schedules"));
  app.use("/api/hot-notices", require("./routes/hot-notices"));
  app.use("/api/updates", require("./routes/updates"));
  app.use("/api/feedback", require("./routes/feedback"));
  app.use("/api/admin", require("./routes/admin"));
  app.use("/api/live-check", require("./routes/live-check"));
  app.use("/api/crew", require("./routes/crew"));
  app.use("/api/community", require("./routes/community"));

  return app;
}

function start() {
  const port = positiveNumber("PORT", 4000, { integer: true });
  const host = process.env.HOST || "127.0.0.1";
  if (!resolveIdentitySecret(process.env)) {
    throw new Error("COMMUNITY_IDENTITY_SECRET, SERVER_SECRET, or SESSION_SECRET must be configured before startup");
  }
  const minWorkers = positiveNumber("ADAPTIVE_MIN_WORKERS", 1, { integer: true });
  const maxWorkers = Math.max(
    minWorkers,
    positiveNumber("ADAPTIVE_MAX_WORKERS", 8, { integer: true }),
  );

  return startAdaptiveCluster({
    minWorkers,
    maxWorkers,
    scaleUpRpsPerWorker: positiveNumber("ADAPTIVE_SCALE_UP_RPS", 12),
    scaleDownRpsPerWorker: positiveNumber("ADAPTIVE_SCALE_DOWN_RPS", 6),
    scaleUpActiveRequestsPerWorker: positiveNumber("ADAPTIVE_SCALE_UP_ACTIVE", 12),
    scaleDownActiveRequestsPerWorker: positiveNumber("ADAPTIVE_SCALE_DOWN_ACTIVE", 4),
    scaleUpLagMs: positiveNumber("ADAPTIVE_SCALE_UP_LAG_MS", 80),
    criticalLagMs: positiveNumber("ADAPTIVE_CRITICAL_LAG_MS", 250),
    scaleDownLagMs: positiveNumber("ADAPTIVE_SCALE_DOWN_LAG_MS", 30),
    scaleUpCooldownMs: nonNegativeNumber("ADAPTIVE_SCALE_UP_COOLDOWN_MS", 2_000),
    scaleDownQuietMs: positiveNumber("ADAPTIVE_SCALE_DOWN_QUIET_MS", 60_000),
    sampleIntervalMs: positiveNumber("ADAPTIVE_SAMPLE_INTERVAL_MS", 1_000),
    evaluationIntervalMs: positiveNumber("ADAPTIVE_EVALUATION_INTERVAL_MS", 1_000),
    gracefulShutdownMs: positiveNumber("ADAPTIVE_GRACEFUL_SHUTDOWN_MS", 15_000),
    debugMetrics: process.env.ADAPTIVE_DEBUG_METRICS === "1",
    startPrimary: () => {
      if (process.env.RUN_CRON === "0") return undefined;
      return require("./cron").start();
    },
    startWorker: ({ requestMetricsMiddleware, workerId }) => {
      const app = createApp(requestMetricsMiddleware);
      const server = app.listen(port, host, () => {
        console.log(
          `soop-notice web worker ${workerId || "standalone"} running on ${host}:${port}`,
        );
      });
      return async () => {
        await new Promise((resolve, reject) => {
          server.close(error => {
            if (error && error.code !== "ERR_SERVER_NOT_RUNNING") reject(error);
            else resolve();
          });
        });
        await require("./db").pool.end();
      };
    },
  });
}

if (require.main === module) start();

module.exports = { createApp, start };
