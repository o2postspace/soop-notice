"use strict";

const cluster = require("node:cluster");
const { monitorEventLoopDelay } = require("node:perf_hooks");

const MESSAGE_TYPES = Object.freeze({
  METRICS: "adaptive-cluster:metrics",
  SHUTDOWN: "adaptive-cluster:shutdown",
});

const DEFAULT_OPTIONS = Object.freeze({
  minWorkers: 1,
  maxWorkers: 8,
  sampleIntervalMs: 1_000,
  evaluationIntervalMs: 1_000,
  staleMetricsMs: 5_000,
  eventLoopResolutionMs: 20,
  scaleUpRpsPerWorker: 12,
  scaleDownRpsPerWorker: 6,
  scaleUpActiveRequestsPerWorker: 12,
  scaleDownActiveRequestsPerWorker: 4,
  scaleUpLagMs: 80,
  criticalLagMs: 250,
  scaleDownLagMs: 30,
  scaleUpCooldownMs: 2_000,
  scaleDownQuietMs: 60_000,
  crashRestartDelayMs: 500,
  gracefulShutdownMs: 15_000,
});

const POSITIVE_OPTION_NAMES = [
  "minWorkers",
  "maxWorkers",
  "sampleIntervalMs",
  "evaluationIntervalMs",
  "staleMetricsMs",
  "eventLoopResolutionMs",
  "scaleUpRpsPerWorker",
  "scaleDownRpsPerWorker",
  "scaleUpActiveRequestsPerWorker",
  "scaleDownActiveRequestsPerWorker",
  "scaleUpLagMs",
  "criticalLagMs",
  "scaleDownLagMs",
  "scaleDownQuietMs",
  "gracefulShutdownMs",
];

