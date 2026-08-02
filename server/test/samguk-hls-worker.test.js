"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { appendObservationQueue } = require("../lib/samguk-observations");
const {
  SamgukHlsWorkerError,
  assertActivationAllowed,
  buildQueuedBaselineOverlays,
  configuredTargets,
  createRuntime,
  isWorkerEnabled,
  loadCurrentBaselines,
  loadQueuedBaselineOverlays,
  main,
  normalizeWorkerConfig,
  safeHeartbeat,
} = require("../workers/samguk-hls-monitor");

const FIXED_NOW = Date.parse("2026-08-02T12:00:00.000Z");
const CONFIRMED_AT = Date.parse("2026-08-02T10:00:02.000Z");

function broadcastObservation({
  value = 11,
  sourceId = "screen:frame-1",
  evidenceHash = "1".repeat(64),
  observedAt = "2026-08-02T10:00:00.000Z",
} = {}) {
  return {
    playerId: "P001",
    field: "strength",
    value,
    sourceType: "broadcast",
    sourceId,
    sourceUrl: "https://play.sooplive.com/cnsgkcnehd74",
    observedAt,
    collectedAt: observedAt,
    evidenceHash,
    ocrConfidence: 0.99,
  };
}

function config(overrides = {}) {
  return normalizeWorkerConfig({
    version: 2,
    permissionConfirmed: false,
    ...overrides,
  });
}

function singleTargetConfig(overrides = {}) {
  return config({
    mode: "single-target-dry-run",
    enabledPlayerIds: ["P001"],
    ...overrides,
  });
}

function rejectsConfig(input) {
  assert.throws(
    () => normalizeWorkerConfig(input),
    error => error instanceof SamgukHlsWorkerError && error.code === "invalid_config",
  );
}

test("v2 기본 설정은 90개 SD 감시와 제한된 HD burst 값을 고정한다", () => {
  const normalized = config();
  assert.equal(normalized.mode, "all-90");
  assert.equal(normalized.hls.cacheTtlMs, 60_000);
  assert.equal(normalized.hls.maxBatchBytes, 32 * 1024 * 1024);
  assert.equal(normalized.hls.maxCatchupSegments, 6);
  assert.equal(normalized.ocr.baselineRefreshMs, 60_000);
  assert.equal(normalized.scheduler.liveIntervalMs, 2_000);
  assert.equal(normalized.scheduler.normalConcurrency, 40);
  assert.equal(normalized.scheduler.burstConcurrency, 3);
  assert.equal(normalized.scheduler.taskLeaseMs, 120_000);
  assert.equal(normalized.ocr.enabled, false);
  assert.equal(configuredTargets(normalized).length, 90);
  assert.equal(configuredTargets(normalized).filter(target => target.enabled).length, 90);
});

test("nested config·주기·OCR command와 알 수 없는 key를 엄격히 검증한다", () => {
  for (const input of [
    null,
    { version: 1, permissionConfirmed: false },
    { version: 2, permissionConfirmed: "yes" },
    { version: 2, permissionConfirmed: false, hls: null },
    { version: 2, permissionConfirmed: false, hls: { maxCatchupSegments: 13 } },
    { version: 2, permissionConfirmed: false, hls: { maxBatchBytes: 64 * 1024 * 1024 + 1 } },
    { version: 2, permissionConfirmed: false, ffmpeg: { path: "ffmpeg" } },
    { version: 2, permissionConfirmed: false, scheduler: { burstIntervalMs: 3_000 } },
    { version: 2, mode: "partial", permissionConfirmed: false },
    { version: 2, mode: "single-target-dry-run", permissionConfirmed: false },
    {
      version: 2,
      mode: "single-target-dry-run",
      permissionConfirmed: false,
      enabledPlayerIds: ["P001", "P002"],
    },
    { version: 2, permissionConfirmed: false, enabledPlayerIds: ["P001"] },
    { version: 2, permissionConfirmed: false, ocr: { enabled: true } },
    { version: 2, permissionConfirmed: false, ocr: { enabled: false, extra: true } },
    { version: 2, permissionConfirmed: false, ocr: { baselineRefreshMs: 9_999 } },
    { version: 2, permissionConfirmed: false, extra: true },
  ]) rejectsConfig(input);

  const enabled = config({
    ocr: {
      enabled: true,
      profileId: "stats-panel-v1",
      command: "/opt/samguk/venv/bin/python",
      args: ["/opt/samguk/adapter.py"],
    },
  });
  assert.equal(enabled.ocr.enabled, true);
  assert.equal(enabled.ocr.command, "/opt/samguk/venv/bin/python");
});

