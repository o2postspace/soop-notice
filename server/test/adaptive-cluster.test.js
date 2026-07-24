"use strict";

const { EventEmitter } = require("node:events");
const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  aggregateWorkerMetrics,
  closeWorkerResource,
  createRequestMetrics,
  decideWorkerCount,
  normalizeOptions,
} = require("../lib/adaptive-cluster");

const thresholds = {
  minWorkers: 1,
  maxWorkers: 8,
  scaleUpRpsPerWorker: 10,
  scaleDownRpsPerWorker: 5,
  scaleUpActiveRequestsPerWorker: 10,
  scaleDownActiveRequestsPerWorker: 4,
  scaleUpLagMs: 80,
  criticalLagMs: 250,
  scaleDownLagMs: 30,
  scaleUpCooldownMs: 2_000,
  scaleDownQuietMs: 60_000,
};

function decide(overrides = {}) {
  return decideWorkerCount({
    currentWorkers: 1,
    requestsPerSecond: 0,
    activeRequests: 0,
    eventLoopLagMs: 0,
    telemetryComplete: true,
    now: 100_000,
    lastScaleAt: 0,
    underloadSince: null,
    ...overrides,
  }, thresholds);
}

test("기본 부하에서는 web worker 한 개를 유지한다", () => {
  assert.deepEqual(decide(), {
    action: "hold",
    targetWorkers: 1,
    underloadSince: null,
    reasons: ["capacity-needed"],
  });
});

test("요청률과 active request에 맞춰 즉시 여러 worker를 추가한다", () => {
  const byRate = decide({ requestsPerSecond: 31 });
  assert.equal(byRate.action, "scale-up");
  assert.equal(byRate.targetWorkers, 4);
  assert.ok(byRate.reasons.includes("request-rate"));

  const byActive = decide({ activeRequests: 27 });
  assert.equal(byActive.action, "scale-up");
  assert.equal(byActive.targetWorkers, 3);
  assert.ok(byActive.reasons.includes("active-requests"));
});

test("event-loop lag가 높으면 빠르게 늘리고 임계 상태면 최대치로 늘린다", () => {
  const lagged = decide({ currentWorkers: 2, eventLoopLagMs: 100 });
  assert.equal(lagged.action, "scale-up");
  assert.equal(lagged.targetWorkers, 3);
  assert.ok(lagged.reasons.includes("event-loop-lag"));

  const critical = decide({ currentWorkers: 2, eventLoopLagMs: 300 });
  assert.equal(critical.action, "scale-up");
  assert.equal(critical.targetWorkers, 8);
  assert.ok(critical.reasons.includes("critical-event-loop-lag"));
});

test("연속 scale-up에는 짧은 cooldown을 적용한다", () => {
  const decision = decide({
    requestsPerSecond: 40,
    lastScaleAt: 99_000,
  });
  assert.equal(decision.action, "hold");
  assert.equal(decision.targetWorkers, 1);
  assert.ok(decision.reasons.includes("scale-up-cooldown"));
});

test("축소는 60초 동안 낮은 부하가 이어진 뒤 한 번에 수행한다", () => {
  const waiting = decide({
    currentWorkers: 8,
    requestsPerSecond: 10,
    now: 159_999,
    underloadSince: 100_000,
  });
  assert.equal(waiting.action, "hold");
  assert.equal(waiting.targetWorkers, 8);
  assert.equal(waiting.underloadSince, 100_000);

  const down = decide({
    currentWorkers: 8,
    requestsPerSecond: 10,
    now: 160_000,
    underloadSince: 100_000,
  });
  assert.equal(down.action, "scale-down");
  assert.equal(down.targetWorkers, 2);
  assert.equal(down.underloadSince, null);
});

test("부하가 돌아오거나 telemetry가 끊기면 축소 타이머를 취소한다", () => {
  const busy = decide({
    currentWorkers: 4,
    requestsPerSecond: 35,
    underloadSince: 50_000,
  });
  assert.equal(busy.action, "hold");
  assert.equal(busy.underloadSince, null);

  const missing = decide({
    currentWorkers: 8,
    telemetryComplete: false,
    underloadSince: 50_000,
  });
  assert.equal(missing.action, "hold");
  assert.equal(missing.underloadSince, null);
  assert.ok(missing.reasons.includes("incomplete-telemetry"));
});

test("telemetry가 끊긴 worker가 있으면 여유 worker를 하나 보강한다", () => {
  const decision = decide({
    currentWorkers: 3,
    telemetryComplete: false,
  });
  assert.equal(decision.action, "scale-up");
  assert.equal(decision.targetWorkers, 4);
  assert.ok(decision.reasons.includes("missing-telemetry"));
});

test("worker 표본은 합산하고 오래된 표본은 누락으로 표시한다", () => {
  const metrics = aggregateWorkerMetrics([
    {
      requestsPerSecond: 3,
      activeRequests: 2,
      eventLoopLagMs: 15,
      timestamp: 9_000,
    },
    {
      requestsPerSecond: 7,
      activeRequests: 1,
      eventLoopLagMs: 45,
      timestamp: 9_500,
    },
    {
      requestsPerSecond: 100,
      activeRequests: 100,
      eventLoopLagMs: 500,
      timestamp: 1_000,
    },
  ], {
    now: 10_000,
    staleMetricsMs: 2_000,
    workerCount: 3,
  });

  assert.deepEqual(metrics, {
    requestsPerSecond: 10,
    activeRequests: 3,
    eventLoopLagMs: 45,
    freshWorkers: 2,
    missingWorkers: 1,
    telemetryComplete: false,
  });
});

test("요청 middleware는 finish와 close가 모두 발생해도 active를 한 번만 줄인다", () => {
  const metrics = createRequestMetrics();
  const response = new EventEmitter();
  let nextCalls = 0;

  metrics.middleware({}, response, () => { nextCalls += 1; });
  assert.deepEqual(metrics.snapshotAndReset(), { requests: 1, activeRequests: 1 });

  response.emit("finish");
  response.emit("close");
  assert.deepEqual(metrics.snapshotAndReset(), { requests: 0, activeRequests: 0 });
  assert.equal(nextCalls, 1);
});

test("HTTP server의 length 0 close도 callback 완료까지 기다린다", async () => {
  let closeFinished = false;
  const resource = {
    close(...args) {
      const done = args[0];
      setImmediate(() => {
        closeFinished = true;
        done();
      });
    },
  };

  assert.equal(resource.close.length, 0);
  await closeWorkerResource(resource);
  assert.equal(closeFinished, true);
});

test("잘못된 worker 범위와 hysteresis 설정은 거부한다", () => {
  assert.throws(
    () => normalizeOptions({ minWorkers: 9, maxWorkers: 8 }),
    /minWorkers cannot be greater/,
  );
  assert.throws(
    () => normalizeOptions({
      scaleDownRpsPerWorker: 20,
      scaleUpRpsPerWorker: 10,
    }),
    /scaleDownRpsPerWorker cannot exceed/,
  );
});