function normalizeOptions(overrides = {}) {
  const options = { ...DEFAULT_OPTIONS, ...overrides };

  for (const name of POSITIVE_OPTION_NAMES) {
    if (!Number.isFinite(options[name]) || options[name] <= 0) {
      throw new TypeError(`${name} must be a positive number`);
    }
  }

  for (const name of ["scaleUpCooldownMs", "crashRestartDelayMs"]) {
    if (!Number.isFinite(options[name]) || options[name] < 0) {
      throw new TypeError(`${name} must be a non-negative number`);
    }
  }

  if (!Number.isInteger(options.minWorkers) || !Number.isInteger(options.maxWorkers)) {
    throw new TypeError("minWorkers and maxWorkers must be integers");
  }
  if (options.minWorkers > options.maxWorkers) {
    throw new RangeError("minWorkers cannot be greater than maxWorkers");
  }
  if (options.scaleDownRpsPerWorker > options.scaleUpRpsPerWorker) {
    throw new RangeError("scaleDownRpsPerWorker cannot exceed scaleUpRpsPerWorker");
  }
  if (options.scaleDownActiveRequestsPerWorker > options.scaleUpActiveRequestsPerWorker) {
    throw new RangeError(
      "scaleDownActiveRequestsPerWorker cannot exceed scaleUpActiveRequestsPerWorker",
    );
  }
  if (options.scaleDownLagMs >= options.scaleUpLagMs) {
    throw new RangeError("scaleDownLagMs must be less than scaleUpLagMs");
  }
  if (options.criticalLagMs < options.scaleUpLagMs) {
    throw new RangeError("criticalLagMs cannot be less than scaleUpLagMs");
  }

  return options;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function finiteNonNegative(value) {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function isClosedIpcError(error) {
  return error && (
    error.code === "ERR_IPC_CHANNEL_CLOSED"
    || error.code === "ERR_IPC_DISCONNECTED"
  );
}

/**
 * Worker 표본을 primary가 판단할 수 있는 단일 부하 값으로 합친다.
 * 오래된 표본은 부하를 0으로 오인하지 않고 telemetryComplete=false로 표시한다.
 */
function aggregateWorkerMetrics(
  samples,
  {
    now = Date.now(),
    staleMetricsMs = DEFAULT_OPTIONS.staleMetricsMs,
    workerCount,
  } = {},
) {
  const values = samples instanceof Map ? [...samples.values()] : [...(samples || [])];
  const expectedWorkers = Number.isInteger(workerCount) ? workerCount : values.length;
  let requestsPerSecond = 0;
  let activeRequests = 0;
  let eventLoopLagMs = 0;
  let freshWorkers = 0;

  for (const sample of values) {
    if (!sample || !Number.isFinite(sample.timestamp)) continue;
    if (now - sample.timestamp > staleMetricsMs) continue;

    freshWorkers += 1;
    requestsPerSecond += finiteNonNegative(sample.requestsPerSecond);
    activeRequests += finiteNonNegative(sample.activeRequests);
    eventLoopLagMs = Math.max(
      eventLoopLagMs,
      finiteNonNegative(sample.eventLoopLagMs),
    );
  }

  return {
    requestsPerSecond,
    activeRequests,
    eventLoopLagMs,
    freshWorkers,
    missingWorkers: Math.max(0, expectedWorkers - freshWorkers),
    telemetryComplete: freshWorkers >= expectedWorkers,
  };
}

/**
 * 현재 부하로 필요한 worker 수와 hysteresis용 상태를 계산하는 순수 함수다.
 */
function decideWorkerCount(state, overrides = {}) {
  const options = normalizeOptions(overrides);
  const currentWorkers = clamp(
    Math.trunc(finiteNonNegative(state.currentWorkers)),
    0,
    options.maxWorkers,
  );
  const requestsPerSecond = finiteNonNegative(state.requestsPerSecond);
  const activeRequests = finiteNonNegative(state.activeRequests);
  const eventLoopLagMs = finiteNonNegative(state.eventLoopLagMs);
  const telemetryComplete = state.telemetryComplete !== false;
  const now = Number.isFinite(state.now) ? state.now : Date.now();
  const lastScaleAt = Number.isFinite(state.lastScaleAt)
    ? state.lastScaleAt
    : Number.NEGATIVE_INFINITY;
  const previousUnderloadSince = Number.isFinite(state.underloadSince)
    ? state.underloadSince
    : null;
  const reasons = [];

  if (currentWorkers < options.minWorkers) {
    return {
      action: "scale-up",
      targetWorkers: options.minWorkers,
      underloadSince: null,
      reasons: ["below-minimum"],
    };
  }

  const requestScaleUpTarget = requestsPerSecond > 0
    ? Math.ceil(requestsPerSecond / options.scaleUpRpsPerWorker)
    : options.minWorkers;
  const activeScaleUpTarget = activeRequests > 0
    ? Math.ceil(activeRequests / options.scaleUpActiveRequestsPerWorker)
    : options.minWorkers;
  let scaleUpTarget = clamp(
    Math.max(options.minWorkers, requestScaleUpTarget, activeScaleUpTarget),
    options.minWorkers,
    options.maxWorkers,
  );

  if (requestScaleUpTarget > currentWorkers) reasons.push("request-rate");
  if (activeScaleUpTarget > currentWorkers) reasons.push("active-requests");

  if (eventLoopLagMs >= options.criticalLagMs) {
    scaleUpTarget = options.maxWorkers;
    reasons.push("critical-event-loop-lag");
  } else if (eventLoopLagMs >= options.scaleUpLagMs) {
    scaleUpTarget = Math.max(
      scaleUpTarget,
      clamp(
        currentWorkers + Math.max(1, Math.ceil(currentWorkers / 2)),
        options.minWorkers,
        options.maxWorkers,
      ),
    );
    reasons.push("event-loop-lag");
  }

  // 표본이 끊긴 worker는 event loop가 멈췄을 수 있으므로 용량을 하나 보강한다.
  if (!telemetryComplete && currentWorkers < options.maxWorkers) {
    scaleUpTarget = Math.max(scaleUpTarget, currentWorkers + 1);
    reasons.push("missing-telemetry");
  }

  if (scaleUpTarget > currentWorkers) {
    if (now - lastScaleAt < options.scaleUpCooldownMs) {
      return {
        action: "hold",
        targetWorkers: currentWorkers,
        underloadSince: null,
        reasons: [...reasons, "scale-up-cooldown"],
      };
    }
    return {
      action: "scale-up",
      targetWorkers: scaleUpTarget,
      underloadSince: null,
      reasons,
    };
  }

  // 표본이 빠졌거나 event loop가 아직 바쁘면 worker를 줄이지 않는다.
  if (!telemetryComplete || eventLoopLagMs > options.scaleDownLagMs) {
    return {
      action: "hold",
      targetWorkers: currentWorkers,
      underloadSince: null,
      reasons: [!telemetryComplete ? "incomplete-telemetry" : "event-loop-not-quiet"],
    };
  }

  // 축소에는 더 보수적인 임계값을 사용해 경계 부하에서 출렁이지 않게 한다.
  const requestScaleDownTarget = requestsPerSecond > 0
    ? Math.ceil(requestsPerSecond / options.scaleDownRpsPerWorker)
    : options.minWorkers;
  const activeScaleDownTarget = activeRequests > 0
    ? Math.ceil(activeRequests / options.scaleDownActiveRequestsPerWorker)
    : options.minWorkers;
  const scaleDownTarget = clamp(
    Math.max(options.minWorkers, requestScaleDownTarget, activeScaleDownTarget),
    options.minWorkers,
    options.maxWorkers,
  );

  if (scaleDownTarget >= currentWorkers) {
    return {
      action: "hold",
      targetWorkers: currentWorkers,
      underloadSince: null,
      reasons: ["capacity-needed"],
    };
  }

  const underloadSince = previousUnderloadSince ?? now;
  if (now - underloadSince < options.scaleDownQuietMs) {
    return {
      action: "hold",
      targetWorkers: currentWorkers,
      underloadSince,
      reasons: ["scale-down-quiet-period"],
    };
  }

  return {
    action: "scale-down",
    targetWorkers: scaleDownTarget,
    underloadSince: null,
    reasons: ["sustained-underload"],
  };
}

function createRequestMetrics() {
  let requests = 0;
  let activeRequests = 0;

  function middleware(_request, response, next) {
    requests += 1;
    activeRequests += 1;
    let settled = false;

    const settle = () => {
      if (settled) return;
      settled = true;
      activeRequests = Math.max(0, activeRequests - 1);
    };

    response.once("finish", settle);
    response.once("close", settle);
    next();
  }

  function snapshotAndReset() {
    const snapshot = { requests, activeRequests };
    requests = 0;
    return snapshot;
  }

  return { middleware, snapshotAndReset };
}

function closeWorkerResource(resource) {
  if (!resource) return Promise.resolve();
  if (typeof resource === "function") return Promise.resolve().then(resource);

  const close = typeof resource.close === "function"
    ? resource.close.bind(resource)
    : resource.server && typeof resource.server.close === "function"
      ? resource.server.close.bind(resource.server)
      : null;
  if (!close) return Promise.resolve();

  return new Promise((resolve, reject) => {
    let completed = false;
    const done = (error) => {
      if (completed) return;
      completed = true;
      if (error && error.code !== "ERR_SERVER_NOT_RUNNING") reject(error);
      else resolve();
    };

    try {
      const result = close(done);
      if (result && typeof result.then === "function") result.then(resolve, done);
    } catch (error) {
      done(error);
    }
  });
}

function startWorkerRuntime({ startWorker, options, logger }) {
  if (typeof startWorker !== "function") {
    throw new TypeError("startWorker must be a function");
  }

  const requestMetrics = createRequestMetrics();
  const eventLoopDelay = monitorEventLoopDelay({
    resolution: Math.max(1, Math.trunc(options.eventLoopResolutionMs)),
  });
  eventLoopDelay.enable();

  let previousSampleAt = Date.now();
  let shuttingDown = false;
  let resourcePromise;

  try {
    resourcePromise = Promise.resolve(startWorker({
      requestMetricsMiddleware: requestMetrics.middleware,
      workerId: cluster.worker && cluster.worker.id,
    }));
  } catch (error) {
    resourcePromise = Promise.reject(error);
  }

  resourcePromise.catch((error) => {
    logger.error("[adaptive-cluster] web worker failed to start:", error);
    process.exitCode = 1;
    setImmediate(() => process.exit(1));
  });

  const sampleTimer = setInterval(() => {
    if (shuttingDown || !process.connected || typeof process.send !== "function") return;

    const now = Date.now();
    const elapsedMs = Math.max(1, now - previousSampleAt);
    previousSampleAt = now;
    const snapshot = requestMetrics.snapshotAndReset();
    const percentile99 = eventLoopDelay.percentile(99) / 1e6;
    eventLoopDelay.reset();

    try {
      process.send({
        type: MESSAGE_TYPES.METRICS,
        requestsPerSecond: snapshot.requests * 1_000 / elapsedMs,
        activeRequests: snapshot.activeRequests,
        eventLoopLagMs: Number.isFinite(percentile99) ? percentile99 : 0,
        timestamp: now,
      }, (error) => {
        if (error && !isClosedIpcError(error)) {
          logger.error("[adaptive-cluster] metrics message failed:", error);
        }
      });
    } catch (error) {
      if (!isClosedIpcError(error)) {
        logger.error("[adaptive-cluster] metrics message failed:", error);
      }
    }
  }, options.sampleIntervalMs);

  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(sampleTimer);
    eventLoopDelay.disable();

    const forceExitTimer = setTimeout(() => {
      logger.error("[adaptive-cluster] worker graceful shutdown timed out");
      process.exit(1);
    }, options.gracefulShutdownMs);
    forceExitTimer.unref();

    try {
      await closeWorkerResource(await resourcePromise);
      clearTimeout(forceExitTimer);
      // close callback이 끝났으면 진행 중 요청은 모두 비워졌다. DB pool 같은
      // 별도 handle이 프로세스를 붙잡지 않도록 worker 수명도 여기서 끝낸다.
      process.exit(0);
    } catch (error) {
      logger.error("[adaptive-cluster] worker shutdown failed:", error);
      process.exit(1);
    }
  }

  process.on("message", (message) => {
    if (message && message.type === MESSAGE_TYPES.SHUTDOWN) void shutdown();
  });
  process.once("disconnect", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
  process.once("SIGINT", () => void shutdown());

  return {
    role: "worker",
    requestMetricsMiddleware: requestMetrics.middleware,
    shutdown,
  };
}

function startPrimaryRuntime({ startPrimary, options, logger }) {
  const samples = new Map();
  const retiringWorkers = new Set();
  let desiredWorkers = options.minWorkers;
  let underloadSince = null;
  let lastScaleAt = Number.NEGATIVE_INFINITY;
  let stopping = false;
  let primaryCleanup = null;
  let shutdownPromise = null;
  let primaryStartPromise = Promise.resolve(null);

  if (typeof startPrimary === "function") {
    try {
      primaryStartPromise = Promise.resolve(startPrimary())
        .then((cleanup) => {
          if (typeof cleanup === "function") primaryCleanup = cleanup;
          return primaryCleanup;
        })
        .catch((error) => {
          logger.error("[adaptive-cluster] primary task failed:", error);
          return null;
        });
    } catch (error) {
      logger.error("[adaptive-cluster] primary task failed:", error);
    }
  }

  function liveWorkers() {
    return Object.values(cluster.workers || {}).filter(Boolean);
  }

  function attachWorker(worker) {
    // 기동 직후 첫 표본 전에는 stale로 오인하지 않도록 빈 최신 표본을 둔다.
    samples.set(worker.id, {
      requestsPerSecond: 0,
      activeRequests: 0,
      eventLoopLagMs: 0,
      timestamp: Date.now(),
    });

    worker.on("message", (message) => {
      if (!message || message.type !== MESSAGE_TYPES.METRICS) return;
      samples.set(worker.id, {
        requestsPerSecond: finiteNonNegative(message.requestsPerSecond),
        activeRequests: finiteNonNegative(message.activeRequests),
        eventLoopLagMs: finiteNonNegative(message.eventLoopLagMs),
        timestamp: Date.now(),
      });
    });
  }

  function forkWorker() {
    const worker = cluster.fork();
    attachWorker(worker);
    return worker;
  }

  function ensureWorkerCount(target) {
    if (stopping) return;
    const effectiveWorkers = liveWorkers().length - retiringWorkers.size;
    for (let count = effectiveWorkers; count < target; count += 1) forkWorker();
  }

  function signalWorkerShutdown(worker) {
    const terminate = () => {
      try {
        if (!worker.isDead()) worker.kill("SIGTERM");
      } catch (error) {
        if (error.code !== "ESRCH") {
          logger.error("[adaptive-cluster] worker termination failed:", error);
        }
      }
    };

    if (!worker.isConnected()) {
      terminate();
      return;
    }

    try {
      worker.send({ type: MESSAGE_TYPES.SHUTDOWN }, (error) => {
        if (!error) return;
        if (!isClosedIpcError(error)) {
          logger.error("[adaptive-cluster] worker shutdown message failed:", error);
        }
        terminate();
      });
    } catch (error) {
      if (!isClosedIpcError(error)) {
        logger.error("[adaptive-cluster] worker shutdown message failed:", error);
      }
      terminate();
    }
  }

  function retireTo(target) {
    const candidates = liveWorkers()
      .filter((worker) => !retiringWorkers.has(worker.id))
      .sort((left, right) => {
        const leftActive = samples.get(left.id)?.activeRequests || 0;
        const rightActive = samples.get(right.id)?.activeRequests || 0;
        return leftActive - rightActive;
      });
    const retireCount = Math.max(0, candidates.length - target);

    for (const worker of candidates.slice(0, retireCount)) {
      retiringWorkers.add(worker.id);
      signalWorkerShutdown(worker);

      const forceKillTimer = setTimeout(() => {
        if (!worker.isDead()) worker.kill("SIGKILL");
      }, options.gracefulShutdownMs + 1_000);
      forceKillTimer.unref();
      worker.once("exit", () => clearTimeout(forceKillTimer));
    }
  }

  cluster.on("exit", (worker, code, signal) => {
    const planned = retiringWorkers.delete(worker.id);
    samples.delete(worker.id);
    if (stopping || planned) return;

    logger.error(
      `[adaptive-cluster] worker ${worker.process.pid} exited (${signal || code}); replacing`,
    );
    const replacementTimer = setTimeout(
      () => ensureWorkerCount(Math.max(options.minWorkers, desiredWorkers)),
      options.crashRestartDelayMs,
    );
    replacementTimer.unref();
  });

  ensureWorkerCount(options.minWorkers);

  function evaluate(now = Date.now()) {
    if (stopping || retiringWorkers.size > 0) return null;

    const workers = liveWorkers();
    const metrics = aggregateWorkerMetrics(samples, {
      now,
      staleMetricsMs: options.staleMetricsMs,
      workerCount: workers.length,
    });
    const decision = decideWorkerCount({
      currentWorkers: workers.length,
      ...metrics,
      now,
      lastScaleAt,
      underloadSince,
    }, options);
    underloadSince = decision.underloadSince;

    if (decision.action === "scale-up") {
      desiredWorkers = decision.targetWorkers;
      lastScaleAt = now;
      ensureWorkerCount(desiredWorkers);
      logger.log(
        `[adaptive-cluster] scale up ${workers.length} -> ${desiredWorkers} (${decision.reasons.join(", ")})`,
      );
    } else if (decision.action === "scale-down") {
      desiredWorkers = decision.targetWorkers;
      lastScaleAt = now;
      retireTo(desiredWorkers);
      logger.log(
        `[adaptive-cluster] scale down ${workers.length} -> ${desiredWorkers} (${decision.reasons.join(", ")})`,
      );
    }

    return { ...decision, metrics };
  }

  const evaluationTimer = setInterval(evaluate, options.evaluationIntervalMs);

  function shutdown() {
    if (shutdownPromise) return shutdownPromise;

    stopping = true;
    clearInterval(evaluationTimer);
    shutdownPromise = (async () => {
      await primaryStartPromise;
      if (primaryCleanup) {
        try {
          await primaryCleanup();
        } catch (error) {
          logger.error("[adaptive-cluster] primary cleanup failed:", error);
        }
      }

      const workers = liveWorkers();
      if (workers.length === 0) return;

      await new Promise((resolve) => {
        let completed = false;
        const remainingWorkers = new Set(workers.map(worker => worker.id));
        let forceKillTimer;
        const finish = () => {
          if (completed) return;
          completed = true;
          clearTimeout(forceKillTimer);
          resolve();
        };

        for (const worker of workers) {
          retiringWorkers.add(worker.id);
          worker.once("exit", () => {
            remainingWorkers.delete(worker.id);
            if (remainingWorkers.size === 0) finish();
          });

          signalWorkerShutdown(worker);
        }

        forceKillTimer = setTimeout(() => {
          for (const worker of liveWorkers()) {
            if (!worker.isDead()) worker.kill("SIGKILL");
          }
          finish();
        }, options.gracefulShutdownMs + 2_000);
        forceKillTimer.unref();
      });
    })();

    return shutdownPromise;
  }

  function shutdownAndExit() {
    void shutdown().then(
      () => process.exit(0),
      (error) => {
        logger.error("[adaptive-cluster] primary shutdown failed:", error);
        process.exit(1);
      },
    );
  }

  process.once("SIGTERM", shutdownAndExit);
  process.once("SIGINT", shutdownAndExit);

  return {
    role: "primary",
    evaluate,
    shutdown,
    getState() {
      return {
        workers: liveWorkers().length,
        desiredWorkers,
        retiringWorkers: retiringWorkers.size,
        underloadSince,
        lastScaleAt,
      };
    },
  };
}

/**
 * 같은 진입 파일을 primary/worker로 분기한다.
 * startPrimary는 primary에서 한 번, startWorker는 각 web worker에서만 호출된다.
 */
function startAdaptiveCluster({
  startPrimary,
  startWorker,
  logger = console,
  ...overrides
} = {}) {
  const options = normalizeOptions(overrides);
  if (typeof startWorker !== "function") {
    throw new TypeError("startWorker must be a function");
  }
  if (cluster.isPrimary) {
    return startPrimaryRuntime({ startPrimary, options, logger });
  }
  return startWorkerRuntime({ startWorker, options, logger });
}

module.exports = {
  DEFAULT_OPTIONS,
  MESSAGE_TYPES,
  aggregateWorkerMetrics,
  closeWorkerResource,
  createRequestMetrics,
  decideWorkerCount,
  normalizeOptions,
  startAdaptiveCluster,
};