test("all-90은 정확한 전체 roster만, single-target-dry-run은 known ID 한 개만 허용한다", () => {
  const allTargets = configuredTargets(config());
  assert.deepEqual(
    allTargets.filter(target => target.enabled).map(target => target.playerId),
    Array.from({ length: 90 }, (_value, index) => `P${String(index + 1).padStart(3, "0")}`),
  );

  const single = singleTargetConfig();
  const targets = configuredTargets(single);
  assert.deepEqual(targets.filter(target => target.enabled).map(target => target.playerId), ["P001"]);
  rejectsConfig({
    version: 2,
    mode: "single-target-dry-run",
    permissionConfirmed: false,
    enabledPlayerIds: ["P001", "P001"],
  });
  assert.throws(
    () => configuredTargets(config({
      mode: "single-target-dry-run",
      enabledPlayerIds: ["P999"],
    })),
    error => error.code === "invalid_config",
  );
  assert.throws(
    () => configuredTargets(config(), allTargets.slice(0, 89)),
    error => error.code === "invalid_config",
  );
  assert.throws(
    () => configuredTargets(config(), allTargets.map((target, index) => (
      index === 0 ? { ...target, enabled: false } : target
    ))),
    error => error.code === "invalid_config",
  );
});

test("명시적 활성화와 권한 확인, mode별 target 수를 모두 요구한다", () => {
  assert.equal(isWorkerEnabled({}), false);
  assert.equal(isWorkerEnabled({ SAMGUK_HLS_MONITOR_ENABLED: "1" }), true);
  const allTargets = configuredTargets(config());
  assert.throws(
    () => assertActivationAllowed(config(), allTargets),
    error => error.code === "permission_required",
  );
  const single = singleTargetConfig({ permissionConfirmed: true });
  assert.doesNotThrow(() => assertActivationAllowed(single, configuredTargets(single)));
  assert.throws(
    () => assertActivationAllowed(config({ permissionConfirmed: true }), allTargets.slice(0, 89)),
    error => error.code === "invalid_config",
  );
  assert.throws(
    () => assertActivationAllowed(single, configuredTargets(single).map(target => ({
      ...target,
      enabled: false,
    }))),
    error => error.code === "no_targets",
  );
});

