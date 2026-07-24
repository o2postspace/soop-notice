require("dotenv").config({ quiet: true });
const express = require("express");
const cors = require("cors");
const { startAdaptiveCluster } = require("./lib/adaptive-cluster");

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

  // 모든 API 요청을 route 실행 전에 측정해 worker 증감 판단에 사용한다.
  if (requestMetricsMiddleware) app.use(requestMetricsMiddleware);
  app.use(cors());
  app.use(express.json());

  app.use("/api/notices", require("./routes/notices"));
  app.use("/api/notice-content", require("./routes/notice-content"));
  app.use("/api/schedules", require("./routes/schedules"));
  app.use("/api/hot-notices", require("./routes/hot-notices"));
  app.use("/api/updates", require("./routes/updates"));
  app.use("/api/feedback", require("./routes/feedback"));
  app.use("/api/admin", require("./routes/admin"));
  app.use("/api/live-check", require("./routes/live-check"));
  app.use("/api/crew", require("./routes/crew"));
  app.use("/webhook", require("./routes/webhook"));

  return app;
}

function start() {
  const port = positiveNumber("PORT", 4000, { integer: true });
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
    scaleDownLagMs: positiveNumber("ADAPTIVE_SCALE_DOWN_LAG_MS", 60),
    scaleUpCooldownMs: nonNegativeNumber("ADAPTIVE_SCALE_UP_COOLDOWN_MS", 2_000),
    scaleDownQuietMs: positiveNumber("ADAPTIVE_SCALE_DOWN_QUIET_MS", 60_000),
    sampleIntervalMs: positiveNumber("ADAPTIVE_SAMPLE_INTERVAL_MS", 1_000),
    evaluationIntervalMs: positiveNumber("ADAPTIVE_EVALUATION_INTERVAL_MS", 1_000),
    gracefulShutdownMs: positiveNumber("ADAPTIVE_GRACEFUL_SHUTDOWN_MS", 15_000),
    startPrimary: () => {
      if (process.env.RUN_CRON === "0") return undefined;
      return require("./cron").start();
    },
    startWorker: ({ requestMetricsMiddleware, workerId }) => {
      const app = createApp(requestMetricsMiddleware);
      const server = app.listen(port, () => {
        console.log(
          `soop-notice web worker ${workerId || "standalone"} running on port ${port}`,
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