test("runtime은 SD/HD resolver, cache, segment fetcher와 ffmpeg를 한 번씩 조립한다", () => {
  const normalized = singleTargetConfig({ permissionConfirmed: true });
  const calls = { resolver: [], cache: null, segment: null, frame: null, monitor: null };
  const fakeCache = { get() {}, invalidate() {}, getSnapshot() {} };
  const fakeSegment = async () => Buffer.from([1]);
  const fakeFrames = { captureGrayFrame: async () => Buffer.alloc(1296), captureOcrPng: async () => Buffer.alloc(8) };
  const fakeMonitor = { runLoop() {}, getSnapshot() {} };
  const runtime = createRuntime(normalized, {
    targets: configuredTargets(normalized),
    queuePath: "/tmp/observations.ndjson",
    resolverFactory(options) {
      calls.resolver.push(options);
      return async () => ({});
    },
    cacheFactory(options) { calls.cache = options; return fakeCache; },
    segmentFetcherFactory(options) { calls.segment = options; return fakeSegment; },
    frameFactory(options) { calls.frame = options; return fakeFrames; },
    monitorFactory(options) { calls.monitor = options; return fakeMonitor; },
  });

  assert.deepEqual(calls.resolver.map(item => item.quality), ["SD", "HD"]);
  assert.equal(calls.cache.maxBjIds, 1);
  assert.equal(calls.segment.maxSegmentBytes, normalized.hls.maxSegmentBytes);
  assert.equal(calls.segment.maxBatchBytes, normalized.hls.maxBatchBytes);
  assert.equal(calls.segment.maxSegments, normalized.hls.maxCatchupSegments);
  assert.equal(calls.frame.ffmpegPath, "/usr/bin/ffmpeg");
  assert.equal(calls.monitor.targets.length, 90);
  assert.equal(calls.monitor.targets.filter(item => item.enabled).length, 1);
  assert.equal(calls.monitor.runOcr, undefined);
  assert.equal(calls.monitor.fetchSegments, fakeSegment);
  assert.equal(calls.monitor.maxCatchupSegments, 6);
  assert.equal(runtime.monitor, fakeMonitor);
});

test("OCR runtime은 호출 시점의 Sheet baseline 없이는 시작하지 않는다", () => {
  const normalized = singleTargetConfig({
    permissionConfirmed: true,
    ocr: {
      enabled: true,
      command: "/opt/samguk/venv/bin/python",
      args: ["/opt/samguk/adapter.py"],
    },
  });
  assert.throws(
    () => createRuntime(normalized, { targets: configuredTargets(normalized) }),
    error => error.code === "baseline_required",
  );
});

test("queue의 최신 confirmed 방송값만 Sheet와 다른 startup overlay로 만든다", () => {
  const targets = [{ playerId: "P001", enabled: true }];
  const sheet = [{ playerId: "P001", field: "strength", value: 10 }];
  const observations = [
    broadcastObservation(),
    broadcastObservation({
      sourceId: "screen:frame-2",
      evidenceHash: "2".repeat(64),
      observedAt: "2026-08-02T10:00:02.000Z",
    }),
    // A lone newer OCR row is evidence, not a confirmed stable value.
    broadcastObservation({
      value: 12,
      sourceId: "screen:single-newer",
      evidenceHash: "3".repeat(64),
      observedAt: "2026-08-02T10:01:00.000Z",
    }),
  ];
  assert.deepEqual(buildQueuedBaselineOverlays(observations, sheet, targets), [
    { playerId: "P001", field: "strength", value: 11, observedAtMs: CONFIRMED_AT },
  ]);
  assert.deepEqual(buildQueuedBaselineOverlays(observations, [
    { playerId: "P001", field: "strength", value: 11 },
  ], targets), []);
  assert.deepEqual(buildQueuedBaselineOverlays(observations, sheet, [
    { playerId: "P001", enabled: false },
  ]), []);
  assert.deepEqual(buildQueuedBaselineOverlays(observations, sheet, targets, {
    baselineObservedAt: new Map([["P001\u0000strength", Date.parse("2026-08-02T11:00:00Z")]]),
  }), []);
  assert.deepEqual(buildQueuedBaselineOverlays(observations, sheet, targets, {
    baselineObservedAt: new Map([["P001\u0000strength", null]]),
  }), [
    { playerId: "P001", field: "strength", value: 11, observedAtMs: CONFIRMED_AT },
  ]);
  assert.deepEqual(buildQueuedBaselineOverlays(observations, sheet, targets, {
    baselineObservedAt: new Map([["P001\u0000strength", "not-a-timestamp"]]),
  }), [
    { playerId: "P001", field: "strength", value: 11, observedAtMs: CONFIRMED_AT },
  ]);
  assert.deepEqual(buildQueuedBaselineOverlays([
    broadcastObservation(),
    broadcastObservation({
      sourceId: "screen:aliased-frame",
      evidenceHash: "1".repeat(64),
      observedAt: "2026-08-02T10:00:02.000Z",
    }),
  ], sheet, targets), []);
});

test("startup overlay queue read는 lock·크기·symlink 보안 규칙을 그대로 사용한다", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "samguk-hls-overlay-read-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const queuePath = path.join(directory, "observations.ndjson");
  const rows = [
    broadcastObservation(),
    broadcastObservation({
      sourceId: "screen:frame-2",
      evidenceHash: "2".repeat(64),
      observedAt: "2026-08-02T10:00:02.000Z",
    }),
  ];
  appendObservationQueue(queuePath, rows, { now: FIXED_NOW });
  assert.deepEqual(loadQueuedBaselineOverlays(
    queuePath,
    [{ playerId: "P001", field: "strength", value: 10 }],
    [{ playerId: "P001", enabled: true }],
  ), [{ playerId: "P001", field: "strength", value: 11, observedAtMs: CONFIRMED_AT }]);

  const symlinkPath = path.join(directory, "linked.ndjson");
  fs.symlinkSync(queuePath, symlinkPath);
  assert.throws(
    () => loadQueuedBaselineOverlays(
      symlinkPath,
      [{ playerId: "P001", field: "strength", value: 10 }],
      [{ playerId: "P001", enabled: true }],
    ),
    error => error.code === "invalid_path",
  );
  assert.throws(
    () => loadQueuedBaselineOverlays(
      queuePath,
      [{ playerId: "P001", field: "strength", value: 10 }],
      [{ playerId: "P001", enabled: true }],
      { maxBytes: 1 },
    ),
    error => error.code === "queue_too_large",
  );
});

test("최신 Google Sheet만 OCR baseline으로 변환한다", async () => {
  const targets = [{
    id: "P001",
    playerId: "P001",
    bjId: "sample_bj",
    sourceUrl: "https://play.sooplive.com/sample_bj",
    enabled: true,
  }];
  const baselines = await loadCurrentBaselines(targets, {
    service: {
      async load() {
        return {
          source: "google-sheet",
          stale: false,
          members: [{
            soopId: "sample_bj",
            level: 20,
            weapon: 3,
            observedAt: "2026-08-02T11:00:00.000Z",
          }],
        };
      },
    },
  });
  assert.deepEqual(baselines, [
    { playerId: "P001", field: "level", value: 20 },
    { playerId: "P001", field: "weapon", value: 3 },
  ]);
  assert.deepEqual(buildQueuedBaselineOverlays([
    { ...broadcastObservation(), field: "level", value: 21 },
    {
      ...broadcastObservation({
        sourceId: "screen:older-frame-2",
        evidenceHash: "2".repeat(64),
        observedAt: "2026-08-02T10:00:02.000Z",
      }),
      field: "level",
      value: 21,
    },
  ], baselines, targets), []);
  await assert.rejects(
    () => loadCurrentBaselines(targets, {
      service: { async load() { return { source: "fallback-seed", stale: true, members: [] }; } },
    }),
    error => error.code === "baseline_unavailable",
  );
});

test("기본 비활성 main은 config와 runtime을 건드리지 않는다", async () => {
  let loaded = 0;
  let created = 0;
  const logs = [];
  const result = await main({
    env: {},
    logger: { log: value => logs.push(value) },
    loadConfig() { loaded += 1; },
    runtimeFactory() { created += 1; },
  });
  assert.deepEqual(result, { enabled: false });
  assert.equal(loaded, 0);
  assert.equal(created, 0);
  assert.equal(logs.length, 1);
});

test("권한 확인된 main은 안전한 runtime만 시작하고 종료한다", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "samguk-hls-worker-test-"));
  const normalized = singleTargetConfig({ permissionConfirmed: true });
  let loopCalls = 0;
  let overlayLoads = 0;
  try {
    const result = await main({
      env: {
        SAMGUK_HLS_MONITOR_ENABLED: "1",
        SAMGUK_HLS_MONITOR_CONFIG: "/not/read/in/test.json",
        SAMGUK_HLS_MONITOR_STATE_DIR: stateDir,
      },
      logger: { log() {}, warn() {} },
      loadConfig: () => normalized,
      runtimeFactory: () => ({
        monitor: {
          async runLoop() { loopCalls += 1; },
          getSnapshot: () => ({ activeTasks: 0, ocrEnabled: false, scheduler: { counts: {} }, stats: {} }),
        },
        hlsCache: { getSnapshot: () => ({ bjCount: 0, cachedCount: 0, pendingCount: 0 }) },
      }),
      queueOverlayLoader() { overlayLoads += 1; return []; },
      heartbeatMs: 1_000,
    });
    assert.deepEqual(result, { enabled: true });
    assert.equal(loopCalls, 1);
    assert.equal(overlayLoads, 0);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test("OCR main은 최신 baseline을 받은 뒤 같은 AbortSignal로 runtime을 시작한다", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "samguk-hls-ocr-main-test-"));
  const normalized = singleTargetConfig({
    permissionConfirmed: true,
    ocr: {
      enabled: true,
      command: "/opt/samguk/venv/bin/python",
      args: ["/opt/samguk/adapter.py"],
    },
  });
  let runtimeOptions;
  try {
    const result = await main({
      env: {
        SAMGUK_HLS_MONITOR_ENABLED: "1",
        SAMGUK_HLS_MONITOR_CONFIG: "/not/read/in/test.json",
        SAMGUK_HLS_MONITOR_STATE_DIR: stateDir,
      },
      logger: { log() {}, warn() {} },
      loadConfig: () => normalized,
      baselineLoader: async () => [{ playerId: "P001", field: "level", value: 10 }],
      runtimeFactory: (_config, options) => {
        runtimeOptions = options;
        return {
          monitor: {
            async runLoop(signal) { assert.equal(signal, options.signal); },
            getSnapshot: () => ({ activeTasks: 0, ocrEnabled: true, scheduler: { counts: {} }, stats: {} }),
          },
          hlsCache: { getSnapshot: () => ({ bjCount: 0, cachedCount: 0, pendingCount: 0 }) },
        };
      },
      heartbeatMs: 1_000,
    });
    assert.deepEqual(result, { enabled: true });
    assert.deepEqual(runtimeOptions.baselines, [{ playerId: "P001", field: "level", value: 10 }]);
    assert.deepEqual(runtimeOptions.baselineOverlays, []);
    assert.equal(runtimeOptions.signal instanceof AbortSignal, true);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test("OCR main 재시작은 Sheet 승격 전 queue confirmed 값을 runtime에 복원한다", async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "samguk-hls-restart-overlay-test-"));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const queuePath = path.join(stateDir, "observations.ndjson");
  appendObservationQueue(queuePath, [
    broadcastObservation(),
    broadcastObservation({
      sourceId: "screen:frame-2",
      evidenceHash: "2".repeat(64),
      observedAt: "2026-08-02T10:00:02.000Z",
    }),
  ], { now: FIXED_NOW });
  const normalized = singleTargetConfig({
    permissionConfirmed: true,
    ocr: {
      enabled: true,
      command: "/opt/samguk/venv/bin/python",
      args: ["/opt/samguk/adapter.py"],
    },
  });
  let runtimeOptions;
  const result = await main({
    env: {
      SAMGUK_HLS_MONITOR_ENABLED: "1",
      SAMGUK_HLS_MONITOR_CONFIG: "/not/read/in/test.json",
      SAMGUK_HLS_MONITOR_STATE_DIR: stateDir,
      SAMGUK_OBSERVATION_QUEUE_PATH: queuePath,
    },
    logger: { log() {}, warn() {} },
    clock: () => CONFIRMED_AT + 30_000,
    loadConfig: () => normalized,
    baselineLoader: async () => [{ playerId: "P001", field: "strength", value: 10 }],
    runtimeFactory: (_config, options) => {
      runtimeOptions = options;
      return {
        monitor: {
          async runLoop() {},
          getSnapshot: () => ({ activeTasks: 0, ocrEnabled: true, scheduler: { counts: {} }, stats: {} }),
        },
        hlsCache: { getSnapshot: () => ({ bjCount: 0, cachedCount: 0, pendingCount: 0 }) },
      };
    },
    heartbeatMs: 1_000,
  });
  assert.deepEqual(result, { enabled: true });
  assert.deepEqual(runtimeOptions.baselineOverlays, [
    { playerId: "P001", field: "strength", value: 11, observedAtMs: CONFIRMED_AT },
  ]);
});

test("손상 queue는 OCR main을 막지 않고 Sheet baseline으로 fail-safe 시작한다", async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "samguk-hls-corrupt-overlay-test-"));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const queuePath = path.join(stateDir, "observations.ndjson");
  fs.writeFileSync(queuePath, "{broken-json\n", { mode: 0o600 });
  const normalized = singleTargetConfig({
    permissionConfirmed: true,
    ocr: {
      enabled: true,
      command: "/opt/samguk/venv/bin/python",
      args: ["/opt/samguk/adapter.py"],
    },
  });
  const warnings = [];
  let runtimeOptions;
  const result = await main({
    env: {
      SAMGUK_HLS_MONITOR_ENABLED: "1",
      SAMGUK_HLS_MONITOR_CONFIG: "/not/read/in/test.json",
      SAMGUK_HLS_MONITOR_STATE_DIR: stateDir,
      SAMGUK_OBSERVATION_QUEUE_PATH: queuePath,
    },
    logger: { log() {}, warn: message => warnings.push(message) },
    loadConfig: () => normalized,
    baselineLoader: async () => [{ playerId: "P001", field: "strength", value: 10 }],
    runtimeFactory: (_config, options) => {
      runtimeOptions = options;
      return {
        monitor: {
          async runLoop() {},
          getSnapshot: () => ({ activeTasks: 0, ocrEnabled: true, scheduler: { counts: {} }, stats: {} }),
        },
        hlsCache: { getSnapshot: () => ({ bjCount: 0, cachedCount: 0, pendingCount: 0 }) },
      };
    },
    heartbeatMs: 1_000,
  });
  assert.deepEqual(result, { enabled: true });
  assert.deepEqual(runtimeOptions.baselineOverlays, []);
  assert.ok(warnings.includes("[samguk-hls-monitor] queue_overlay_restore_failed"));
  assert.equal(fs.readFileSync(queuePath, "utf8"), "{broken-json\n");
});

test("OCR main은 장기 실행 중 최신 Sheet baseline을 주기적으로 다시 적용한다", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "samguk-hls-baseline-refresh-test-"));
  const normalized = singleTargetConfig({
    permissionConfirmed: true,
    ocr: {
      enabled: true,
      command: "/opt/samguk/venv/bin/python",
      args: ["/opt/samguk/adapter.py"],
    },
  });
  let loadCalls = 0;
  const refreshed = [];
  try {
    const result = await main({
      env: {
        SAMGUK_HLS_MONITOR_ENABLED: "1",
        SAMGUK_HLS_MONITOR_CONFIG: "/not/read/in/test.json",
        SAMGUK_HLS_MONITOR_STATE_DIR: stateDir,
      },
      logger: { log() {}, warn() {} },
      loadConfig: () => normalized,
      baselineLoader: async () => {
        loadCalls += 1;
        return [{ playerId: "P001", field: "level", value: loadCalls === 1 ? 10 : 11 }];
      },
      runtimeFactory: () => ({
        monitor: {
          async runLoop() { await new Promise(resolve => setTimeout(resolve, 35)); },
          refreshBaselines: baselines => refreshed.push(baselines),
          getSnapshot: () => ({ activeTasks: 0, ocrEnabled: true, scheduler: { counts: {} }, stats: {} }),
        },
        hlsCache: { getSnapshot: () => ({ bjCount: 0, cachedCount: 0, pendingCount: 0 }) },
      }),
      baselineRefreshMs: 10,
      heartbeatMs: 1_000,
    });
    assert.deepEqual(result, { enabled: true });
    assert.ok(loadCalls >= 2);
    assert.ok(refreshed.some(items => items[0].value === 11));
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test("runLoop 실패 뒤 늦게 끝난 baseline refresh는 monitor 상태를 변경하지 않는다", async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "samguk-hls-late-refresh-test-"));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const normalized = singleTargetConfig({
    permissionConfirmed: true,
    ocr: {
      enabled: true,
      command: "/opt/samguk/venv/bin/python",
      args: ["/opt/samguk/adapter.py"],
    },
  });
  let loadCalls = 0;
  let resolveLateRefresh;
  let markRefreshStarted;
  const refreshStarted = new Promise(resolve => { markRefreshStarted = resolve; });
  let refreshCalls = 0;
  let runtimeSignal;
  const loopError = new Error("loop failed");

  const operation = main({
    env: {
      SAMGUK_HLS_MONITOR_ENABLED: "1",
      SAMGUK_HLS_MONITOR_CONFIG: "/not/read/in/test.json",
      SAMGUK_HLS_MONITOR_STATE_DIR: stateDir,
    },
    logger: { log() {}, warn() {} },
    loadConfig: () => normalized,
    baselineLoader: async () => {
      loadCalls += 1;
      if (loadCalls === 1) return [{ playerId: "P001", field: "level", value: 10 }];
      markRefreshStarted();
      return new Promise(resolve => { resolveLateRefresh = resolve; });
    },
    runtimeFactory: (_config, options) => {
      runtimeSignal = options.signal;
      return {
        monitor: {
          async runLoop() {
            await new Promise(resolve => setTimeout(resolve, 20));
            await refreshStarted;
            throw loopError;
          },
          refreshBaselines() { refreshCalls += 1; },
          getSnapshot: () => ({ activeTasks: 0, ocrEnabled: true, scheduler: { counts: {} }, stats: {} }),
        },
        hlsCache: { getSnapshot: () => ({ bjCount: 0, cachedCount: 0, pendingCount: 0 }) },
      };
    },
    baselineRefreshMs: 10,
    heartbeatMs: 1_000,
  });

  await assert.rejects(operation, error => error === loopError);
  assert.equal(runtimeSignal.aborted, true);
  resolveLateRefresh([{ playerId: "P001", field: "level", value: 11 }]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(refreshCalls, 0);
});

test("heartbeat에는 aggregate만 남기고 URL·AID·BJ ID를 포함하지 않는다", () => {
  const targetStates = [
    { targetId: "P090", enabled: false },
    { targetId: "P001", enabled: true },
  ];
  const snapshot = {
    activeTasks: 2,
    ocrEnabled: true,
    scheduler: { counts: { live: 1, burst: 1 }, targets: targetStates },
    stats: { tasks: 100, lastErrorCode: null },
  };
  const cacheSnapshot = { bjCount: 1, cachedCount: 2, pendingCount: 0 };
  const heartbeat = safeHeartbeat(snapshot, cacheSnapshot, "single-target-dry-run");
  const reordered = safeHeartbeat({
    ...snapshot,
    scheduler: { ...snapshot.scheduler, targets: [...targetStates].reverse() },
  }, cacheSnapshot, "single-target-dry-run");
  assert.equal(heartbeat.mode, "single-target-dry-run");
  assert.equal(heartbeat.totalTargetCount, 2);
  assert.equal(heartbeat.enabledCount, 1);
  assert.equal(heartbeat.disabledCount, 1);
  assert.match(heartbeat.targetSetDigest, /^[a-f0-9]{16}$/);
  assert.equal(heartbeat.targetSetDigest, reordered.targetSetDigest);
  const visible = JSON.stringify(heartbeat);
  assert.equal(visible.includes("https://"), false);
  assert.equal(visible.includes("aid="), false);
  assert.equal(visible.includes("sample_bj"), false);
});
