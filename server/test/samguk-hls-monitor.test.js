"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  DEFAULT_HUD_PROBE_INTERVAL_MS,
  DEFAULT_SCHEDULER_OPTIONS,
  SamgukHlsMonitorError,
  buildBaselinesFromMembers,
  buildFallbackBaselines,
  buildFallbackTargets,
  createSamgukHlsMonitor,
  normalizeTargets,
  OCR_STREAM_QUALITY,
  safeErrorCode,
} = require("../lib/samguk-hls-monitor");
const { CURRENT_SEASON_ID } = require("../lib/samguk-observations");
const { FRAME_BYTES } = require("../lib/samguk-ui-gate");

const BASE_TIME = Date.parse("2026-08-02T12:00:00.000Z");
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const BASELINE_OBSERVED_AT = Symbol.for("soop-notice.samguk-baseline-observed-at");

function withBaselineObservedAt(entries, values) {
  const baselines = entries.map(entry => ({ ...entry }));
  Object.defineProperty(baselines, BASELINE_OBSERVED_AT, {
    enumerable: false,
    value: new Map(values),
  });
  return baselines;
}

function target() {
  return {
    id: "P001",
    playerId: "P001",
    bjId: "sample_bj",
    sourceUrl: "https://play.sooplive.com/sample_bj",
    enabled: true,
  };
}

function errorWithCode(code, stage) {
  const error = new Error("민감한 upstream URL과 token은 노출되면 안 됩니다.");
  error.code = code;
  if (stage !== undefined) error.stage = stage;
  return error;
}

function batchSegment(mediaSequence, body = `segment-${mediaSequence}`) {
  return {
    segmentId: mediaSequence.toString(16).padStart(64, "0"),
    mediaSequence,
    body: Buffer.from(body),
  };
}

function grayFrameBatch(candidateIndex = -1) {
  const candidateIndices = new Set(Array.isArray(candidateIndex) ? candidateIndex : [candidateIndex]);
  return Buffer.concat(Array.from({ length: 8 }, (_value, index) => (
    Buffer.alloc(FRAME_BYTES, candidateIndices.has(index) ? 1 : 0)
  )));
}

function monitorFixture(overrides = {}) {
  let now = BASE_TIME;
  let segmentSequence = 0;
  const invalidations = [];
  const hlsCache = overrides.hlsCache || {
    async get(_bjId, quality) { return { hlsUrl: `memory:${quality}` }; },
    async invalidate(bjId, quality) { invalidations.push([bjId, quality]); },
  };
  const monitor = createSamgukHlsMonitor({
    targets: [target()],
    baselines: [],
    now,
    clock: () => now,
    schedulerOptions: {
      ...DEFAULT_SCHEDULER_OPTIONS,
      initialSpreadMs: 0,
      jitterRatio: 0,
    },
    hlsCache,
    async fetchSegment(hlsUrl) {
      segmentSequence += 1;
      return Buffer.from(`${hlsUrl.slice("memory:".length)}-${segmentSequence}`);
    },
    async decodeGrayFrame() { return Buffer.alloc(FRAME_BYTES, 120); },
    gate() { return { uiCandidate: false, reason: "test" }; },
    ...overrides,
  });
  return {
    invalidations,
    monitor,
    setNow(value) { now = value; },
  };
}

test("후국지 fallback roster는 P001~P090 target과 Gamcom season=2 baseline만 유지한다", () => {
  const targets = buildFallbackTargets();
  const baselines = buildFallbackBaselines();
  assert.equal(targets.length, 90);
  assert.equal(targets[0].id, "P001");
  assert.equal(targets.at(-1).id, "P090");
  assert.equal(new Set(targets.map(item => item.bjId)).size, 90);
  assert.equal(baselines.length, 545);
  assert.deepEqual(baselines.filter(item => item.playerId === "P001"), [
    { playerId: "P001", field: "horse", value: "백룡마" },
    { playerId: "P001", field: "horseLevel", value: 0 },
    { playerId: "P001", field: "weapon", value: 5 },
    { playerId: "P001", field: "strength", value: 20 },
    { playerId: "P001", field: "agility", value: 0 },
    { playerId: "P001", field: "vitality", value: 0 },
    { playerId: "P001", field: "intelligence", value: 0 },
  ]);
  assert.equal(baselines.filter(item => item.field === "weapon").length, 5);
  assert.equal(DEFAULT_HUD_PROBE_INTERVAL_MS, 10 * 60_000);
});

test("target은 playerId와 BJ 공개 player URL을 엄격히 묶는다", () => {
  assert.equal(normalizeTargets([target()])[0].sourceUrl, "https://play.sooplive.com/sample_bj");
  for (const bad of [
    { ...target(), id: "P002" },
    { ...target(), bjId: "bad-id" },
    { ...target(), sourceUrl: "https://evil.invalid/sample_bj" },
    { ...target(), sourceUrl: "https://play.sooplive.com/other" },
    { ...target(), sourceUrl: "https://play.sooplive.com/sample_bj?aid=secret" },
  ]) {
    assert.throws(
      () => normalizeTargets([bad]),
      error => error instanceof SamgukHlsMonitorError && error.code === "invalid_targets",
    );
  }
});

test("HUD probe interval은 기본 10분이며 안전한 운영 범위만 허용한다", () => {
  assert.doesNotThrow(() => monitorFixture({ hudProbeIntervalMs: 60_000 }));
  for (const value of [59_999, 86_400_001, 60_000.5, "600000"]) {
    assert.throws(
      () => monitorFixture({ hudProbeIntervalMs: value }),
      error => error instanceof SamgukHlsMonitorError && error.code === "invalid_config",
    );
  }
});

test("normal scan은 SD segment의 gray sample만 판별하고 ORIGINAL은 열지 않는다", async () => {
  const qualities = [];
  const fixture = monitorFixture({
    async fetchSegment(url) {
      qualities.push(url.slice("memory:".length));
      return Buffer.from("one-segment");
    },
  });
  const result = await fixture.monitor.executeTask({ lane: "normal", target: target() });
  assert.equal(result.live, true);
  assert.equal(result.uiCandidate, false);
  assert.deepEqual(qualities, ["SD"]);
});

test("SD와 ORIGINAL batch는 별도 fetcher를 사용하고 기존 단일 fetcher도 호환한다", async () => {
  const splitCalls = [];
  const split = monitorFixture({
    async fetchSegments(url) {
      splitCalls.push(["sd-fetcher", url.slice("memory:".length)]);
      return [batchSegment(1, "sd")];
    },
    async fetchOcrSegments(url) {
      splitCalls.push(["ocr-fetcher", url.slice("memory:".length)]);
      return [batchSegment(1, "original")];
    },
    async decodeGrayFrame() { return grayFrameBatch([]); },
  });
  await split.monitor.scanGate(target());
  await split.monitor.scanOcr(target());
  assert.deepEqual(splitCalls, [
    ["sd-fetcher", "SD"],
    ["ocr-fetcher", OCR_STREAM_QUALITY],
  ]);

  const sharedCalls = [];
  const shared = monitorFixture({
    async fetchSegments(url) {
      const quality = url.slice("memory:".length);
      sharedCalls.push(quality);
      return [batchSegment(1, quality)];
    },
    async decodeGrayFrame() { return grayFrameBatch([]); },
  });
  await shared.monitor.scanGate(target());
  await shared.monitor.scanOcr(target());
  assert.deepEqual(sharedCalls, ["SD", OCR_STREAM_QUALITY]);
});

test("ORIGINAL 전용 fetcher는 SD batch fetcher와 함께 설정해야 한다", () => {
  assert.throws(
    () => monitorFixture({
      fetchSegment: async () => Buffer.from("sd"),
      fetchSegments: undefined,
      fetchOcrSegments: async () => [batchSegment(1)],
    }),
    error => error instanceof SamgukHlsMonitorError && error.code === "invalid_config",
  );
});

test("같은 SD segment는 다시 decode하지 않는다", async () => {
  let decoded = 0;
  const fixture = monitorFixture({
    async fetchSegment() { return Buffer.from("same-segment"); },
    async decodeGrayFrame() {
      decoded += 1;
      return Buffer.alloc(FRAME_BYTES, 100);
    },
  });
  await fixture.monitor.scanGate(target());
  const duplicate = await fixture.monitor.scanGate(target());
  assert.equal(decoded, 1);
  assert.equal(duplicate.duplicate, true);
  assert.equal(fixture.monitor.getSnapshot(BASE_TIME).stats.duplicateSegments, 1);
});

test("SD 실제 누락과 후보 때만 여는 ORIGINAL 비관측 구간을 분리 계측한다", async () => {
  const sequences = {
    SD: [[batchSegment(10)], [batchSegment(12)]],
    [OCR_STREAM_QUALITY]: [[batchSegment(20)], [batchSegment(23)]],
  };
  const fixture = monitorFixture({
    async fetchSegments(url) {
      const quality = url.slice("memory:".length);
      return sequences[quality].shift();
    },
    async decodeGrayFrame() { return grayFrameBatch([]); },
    async decodePngFrame() { return Buffer.concat([PNG_SIGNATURE, Buffer.from([1])]); },
    async runOcr() {
      return { version: 2, profileId: "stats-panel-v1", seasonId: CURRENT_SEASON_ID, panelVisible: false, results: [] };
    },
    queuePath: "/tmp/test-gap-metrics.ndjson",
  });

  await fixture.monitor.scanGate(target());
  await fixture.monitor.scanGate(target());
  await fixture.monitor.scanOcr(target());
  await fixture.monitor.scanOcr(target());

  const stats = fixture.monitor.getSnapshot(BASE_TIME).stats;
  assert.equal(stats.sequenceGaps, 2);
  assert.equal(stats.segmentsMissed, 3);
  assert.equal(stats.sdSequenceGaps, 1);
  assert.equal(stats.sdSegmentsMissed, 1);
  assert.equal(stats.hdSequenceGaps, 1);
  assert.equal(stats.hdSegmentsUnobserved, 2);
});

test("서로 다른 ORIGINAL burst 사이의 의도적 비관측 sequence는 누락으로 합산하지 않는다", async () => {
  let sdSequence = 10;
  const originalSequences = [20, 40];
  const fixture = monitorFixture({
    async fetchSegments(url) {
      const quality = url.slice("memory:".length);
      const sequence = quality === "SD" ? sdSequence++ : originalSequences.shift();
      return [batchSegment(sequence, `${quality}-${sequence}`)];
    },
    async decodeGrayFrame() { return grayFrameBatch([1]); },
    gate(frame) { return { uiCandidate: frame[0] === 1, reason: "test" }; },
    async decodePngFrame(_segment, { sampleIndex }) {
      return Buffer.concat([PNG_SIGNATURE, Buffer.from([sampleIndex])]);
    },
    async runOcr() {
      return {
        version: 2,
        profileId: "stats-panel-v1",
        seasonId: CURRENT_SEASON_ID,
        panelVisible: false,
        results: [],
      };
    },
    queuePath: "/tmp/test-original-burst-gap.ndjson",
  });

  await fixture.monitor.executeTask({ lane: "normal", target: target() });
  await fixture.monitor.executeTask({ lane: "burst", target: target() });
  await fixture.monitor.executeTask({ lane: "normal", target: target() });
  await fixture.monitor.executeTask({ lane: "burst", target: target() });

  const stats = fixture.monitor.getSnapshot(BASE_TIME).stats;
  assert.equal(stats.hdSequenceGaps, 0);
  assert.equal(stats.hdSegmentsUnobserved, 0);
  assert.equal(stats.candidateSequenceMisses, 2);
});

test("burst ORIGINAL OCR 두 frame이 같을 때만 두 관측값을 queue에 한 번 기록한다", async () => {
  let now = BASE_TIME;
  let sdSequence = 0;
  let hdSequence = 0;
  const appendCalls = [];
  const monitor = createSamgukHlsMonitor({
    targets: [target()],
    baselines: [{ playerId: "P001", field: "strength", value: 10 }],
    now,
    clock: () => now,
    schedulerOptions: { ...DEFAULT_SCHEDULER_OPTIONS, initialSpreadMs: 0, jitterRatio: 0 },
    hlsCache: {
      async get(_bjId, quality) { return { hlsUrl: `memory:${quality}` }; },
      async invalidate() {},
    },
    async fetchSegment(url) {
      const quality = url.slice("memory:".length);
      if (quality === "SD") return Buffer.from(`sd-${++sdSequence}`);
      return Buffer.from(`hd-${++hdSequence}`);
    },
    async decodeGrayFrame() { return Buffer.alloc(FRAME_BYTES, 60); },
    async decodePngFrame() { return Buffer.concat([PNG_SIGNATURE, Buffer.from([1])]); },
    gate() { return { uiCandidate: true, reason: "candidate" }; },
    async runOcr() {
      return {
        version: 2,
        profileId: "stats-panel-v1",
        seasonId: CURRENT_SEASON_ID,
        panelVisible: true,
        results: [{ field: "strength", value: 11, confidence: 0.99 }],
      };
    },
    queuePath: "/tmp/test-observations.ndjson",
    appendFn(_path, observations) {
      appendCalls.push(observations);
      return { inserted: observations };
    },
  });

  await monitor.executeTask({ lane: "burst", target: target() });
  assert.equal(appendCalls.length, 0);
  const pendingRefresh = monitor.refreshBaselines([
    { playerId: "P001", field: "strength", value: 10 },
    { playerId: "P001", field: "level", value: 1 },
  ], now + 1_000);
  assert.equal(pendingRefresh.changed, true);
  now += 5_000;
  await monitor.executeTask({ lane: "burst", target: target() });
  assert.equal(appendCalls.length, 1);
  assert.equal(appendCalls[0].length, 2);
  assert.deepEqual(appendCalls[0].map(item => item.value), [11, 11]);
  assert.equal(new Set(appendCalls[0].map(item => item.sourceId)).size, 2);
  assert.equal(new Set(appendCalls[0].map(item => item.evidenceHash)).size, 2);
  const unrelatedSheetChange = monitor.refreshBaselines([
    { playerId: "P001", field: "strength", value: 10 },
    { playerId: "P001", field: "level", value: 2 },
  ], now + 1_000);
  assert.equal(unrelatedSheetChange.preserved, 1);
  const promotedSheet = monitor.refreshBaselines([
    { playerId: "P001", field: "strength", value: 11 },
    { playerId: "P001", field: "level", value: 2 },
  ], now + 2_000);
  assert.equal(promotedSheet.preserved, 0);
  assert.equal(monitor.getSnapshot(now).stats.queuedObservations, 2);
});

test("재시작 overlay는 Sheet 승격 전 confirmed 값을 stable로 복원하고 catch-up 때 제거한다", async () => {
  const key = "P001\u0000strength";
  let now = BASE_TIME;
  let sequence = 0;
  const appendCalls = [];
  const monitor = createSamgukHlsMonitor({
    targets: [target()],
    baselines: withBaselineObservedAt([
      { playerId: "P001", field: "strength", value: 10 },
    ], [[key, BASE_TIME - 10_000]]),
    baselineOverlays: [{
      playerId: "P001",
      field: "strength",
      value: 11,
      observedAtMs: BASE_TIME - 5_000,
    }],
    now,
    clock: () => now,
    schedulerOptions: { ...DEFAULT_SCHEDULER_OPTIONS, initialSpreadMs: 0, jitterRatio: 0 },
    hlsCache: {
      async get(_bjId, quality) { return { hlsUrl: `memory:${quality}` }; },
      async invalidate() {},
    },
    async fetchSegment() { return Buffer.from(`restart-${++sequence}`); },
    async decodeGrayFrame() { return Buffer.alloc(FRAME_BYTES, 60); },
    async decodePngFrame() { return Buffer.concat([PNG_SIGNATURE, Buffer.from([1])]); },
    gate() { return { uiCandidate: true, reason: "candidate" }; },
    async runOcr() {
      return {
        version: 2,
        profileId: "stats-panel-v1",
        seasonId: CURRENT_SEASON_ID,
        panelVisible: true,
        results: [{ field: "strength", value: 11, confidence: 0.99 }],
      };
    },
    queuePath: "/tmp/test-restart-observations.ndjson",
    appendFn(_path, observations) {
      appendCalls.push(observations);
      return { inserted: observations };
    },
  });

  await monitor.executeTask({ lane: "burst", target: target() });
  now += 1_000;
  await monitor.executeTask({ lane: "burst", target: target() });
  assert.equal(appendCalls.length, 0);
  assert.throws(() => monitor.refreshBaselines([
    { playerId: "P001", field: "strength", value: 11 },
    { playerId: "P001", field: "unknown", value: 1 },
  ], now + 500), error => error.code === "invalid_baseline");
  const afterFailedRefresh = monitor.refreshBaselines(withBaselineObservedAt([
    { playerId: "P001", field: "strength", value: 10 },
    { playerId: "P001", field: "level", value: 1 },
  ], [[key, BASE_TIME - 10_000]]), now + 750);
  assert.equal(afterFailedRefresh.preserved, 1);
  const caughtUp = monitor.refreshBaselines(withBaselineObservedAt([
    { playerId: "P001", field: "strength", value: 11 },
    { playerId: "P001", field: "level", value: 1 },
  ], [[key, BASE_TIME - 4_000]]), now + 1_000);
  assert.equal(caughtUp.preserved, 0);
});

test("invalid Sheet 시각은 valid startup overlay를 덮지 못하고 legacy overlay는 metadata가 있으면 거부한다", async () => {
  const key = "P001\u0000strength";
  const validOverlayAppends = [];
  const validOverlay = monitorFixture({
    baselines: withBaselineObservedAt([
      { playerId: "P001", field: "strength", value: 10 },
    ], [[key, null]]),
    baselineOverlays: [{
      playerId: "P001",
      field: "strength",
      value: 11,
      observedAtMs: BASE_TIME - 5_000,
    }],
    async decodePngFrame() { return Buffer.concat([PNG_SIGNATURE, Buffer.from([1])]); },
    async runOcr() {
      return {
        version: 2,
        profileId: "stats-panel-v1",
        seasonId: CURRENT_SEASON_ID,
        panelVisible: true,
        results: [{ field: "strength", value: 11, confidence: 0.99 }],
      };
    },
    queuePath: "/tmp/test-valid-overlay-invalid-sheet-time.ndjson",
    appendFn(_path, observations) {
      validOverlayAppends.push(observations);
      return { inserted: observations };
    },
  });
  await validOverlay.monitor.executeTask({ lane: "burst", target: target() });
  await validOverlay.monitor.executeTask({ lane: "burst", target: target() });
  assert.equal(validOverlayAppends.length, 0);

  const legacyOverlayAppends = [];
  const legacyOverlay = monitorFixture({
    baselines: withBaselineObservedAt([
      { playerId: "P001", field: "strength", value: 10 },
    ], [[key, null]]),
    baselineOverlays: [{ playerId: "P001", field: "strength", value: 11 }],
    async decodePngFrame() { return Buffer.concat([PNG_SIGNATURE, Buffer.from([1])]); },
    async runOcr() {
      return {
        version: 2,
        profileId: "stats-panel-v1",
        seasonId: CURRENT_SEASON_ID,
        panelVisible: true,
        results: [{ field: "strength", value: 10, confidence: 0.99 }],
      };
    },
    queuePath: "/tmp/test-legacy-overlay-sheet-metadata.ndjson",
    appendFn(_path, observations) {
      legacyOverlayAppends.push(observations);
      return { inserted: observations };
    },
  });
  await legacyOverlay.monitor.executeTask({ lane: "burst", target: target() });
  await legacyOverlay.monitor.executeTask({ lane: "burst", target: target() });
  assert.equal(legacyOverlayAppends.length, 0);
});

test("refresh의 invalid Sheet 시각은 valid overlay를 보존하고 최신 valid 시각만 제거한다", async () => {
  const key = "P001\u0000strength";
  const appended = [];
  const fixture = monitorFixture({
    baselines: withBaselineObservedAt([
      { playerId: "P001", field: "strength", value: 10 },
    ], [[key, BASE_TIME - 10_000]]),
    baselineOverlays: [{
      playerId: "P001",
      field: "strength",
      value: 11,
      observedAtMs: BASE_TIME - 5_000,
    }],
    async decodePngFrame() { return Buffer.concat([PNG_SIGNATURE, Buffer.from([1])]); },
    async runOcr() {
      return {
        version: 2,
        profileId: "stats-panel-v1",
        seasonId: CURRENT_SEASON_ID,
        panelVisible: true,
        results: [{ field: "strength", value: 11, confidence: 0.99 }],
      };
    },
    queuePath: "/tmp/test-refresh-invalid-sheet-time.ndjson",
    appendFn(_path, observations) {
      appended.push(observations);
      return { inserted: observations };
    },
  });

  const malformed = fixture.monitor.refreshBaselines(withBaselineObservedAt([
    { playerId: "P001", field: "strength", value: 10 },
  ], [[key, null]]), BASE_TIME + 1_000);
  assert.equal(malformed.preserved, 1);
  await fixture.monitor.executeTask({ lane: "burst", target: target() });
  await fixture.monitor.executeTask({ lane: "burst", target: target() });
  assert.equal(appended.length, 0);

  const newest = fixture.monitor.refreshBaselines(withBaselineObservedAt([
    { playerId: "P001", field: "strength", value: 10 },
  ], [[key, BASE_TIME - 4_000]]), BASE_TIME + 2_000);
  assert.equal(newest.preserved, 0);
});

test("timestamp 없는 legacy overlay는 refresh에 해당 Sheet key가 오면 제거한다", () => {
  let reconciled = null;
  const fixture = monitorFixture({
    baselines: [{ playerId: "P001", field: "strength", value: 10 }],
    baselineOverlays: [{ playerId: "P001", field: "strength", value: 11 }],
    async decodePngFrame() { return Buffer.concat([PNG_SIGNATURE, Buffer.from([1])]); },
    async runOcr() {
      return { version: 2, profileId: "stats-panel-v1", seasonId: CURRENT_SEASON_ID, panelVisible: false, results: [] };
    },
    queuePath: "/tmp/test-legacy-overlay-refresh.ndjson",
    changeTracker: {
      observeBatch() { return []; },
      initializeStable() {},
      reconcileStable(entries) { reconciled = entries; },
    },
  });

  const refreshed = fixture.monitor.refreshBaselines([
    { playerId: "P001", field: "strength", value: 10 },
    { playerId: "P001", field: "level", value: 1 },
  ], BASE_TIME + 1_000);
  assert.equal(refreshed.preserved, 0);
  assert.deepEqual(reconciled, [
    { playerId: "P001", field: "strength", value: 10 },
    { playerId: "P001", field: "level", value: 1 },
  ]);
});

test("overlay보다 동시·최신 Sheet 확인시각이 우선하고 invalid overlay 시각은 무시한다", async () => {
  const key = "P001\u0000strength";
  let ocrValue = 11;
  const appended = [];
  const fixture = monitorFixture({
    baselines: withBaselineObservedAt([
      { playerId: "P001", field: "strength", value: 10 },
    ], [[key, BASE_TIME - 10_000]]),
    baselineOverlays: [{
      playerId: "P001",
      field: "strength",
      value: 11,
      observedAtMs: BASE_TIME - 5_000,
    }],
    async decodePngFrame() { return Buffer.concat([PNG_SIGNATURE, Buffer.from([1])]); },
    async runOcr() {
      return {
        version: 2,
        profileId: "stats-panel-v1",
        seasonId: CURRENT_SEASON_ID,
        panelVisible: true,
        results: [{ field: "strength", value: ocrValue, confidence: 0.99 }],
      };
    },
    queuePath: "/tmp/test-timestamp-overlay.ndjson",
    appendFn(_path, observations) {
      appended.push(observations);
      return { inserted: observations };
    },
  });
  await fixture.monitor.executeTask({ lane: "burst", target: target() });
  await fixture.monitor.executeTask({ lane: "burst", target: target() });
  assert.equal(appended.length, 0);

  const refreshed = fixture.monitor.refreshBaselines(withBaselineObservedAt([
    { playerId: "P001", field: "strength", value: 10 },
  ], [[key, BASE_TIME - 5_000]]), BASE_TIME + 1_000);
  assert.equal(refreshed.preserved, 0);
  ocrValue = 10;
  await fixture.monitor.executeTask({ lane: "burst", target: target() });
  await fixture.monitor.executeTask({ lane: "burst", target: target() });
  assert.equal(appended.length, 0);

  const invalidOverlayAppends = [];
  const invalidOverlay = monitorFixture({
    baselines: [{ playerId: "P001", field: "strength", value: 10 }],
    baselineOverlays: [{
      playerId: "P001",
      field: "strength",
      value: 11,
      observedAt: "not-a-timestamp",
    }],
    async decodePngFrame() { return Buffer.concat([PNG_SIGNATURE, Buffer.from([1])]); },
    async runOcr() {
      return {
        version: 2,
        profileId: "stats-panel-v1",
        seasonId: CURRENT_SEASON_ID,
        panelVisible: true,
        results: [{ field: "strength", value: 10, confidence: 0.99 }],
      };
    },
    queuePath: "/tmp/test-invalid-timestamp-overlay.ndjson",
    appendFn(_path, observations) {
      invalidOverlayAppends.push(observations);
      return { inserted: observations };
    },
  });
  await invalidOverlay.monitor.executeTask({ lane: "burst", target: target() });
  await invalidOverlay.monitor.executeTask({ lane: "burst", target: target() });
  assert.equal(invalidOverlayAppends.length, 0);
});

test("decode 실패한 segment는 hash를 확정하지 않고 같은 segment를 재시도한다", async () => {
  let decodeCalls = 0;
  const fixture = monitorFixture({
    async fetchSegment() { return Buffer.from("retry-same-segment"); },
    async decodeGrayFrame() {
      decodeCalls += 1;
      if (decodeCalls === 1) throw errorWithCode("ffmpeg_failed");
      return Buffer.alloc(FRAME_BYTES, 100);
    },
  });
  await assert.rejects(() => fixture.monitor.scanGate(target()), error => error.code === "ffmpeg_failed");
  const retried = await fixture.monitor.scanGate(target());
  assert.equal(retried.duplicate, false);
  assert.equal(decodeCalls, 2);
});

test("만료된 HLS URL 오류는 cache를 한 번 무효화하고 즉시 재해석한다", async () => {
  for (const code of ["upstream_http", "invalid_playlist"]) {
    let attempts = 0;
    const fixture = monitorFixture({
      async fetchSegment() {
        attempts += 1;
        if (attempts === 1) throw errorWithCode(code, "playlist");
        return Buffer.from("fresh-segment");
      },
    });
    const result = await fixture.monitor.scanGate(target());
    assert.equal(result.duplicate, false);
    assert.equal(attempts, 2);
    assert.deepEqual(fixture.invalidations, [["sample_bj", "SD"]]);
    const stats = fixture.monitor.getSnapshot(BASE_TIME).stats;
    assert.equal(stats.hlsRetries, 1);
    assert.equal(stats.hlsPlaylistRetryErrors, 1);
    assert.equal(stats.hlsRetryCacheInvalidations, 1);
  }
});

test("segment 오류와 playlist timeout은 cache를 지우지 않고 같은 URL로 재시도한다", async () => {
  for (const [code, stage, counter] of [
    ["upstream_http", "segment", "hlsSegmentRetryErrors"],
    ["upstream_timeout", "playlist", "hlsPlaylistRetryErrors"],
    ["upstream_error", "playlist", "hlsPlaylistRetryErrors"],
    ["invalid_playlist", "segment", "hlsSegmentRetryErrors"],
  ]) {
    let attempts = 0;
    const fixture = monitorFixture({
      async fetchSegment() {
        attempts += 1;
        if (attempts === 1) throw errorWithCode(code, stage);
        return Buffer.from(`${stage}-recovered`);
      },
    });
    const result = await fixture.monitor.scanGate(target());
    assert.equal(result.duplicate, false);
    assert.equal(attempts, 2);
    assert.deepEqual(fixture.invalidations, []);
    const stats = fixture.monitor.getSnapshot(BASE_TIME).stats;
    assert.equal(stats.hlsRetries, 1);
    assert.equal(stats[counter], 1);
    assert.equal(stats.hlsRetryCacheInvalidations, 0);
  }
});

test("resolver timeout은 cache invalidation 없이 resolver만 재시도한다", async () => {
  let resolveCalls = 0;
  const invalidations = [];
  const fixture = monitorFixture({
    hlsCache: {
      async get() {
        resolveCalls += 1;
        if (resolveCalls === 1) throw errorWithCode("upstream_timeout");
        return { hlsUrl: "memory:SD" };
      },
      async invalidate(bjId, quality) { invalidations.push([bjId, quality]); },
    },
  });
  const result = await fixture.monitor.scanGate(target());
  assert.equal(result.duplicate, false);
  assert.equal(resolveCalls, 2);
  assert.deepEqual(invalidations, []);
  const stats = fixture.monitor.getSnapshot(BASE_TIME).stats;
  assert.equal(stats.hlsResolverRetryErrors, 1);
  assert.equal(stats.hlsRetryCacheInvalidations, 0);
});

test("재시도 소진 stage는 안전한 고정 counter로만 계측한다", async () => {
  let attempts = 0;
  const fixture = monitorFixture({
    async fetchSegment() {
      attempts += 1;
      const error = errorWithCode("upstream_timeout", "https://secret.example/token");
      throw error;
    },
  });
  await assert.rejects(() => fixture.monitor.scanGate(target()), error => (
    error.code === "upstream_timeout"
  ));
  assert.equal(attempts, 2);
  assert.deepEqual(fixture.invalidations, []);
  const stats = fixture.monitor.getSnapshot(BASE_TIME).stats;
  assert.equal(stats.hlsUnknownRetryErrors, 1);
  assert.equal(stats.hlsUnknownFailures, 1);
  assert.equal(stats.lastHlsErrorStage, "unknown");
  assert.equal(JSON.stringify(stats).includes("secret.example"), false);
});

test("not_live는 offline으로 전환하고 오류의 민감한 message를 snapshot에 넣지 않는다", async () => {
  const fixture = monitorFixture({
    hlsCache: {
      async get() { throw errorWithCode("not_live"); },
      async invalidate() {},
    },
  });
  const { promises } = fixture.monitor.dispatch(BASE_TIME);
  await Promise.all(promises);
  const snapshot = fixture.monitor.getSnapshot(BASE_TIME);
  assert.equal(snapshot.scheduler.counts.offline, 1);
  assert.equal(snapshot.stats.offlineResults, 1);
  assert.equal(JSON.stringify(snapshot).includes("민감한"), false);
});

test("candidate 방송만 normal lane에서 burst lane으로 동적 전환한다", async () => {
  const fixture = monitorFixture({
    gate: () => ({ uiCandidate: true, reason: "candidate" }),
    async decodePngFrame() { return Buffer.concat([PNG_SIGNATURE, Buffer.from([1])]); },
    async runOcr() {
      return { version: 2, profileId: "stats-panel-v1", seasonId: CURRENT_SEASON_ID, panelVisible: false, results: [] };
    },
    queuePath: "/tmp/test-observations.ndjson",
  });
  let dispatched = fixture.monitor.dispatch(BASE_TIME);
  assert.equal(dispatched.tasks[0].lane, "normal");
  await Promise.all(dispatched.promises);
  assert.equal(fixture.monitor.getSnapshot(BASE_TIME).scheduler.counts.burst, 1);

  fixture.setNow(BASE_TIME + DEFAULT_SCHEDULER_OPTIONS.burstIntervalMs);
  dispatched = fixture.monitor.dispatch(BASE_TIME + DEFAULT_SCHEDULER_OPTIONS.burstIntervalMs);
  assert.equal(dispatched.tasks[0].lane, "burst");
  await Promise.all(dispatched.promises);
});

test("OCR이 꺼져 있으면 gate 오탐이 burst 자원을 사용하지 않는다", async () => {
  const fixture = monitorFixture({ gate: () => ({ uiCandidate: true, reason: "candidate" }) });
  const dispatched = fixture.monitor.dispatch(BASE_TIME);
  await Promise.all(dispatched.promises);
  const snapshot = fixture.monitor.getSnapshot(BASE_TIME);
  assert.equal(snapshot.stats.uiCandidates, 1);
  assert.equal(snapshot.scheduler.counts.burst, 0);
});

test("OCR 활성 상태여도 normal lane에서는 OCR을 실행하지 않고 burst lane에서만 실행한다", async () => {
  let ocrRuns = 0;
  const fixture = monitorFixture({
    gate: () => ({ uiCandidate: true, reason: "candidate" }),
    async decodePngFrame() { return Buffer.concat([PNG_SIGNATURE, Buffer.from([1])]); },
    async runOcr() {
      ocrRuns += 1;
      return { version: 2, profileId: "stats-panel-v1", seasonId: CURRENT_SEASON_ID, panelVisible: false, results: [] };
    },
    queuePath: "/tmp/test-observations.ndjson",
  });
  await fixture.monitor.executeTask({ lane: "normal", target: target() });
  assert.equal(ocrRuns, 0);
  await fixture.monitor.executeTask({ lane: "burst", target: target() });
  assert.equal(ocrRuns, 1);
});

test("외부 오류 code는 안전한 고정 code만 통과시킨다", () => {
  assert.equal(safeErrorCode({ code: "upstream_http", message: "secret" }), "upstream_http");
  assert.equal(safeErrorCode({ code: "BAD token=secret" }), "scan_failed");
  assert.equal(safeErrorCode({ code: "token_secret" }), "scan_failed");
  assert.equal(safeErrorCode(new Error("secret")), "scan_failed");
  assert.equal(safeErrorCode(Object.defineProperty({}, "code", {
    get() { throw new Error("secret getter"); },
  })), "scan_failed");
});

test("현재 Sheet 참가자를 SOOP ID로 target에 매핑해 baseline을 만든다", () => {
  const targets = [target(), {
    id: "P002",
    playerId: "P002",
    bjId: "second_bj",
    sourceUrl: "https://play.sooplive.com/second_bj",
    enabled: true,
  }];
  const baselines = buildBaselinesFromMembers([
    { soopId: "second_bj", level: 22, strength: null },
    { soopId: "sample_bj", level: 11, strength: 7 },
  ], targets);
  assert.deepEqual(baselines, [
    { playerId: "P002", field: "level", value: 22 },
    { playerId: "P001", field: "level", value: 11 },
    { playerId: "P001", field: "strength", value: 7 },
  ]);
  assert.throws(
    () => buildBaselinesFromMembers([{ soopId: "unknown", level: 1 }], [target()]),
    error => error.code === "invalid_roster",
  );
});

test("runLoop는 실제 promise를 lease 만료로 중복 실행하지 않고 abort를 하위 요청에 전달한다", async () => {
  let concurrent = 0;
  let maxConcurrent = 0;
  let calls = 0;
  const controller = new AbortController();
  const monitor = createSamgukHlsMonitor({
    targets: [target()],
    baselines: [],
    schedulerOptions: {
      ...DEFAULT_SCHEDULER_OPTIONS,
      taskLeaseMs: 500,
      initialSpreadMs: 0,
      jitterRatio: 0,
    },
    hlsCache: {
      async get() { return { hlsUrl: "memory:SD" }; },
      async invalidate() {},
    },
    async fetchSegment(_url, { signal }) {
      calls += 1;
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          concurrent -= 1;
          reject(errorWithCode("aborted"));
        }, { once: true });
      });
    },
    async decodeGrayFrame() { return Buffer.alloc(FRAME_BYTES, 100); },
  });
  const loop = monitor.runLoop(controller.signal, { pollMs: 10 });
  await new Promise(resolve => setTimeout(resolve, 70));
  controller.abort();
  await loop;
  assert.equal(calls, 1);
  assert.equal(maxConcurrent, 1);
  assert.equal(monitor.getSnapshot().stats.failures, 0);
  assert.equal(monitor.getSnapshot().stats.lastErrorCode, null);
});

test("전체 task 상한은 normal+burst 합계가 메모리 예산을 넘지 않게 dispatch를 제한한다", async () => {
  const targets = Array.from({ length: 3 }, (_value, index) => {
    const number = index + 1;
    const playerId = `P${String(number).padStart(3, "0")}`;
    return {
      id: playerId,
      playerId,
      bjId: `sample_bj_${number}`,
      sourceUrl: `https://play.sooplive.com/sample_bj_${number}`,
      enabled: true,
    };
  });
  const releases = [];
  const monitor = createSamgukHlsMonitor({
    targets,
    baselines: [],
    now: BASE_TIME,
    clock: () => BASE_TIME,
    schedulerOptions: {
      ...DEFAULT_SCHEDULER_OPTIONS,
      normalConcurrency: 3,
      maxActiveTasks: 2,
      initialSpreadMs: 0,
      jitterRatio: 0,
    },
    hlsCache: {
      async get(bjId) { return { hlsUrl: `memory:${bjId}` }; },
      async invalidate() {},
    },
    async fetchSegment() {
      return new Promise(resolve => releases.push(() => resolve(Buffer.from("segment"))));
    },
    async decodeGrayFrame() { return Buffer.alloc(FRAME_BYTES, 0); },
  });

  const first = monitor.dispatch(BASE_TIME);
  assert.equal(first.tasks.length, 2);
  assert.equal(monitor.dispatch(BASE_TIME).tasks.length, 0);
  assert.equal(monitor.getSnapshot(BASE_TIME).activeTasks, 2);
  assert.equal(monitor.getSnapshot(BASE_TIME).maxActiveTasks, 2);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(releases.length, 2);
  releases.splice(0).forEach(release => release());
  await Promise.all(first.promises);

  const second = monitor.dispatch(BASE_TIME);
  assert.equal(second.tasks.length, 1);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(releases.length, 1);
  releases.splice(0).forEach(release => release());
  await Promise.all(second.promises);
});

test("task deadline은 lease 전에 하위 요청을 중단하고 명시적 실패로 적용한다", async () => {
  let taskSignal;
  const fixture = monitorFixture({
    schedulerOptions: {
      ...DEFAULT_SCHEDULER_OPTIONS,
      taskLeaseMs: 100,
      initialSpreadMs: 0,
      jitterRatio: 0,
    },
    async fetchSegment(_url, { signal }) {
      taskSignal = signal;
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(errorWithCode("aborted")), { once: true });
      });
    },
  });

  const { promises } = fixture.monitor.dispatch(BASE_TIME);
  await Promise.all(promises);

  assert.equal(taskSignal.aborted, true);
  const snapshot = fixture.monitor.getSnapshot(BASE_TIME);
  assert.equal(snapshot.stats.failures, 1);
  assert.equal(snapshot.stats.lastErrorCode, "task_deadline");
  assert.equal(snapshot.scheduler.targets[0].lastErrorCode, "task_deadline");
  assert.equal(snapshot.scheduler.targets[0].inFlightTaskId, null);
});

test("abort 뒤 늦게 resolve된 fetchSegments는 cursor·identity·stats를 변경하지 않는다", async () => {
  let resolveCall = 0;
  let fetchCall = 0;
  let resolveLateFetch;
  let markLateFetchStarted;
  const lateFetchStarted = new Promise(resolve => { markLateFetchStarted = resolve; });
  const fixture = monitorFixture({
    hlsCache: {
      async get() {
        resolveCall += 1;
        return {
          broadNo: resolveCall === 1 ? "200001" : "200002",
          hlsUrl: "memory:stable-url",
        };
      },
      async invalidate() {},
    },
    async fetchSegments() {
      fetchCall += 1;
      if (fetchCall === 1) return [batchSegment(5, "old-5")];
      if (fetchCall === 2) {
        markLateFetchStarted();
        return new Promise(resolve => { resolveLateFetch = resolve; });
      }
      return [batchSegment(1, "new-1"), batchSegment(2, "new-2"), batchSegment(3, "new-3")];
    },
    async decodeGrayFrame() { return Buffer.alloc(FRAME_BYTES, 0); },
  });
  await fixture.monitor.scanGate(target());
  const before = fixture.monitor.getSnapshot(BASE_TIME).stats;

  const controller = new AbortController();
  const lateScan = fixture.monitor.scanGate(target(), { signal: controller.signal });
  await lateFetchStarted;
  controller.abort();
  resolveLateFetch([batchSegment(1, "late-1"), batchSegment(2, "late-2")]);
  await assert.rejects(lateScan, error => error.code === "aborted");
  const afterAbort = fixture.monitor.getSnapshot(BASE_TIME).stats;
  assert.equal(afterAbort.streamResets, before.streamResets);
  assert.equal(afterAbort.segmentsFetched, before.segmentsFetched);
  assert.equal(afterAbort.segmentsProcessed, before.segmentsProcessed);
  assert.equal(afterAbort.staleSegmentsSkipped, before.staleSegmentsSkipped);

  const recovered = await fixture.monitor.scanGate(target());
  assert.equal(recovered.processedSegments, 3);
  const afterRecovery = fixture.monitor.getSnapshot(BASE_TIME).stats;
  assert.equal(afterRecovery.streamResets, 1);
  assert.equal(afterRecovery.segmentsFetched, before.segmentsFetched + 3);
});

test("동시 task는 독립 signal을 사용해 한 task deadline이 완료된 task signal을 오염시키지 않는다", async () => {
  const second = {
    id: "P002",
    playerId: "P002",
    bjId: "second_bj",
    sourceUrl: "https://play.sooplive.com/second_bj",
    enabled: true,
  };
  const signals = new Map();
  const monitor = createSamgukHlsMonitor({
    targets: [target(), second],
    baselines: [],
    now: BASE_TIME,
    clock: () => BASE_TIME,
    schedulerOptions: {
      ...DEFAULT_SCHEDULER_OPTIONS,
      taskLeaseMs: 100,
      normalConcurrency: 2,
      initialSpreadMs: 0,
      jitterRatio: 0,
    },
    hlsCache: {
      async get(bjId) { return { hlsUrl: `memory:${bjId}` }; },
      async invalidate() {},
    },
    async fetchSegment(url, { signal }) {
      signals.set(url, signal);
      if (url === "memory:sample_bj") return Buffer.from("first");
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(errorWithCode("aborted")), { once: true });
      });
    },
    async decodeGrayFrame() { return Buffer.alloc(FRAME_BYTES, 0); },
  });

  const { promises } = monitor.dispatch(BASE_TIME);
  await Promise.all(promises);

  const firstSignal = signals.get("memory:sample_bj");
  const secondSignal = signals.get("memory:second_bj");
  assert.notEqual(firstSignal, secondSignal);
  assert.equal(firstSignal.aborted, false);
  assert.equal(secondSignal.aborted, true);
  const snapshot = monitor.getSnapshot(BASE_TIME);
  assert.equal(snapshot.stats.liveResults, 1);
  assert.equal(snapshot.stats.failures, 1);
});

test("task별 같은 signal을 HLS resolve·fetch·gray/PNG decode·OCR 전 단계에 전달한다", async () => {
  const seen = { SD: [], [OCR_STREAM_QUALITY]: [] };
  const contexts = [];
  const fixture = monitorFixture({
    hlsCache: {
      async get(_bjId, quality, { signal }) {
        seen[quality].push(["resolve", signal]);
        return { hlsUrl: `memory:${quality}` };
      },
      async invalidate() {},
    },
    async fetchSegments(url, { signal }) {
      const quality = url.slice("memory:".length);
      seen[quality].push(["fetch", signal]);
      return quality === "SD"
        ? [batchSegment(90, "SD-90")]
        : [batchSegment(90, "HD-90"), batchSegment(91, "HD-91")];
    },
    async decodeGrayFrame(segment, { signal }) {
      const quality = segment.toString().slice(0, 2);
      seen[quality].push(["gray", signal]);
      return grayFrameBatch(quality === "SD" ? 1 : 6);
    },
    gate(frame) { return { uiCandidate: frame[0] === 1, reason: "test" }; },
    async decodePngFrame(_segment, { signal, sampleIndex }) {
      seen[OCR_STREAM_QUALITY].push([`png:${sampleIndex}`, signal]);
      return Buffer.concat([PNG_SIGNATURE, Buffer.from([sampleIndex])]);
    },
    async runOcr(_png, context, { signal }) {
      seen[OCR_STREAM_QUALITY].push(["ocr", signal]);
      contexts.push(context);
      return { version: 2, profileId: "stats-panel-v1", seasonId: CURRENT_SEASON_ID, panelVisible: true, results: [] };
    },
    queuePath: "/tmp/test-observations.ndjson",
  });

  let dispatched = fixture.monitor.dispatch(BASE_TIME);
  await Promise.all(dispatched.promises);
  fixture.setNow(BASE_TIME + DEFAULT_SCHEDULER_OPTIONS.burstIntervalMs);
  dispatched = fixture.monitor.dispatch(BASE_TIME + DEFAULT_SCHEDULER_OPTIONS.burstIntervalMs);
  await Promise.all(dispatched.promises);

  const normalSignal = seen.SD.find(([stage]) => stage === "gray")[1];
  const normalSignals = seen.SD.filter(([, signal]) => signal === normalSignal).map(([, signal]) => signal);
  const burstSdSignals = seen.SD.filter(([, signal]) => signal !== normalSignal).map(([, signal]) => signal);
  const burstSignals = seen[OCR_STREAM_QUALITY].map(([, signal]) => signal);
  assert.ok(normalSignals.length >= 3 && normalSignals.every(signal => signal === normalSignals[0]));
  assert.ok(burstSdSignals.length >= 2 && burstSdSignals.every(signal => signal === burstSignals[0]));
  assert.ok(burstSignals.length >= 6 && burstSignals.every(signal => signal === burstSignals[0]));
  assert.notEqual(normalSignals[0], burstSignals[0]);
  assert.ok(contexts.length > 0);
  assert.deepEqual(Object.keys(contexts[0]).sort(), ["bjId", "observedAt", "playerId", "targetId"]);
});

test("안전한 deadline을 만들 수 없는 짧은 task lease는 시작 전에 거부한다", () => {
  assert.throws(
    () => monitorFixture({
      schedulerOptions: {
        ...DEFAULT_SCHEDULER_OPTIONS,
        taskLeaseMs: 99,
        initialSpreadMs: 0,
        jitterRatio: 0,
      },
    }),
    error => error.code === "invalid_config",
  );
});

test("SD cursor 뒤 밀린 segment를 오래된 순서로 따라잡고 짧은 UI 후보에서 멈춘다", async () => {
  const calls = [];
  const batches = [
    [batchSegment(100, "plain-100")],
    [batchSegment(101, "plain-101"), batchSegment(102, "candidate-102"), batchSegment(103, "later-103")],
    [batchSegment(103, "later-103")],
  ];
  const fixture = monitorFixture({
    async fetchSegments(_url, options) {
      calls.push(options);
      return batches.shift();
    },
    async decodeGrayFrame(segment) {
      const candidate = segment.toString().startsWith("candidate");
      return Buffer.alloc(FRAME_BYTES, candidate ? 1 : 0);
    },
    gate(gray) { return { uiCandidate: gray[0] === 1, reason: "test" }; },
  });

  const first = await fixture.monitor.scanGate(target());
  const second = await fixture.monitor.scanGate(target());
  const third = await fixture.monitor.scanGate(target());
  assert.equal(first.uiCandidate, false);
  assert.equal(second.uiCandidate, true);
  assert.equal(second.mediaSequence, 102);
  assert.equal(second.processedSegments, 2);
  assert.equal(third.uiCandidate, false);
  assert.equal(calls[0].afterSegmentId, undefined);
  assert.equal(calls[0].initialSegmentCount, 1);
  assert.equal(calls[1].afterSegmentId, batchSegment(100).segmentId);
  assert.equal(calls[1].initialSegmentCount, 12);
  assert.equal(calls[2].afterSegmentId, batchSegment(102).segmentId);
  const stats = fixture.monitor.getSnapshot(BASE_TIME).stats;
  assert.equal(stats.catchupSegments, 2);
  assert.equal(stats.segmentsProcessed, 4);
});

test("burst 중 SD fresh segment도 gate decode하며 cursor gap 없이 전진한다", async () => {
  const sdBatches = [
    [batchSegment(100, "SD-100")],
    [batchSegment(101, "SD-101"), batchSegment(102, "SD-102"), batchSegment(103, "SD-103")],
    [batchSegment(104, "SD-104")],
  ];
  const grayDecoded = [];
  const fixture = monitorFixture({
    async fetchSegments(url) {
      const quality = url.slice("memory:".length);
      return quality === "SD"
        ? sdBatches.shift()
        : [batchSegment(100, "ORIGINAL-100")];
    },
    async decodeGrayFrame(segment) {
      const label = segment.toString();
      grayDecoded.push(label);
      return grayFrameBatch(label === "SD-100" ? [1] : []);
    },
    gate(frame) { return { uiCandidate: frame[0] === 1, reason: "test" }; },
    async decodePngFrame(_segment, { sampleIndex }) {
      return Buffer.concat([PNG_SIGNATURE, Buffer.from([sampleIndex])]);
    },
    async runOcr() {
      return {
        version: 2,
        profileId: "stats-panel-v1",
        seasonId: CURRENT_SEASON_ID,
        panelVisible: false,
        results: [],
      };
    },
    queuePath: "/tmp/test-burst-sd-cursor.ndjson",
  });

  const normal = await fixture.monitor.executeTask({ lane: "normal", target: target() });
  const burst = await fixture.monitor.executeTask({ lane: "burst", target: target() });
  const resumed = await fixture.monitor.executeTask({ lane: "normal", target: target() });

  assert.equal(normal.uiCandidate, true);
  assert.equal(burst.endBurst, true);
  assert.equal(resumed.uiCandidate, false);
  assert.deepEqual(grayDecoded, ["SD-100", "SD-101", "SD-102", "SD-103", "SD-104"]);
  const stats = fixture.monitor.getSnapshot(BASE_TIME).stats;
  assert.equal(stats.burstSdSegmentsAdvanced, 3);
  assert.equal(stats.burstSdGateSegments, 3);
  assert.equal(stats.burstSdSyncErrors, 0);
  assert.equal(stats.sdSequenceGaps, 0);
  assert.equal(stats.sdSegmentsMissed, 0);
});

test("burst OCR 실패 시 병렬로 받은 SD cursor는 확정하지 않고 normal에서 재검사한다", async () => {
  const sdOptions = [];
  const sdBatches = [
    [batchSegment(110, "SD-110")],
    [batchSegment(111, "SD-111"), batchSegment(112, "SD-112")],
    [batchSegment(111, "SD-111"), batchSegment(112, "SD-112")],
  ];
  const grayDecoded = [];
  const fixture = monitorFixture({
    async fetchSegments(url, options) {
      const quality = url.slice("memory:".length);
      if (quality === "SD") {
        sdOptions.push(options);
        return sdBatches.shift();
      }
      return [batchSegment(110, "ORIGINAL-110")];
    },
    async decodeGrayFrame(segment) {
      const label = segment.toString();
      grayDecoded.push(label);
      return grayFrameBatch(label === "SD-110" ? [1] : []);
    },
    gate(frame) { return { uiCandidate: frame[0] === 1, reason: "test" }; },
    async decodePngFrame(_segment, { sampleIndex }) {
      return Buffer.concat([PNG_SIGNATURE, Buffer.from([sampleIndex])]);
    },
    async runOcr() { throw errorWithCode("ocr_failed"); },
    queuePath: "/tmp/test-burst-sd-cursor-ocr-failure.ndjson",
  });

  await fixture.monitor.executeTask({ lane: "normal", target: target() });
  await assert.rejects(
    fixture.monitor.executeTask({ lane: "burst", target: target() }),
    error => error.code === "ocr_failed",
  );
  const resumed = await fixture.monitor.executeTask({ lane: "normal", target: target() });

  assert.equal(resumed.gate.processedSegments, 2);
  assert.equal(sdOptions[1].afterSegmentId, batchSegment(110).segmentId);
  assert.equal(sdOptions[2].afterSegmentId, batchSegment(110).segmentId);
  assert.deepEqual(grayDecoded, ["SD-110", "SD-111", "SD-112", "SD-111", "SD-112"]);
  const stats = fixture.monitor.getSnapshot(BASE_TIME).stats;
  assert.equal(stats.burstSdSegmentsAdvanced, 0);
  assert.equal(stats.sdSequenceGaps, 0);
});

test("burst 중 연속 SD 후보는 기존 archive를 덮지 않고 64개 FIFO로 보존·OCR한다", async () => {
  let sdCall = 0;
  let originalCall = 0;
  let releaseOcr;
  const ocrRelease = new Promise(resolve => { releaseOcr = resolve; });
  const archiveBodies = new Map();
  let archiveIndex = 0;
  const fixture = monitorFixture({
    async fetchSegments(url) {
      const quality = url.slice("memory:".length);
      if (quality === "SD") {
        sdCall += 1;
        if (sdCall === 1) return [batchSegment(100, "SD-100")];
        if (sdCall >= 2 && sdCall <= 6) {
          const firstSequence = 101 + (sdCall - 2) * 12;
          return Array.from({ length: 12 }, (_value, index) => (
            batchSegment(firstSequence + index, `SD-${firstSequence + index}`)
          ));
        }
        if (sdCall === 7) {
          return Array.from({ length: 5 }, (_value, index) => (
            batchSegment(161 + index, `SD-${161 + index}`)
          ));
        }
        return [];
      }
      const sequence = 100 + originalCall;
      originalCall += 1;
      return [batchSegment(sequence, `ORIGINAL-${sequence}`)];
    },
    async decodeGrayFrame(segment) {
      const label = segment.toString();
      return grayFrameBatch(label.startsWith("SD-") ? [2] : []);
    },
    gate(frame) { return { uiCandidate: frame[0] === 1, reason: "test" }; },
    async decodePngFrame(segment, { sampleIndex }) {
      const sequence = Number(segment.toString().match(/(\d+)$/)?.[1] || 0);
      return Buffer.concat([PNG_SIGNATURE, Buffer.from([sequence & 0xff, sampleIndex])]);
    },
    async runOcr() {
      await ocrRelease;
      return {
        version: 2,
        profileId: "stats-panel-v1",
        seasonId: CURRENT_SEASON_ID,
        panelVisible: false,
        results: [],
      };
    },
    async archiveCandidateFrame(png) {
      const reference = `fifo-${++archiveIndex}.png`;
      archiveBodies.set(reference, png);
      return reference;
    },
    async readCandidateFrame(reference) { return archiveBodies.get(reference); },
    queuePath: "/tmp/test-burst-candidate-fifo.ndjson",
  });

  await fixture.monitor.executeTask({ lane: "normal", target: target() });
  const firstPromise = fixture.monitor.executeTask({ lane: "burst", target: target() });
  while (fixture.monitor.getSnapshot(BASE_TIME).stats.burstSdGateSegments < 12) {
    await new Promise(resolve => setImmediate(resolve));
  }
  for (let index = 0; index < 5; index += 1) {
    await fixture.monitor.syncBurstSdCursor(target());
  }
  const queuedSnapshot = fixture.monitor.getSnapshot(BASE_TIME).stats;
  assert.equal(queuedSnapshot.candidateQueueAdds, 64);
  assert.equal(queuedSnapshot.candidateQueueDrops, 1);
  assert.equal(queuedSnapshot.candidateQueueDepth, 64);

  releaseOcr();
  const first = await firstPromise;
  assert.equal(first.continuedForQueuedCandidate, true);
  assert.equal(first.ocr.frames.every(frame => frame.mediaSequence === 100), true);

  const queued = [];
  for (let index = 0; index < 64; index += 1) {
    queued.push(await fixture.monitor.executeTask({ lane: "burst", target: target() }));
  }
  assert.deepEqual(
    queued.map(result => result.ocr.frames[0]?.mediaSequence),
    Array.from({ length: 64 }, (_value, index) => 101 + index),
  );
  const stats = fixture.monitor.getSnapshot(BASE_TIME).stats;
  assert.equal(stats.burstSdGateSegments, 65);
  assert.equal(stats.burstSdUiCandidates, 64);
  assert.equal(stats.candidateQueueAdds, 64);
  assert.equal(stats.candidateQueueDrops, 1);
  assert.equal(stats.candidateQueueDepth, 0);
  assert.ok(stats.candidateFramesLoaded >= 66);
});

test("batch 중간 decode 실패 시 성공한 cursor까지만 확정하고 실패 segment부터 재시도한다", async () => {
  const calls = [];
  let fetchCall = 0;
  let failed = false;
  const fixture = monitorFixture({
    async fetchSegments(_url, options) {
      calls.push(options);
      fetchCall += 1;
      return fetchCall === 1
        ? [batchSegment(200), batchSegment(201)]
        : [batchSegment(201)];
    },
    async decodeGrayFrame(segment) {
      if (segment.equals(batchSegment(201).body) && !failed) {
        failed = true;
        throw errorWithCode("ffmpeg_failed");
      }
      return Buffer.alloc(FRAME_BYTES, 0);
    },
  });

  await assert.rejects(() => fixture.monitor.scanGate(target()), error => error.code === "ffmpeg_failed");
  await fixture.monitor.scanGate(target());
  assert.equal(calls[1].afterSegmentId, batchSegment(200).segmentId);
});

test("SD 후보와 같은 ORIGINAL media sequence부터 OCR하고 숨김 두 frame이면 한 번에 burst를 끝낸다", async () => {
  const decoded = [];
  const fetchCalls = [];
  const fixture = monitorFixture({
    async fetchSegments(url, options) {
      const quality = url.slice("memory:".length);
      fetchCalls.push({ quality, options });
      if (quality === "SD") return [batchSegment(301, "sd-candidate")];
      return [
        batchSegment(300, "hd-before"),
        batchSegment(301, "hd-candidate"),
        batchSegment(302, "hd-after"),
        batchSegment(303, "hd-unused"),
      ];
    },
    gate: () => ({ uiCandidate: true, reason: "candidate" }),
    async decodePngFrame(segment) {
      decoded.push(segment.toString());
      return Buffer.concat([PNG_SIGNATURE, Buffer.from([1])]);
    },
    async runOcr() {
      return { version: 2, profileId: "stats-panel-v1", seasonId: CURRENT_SEASON_ID, panelVisible: false, results: [] };
    },
    queuePath: "/tmp/test-observations.ndjson",
  });

  const normal = await fixture.monitor.executeTask({ lane: "normal", target: target() });
  const burst = await fixture.monitor.executeTask({ lane: "burst", target: target() });
  assert.equal(normal.uiCandidate, true);
  assert.equal(burst.endBurst, true);
  assert.equal(burst.ocr.sequenceMatched, true);
  assert.deepEqual(decoded, ["hd-candidate", "hd-after"]);
  const originalFetch = fetchCalls.find(call => call.quality === OCR_STREAM_QUALITY);
  assert.equal(originalFetch.options.initialSegmentCount, 6);
  assert.equal(fixture.monitor.getSnapshot(BASE_TIME).stats.earlyBurstEnds, 1);
});

test("SD와 ORIGINAL sequence가 같으면 후보 전·해당·후 frame을 즉시 보존한다", async () => {
  const grayDecoded = [];
  const pngDecoded = [];
  const archiveBodies = new Map();
  const fixture = monitorFixture({
    async fetchSegments(url) {
      const quality = url.slice("memory:".length);
      return quality === "SD"
        ? [batchSegment(301, "sd-candidate")]
        : [
          batchSegment(300, "original-before"),
          batchSegment(301, "original-candidate"),
          batchSegment(302, "original-after"),
        ];
    },
    async decodeGrayFrame(segment) {
      const label = segment.toString();
      grayDecoded.push(label);
      return grayFrameBatch(label === "sd-candidate" ? [2] : []);
    },
    gate(frame) { return { uiCandidate: frame[0] === 1, reason: "test" }; },
    async decodePngFrame(segment, options) {
      pngDecoded.push([segment.toString(), options.sampleIndex]);
      return Buffer.concat([PNG_SIGNATURE, Buffer.from([options.sampleIndex])]);
    },
    async runOcr() {
      return {
        version: 2,
        profileId: "stats-panel-v1",
        seasonId: CURRENT_SEASON_ID,
        panelVisible: true,
        results: [],
      };
    },
    async archiveCandidateFrame(png) {
      const reference = `exact-${archiveBodies.size + 1}.png`;
      archiveBodies.set(reference, png);
      return reference;
    },
    async readCandidateFrame(reference) { return archiveBodies.get(reference); },
    queuePath: "/tmp/test-exact-original-prefetch.ndjson",
  });

  await fixture.monitor.executeTask({ lane: "normal", target: target() });
  assert.deepEqual(grayDecoded, ["sd-candidate"]);
  const burst = await fixture.monitor.executeTask({ lane: "burst", target: target() });
  assert.deepEqual(grayDecoded, ["sd-candidate"]);
  assert.deepEqual(pngDecoded, [
    ["sd-candidate", 2],
    ["sd-candidate", 3],
    ["original-candidate", 2],
    ["original-before", 7],
    ["original-after", 0],
    ["original-candidate", 3],
  ]);
  assert.equal(burst.ocr.frames.length, 4);
});

test("보존 ring 앞쪽이 숨김이어도 뒤쪽 ORIGINAL 후보까지 전부 OCR한다", async () => {
  const archiveBodies = new Map();
  const decoded = [];
  const fixture = monitorFixture({
    async fetchSegments(url) {
      return url === "memory:SD"
        ? [batchSegment(301, "sd-candidate")]
        : [
          batchSegment(300, "original-before"),
          batchSegment(301, "original-exact"),
          batchSegment(302, "original-after"),
        ];
    },
    async decodeGrayFrame(segment) {
      return grayFrameBatch(segment.toString() === "sd-candidate" ? [2] : []);
    },
    gate(frame) { return { uiCandidate: frame[0] === 1, reason: "test" }; },
    async decodePngFrame(segment, { sampleIndex }) {
      const label = segment.toString();
      decoded.push([label, sampleIndex]);
      return Buffer.concat([
        PNG_SIGNATURE,
        Buffer.from([label === "original-after" ? 1 : 0, sampleIndex]),
      ]);
    },
    async runOcr(png) {
      return {
        version: 2,
        profileId: "stats-panel-v1",
        seasonId: CURRENT_SEASON_ID,
        panelVisible: png.at(-2) === 1,
        results: [],
      };
    },
    async archiveCandidateFrame(png) {
      const reference = `ring-${archiveBodies.size + 1}.png`;
      archiveBodies.set(reference, png);
      return reference;
    },
    async readCandidateFrame(reference) { return archiveBodies.get(reference); },
    queuePath: "/tmp/test-archived-ring-tail.ndjson",
  });

  await fixture.monitor.executeTask({ lane: "normal", target: target() });
  const burst = await fixture.monitor.executeTask({ lane: "burst", target: target() });

  assert.deepEqual(decoded, [
    ["sd-candidate", 2],
    ["sd-candidate", 3],
    ["original-exact", 2],
    ["original-before", 7],
    ["original-after", 0],
    ["original-exact", 3],
  ]);
  assert.equal(burst.ocr.frames.length, 4);
  assert.equal(burst.ocr.panelVisible, true);
  assert.equal(burst.ocr.endBurst, false);
});

test("90-stream 순간 후보 prefetch도 ORIGINAL 동시 작업을 12개로 제한한다", async () => {
  const targets = Array.from({ length: 13 }, (_value, index) => {
    const playerId = `P${String(index + 1).padStart(3, "0")}`;
    const bjId = `sample_${index + 1}`;
    return {
      id: playerId,
      playerId,
      bjId,
      sourceUrl: `https://play.sooplive.com/${bjId}`,
      enabled: true,
    };
  });
  let releaseOriginal;
  const originalReady = new Promise(resolve => { releaseOriginal = resolve; });
  let originalCalls = 0;
  let archiveIndex = 0;
  let releaseFallback;
  const fallbackReady = new Promise(resolve => { releaseFallback = resolve; });
  const archiveBodies = new Map();
  const archiveTargets = new Map();
  const loaded = [];
  const monitor = createSamgukHlsMonitor({
    targets,
    baselines: [],
    clock: () => BASE_TIME,
    schedulerOptions: {
      ...DEFAULT_SCHEDULER_OPTIONS,
      initialSpreadMs: 0,
      jitterRatio: 0,
    },
    hlsCache: {
      async get(_bjId, quality) { return { hlsUrl: `memory:${quality}` }; },
      async invalidate() {},
    },
    async fetchSegments(url) {
      if (url === "memory:ORIGINAL") {
        originalCalls += 1;
        await originalReady;
        return [batchSegment(10, "original-candidate")];
      }
      return [batchSegment(10, "sd-candidate")];
    },
    async decodeGrayFrame() { return grayFrameBatch([2]); },
    gate(frame) { return { uiCandidate: frame[0] === 1, reason: "test" }; },
    async decodePngFrame(_segment, { sampleIndex }) {
      return Buffer.concat([PNG_SIGNATURE, Buffer.from([sampleIndex])]);
    },
    async runOcr() {
      return {
        version: 2,
        profileId: "stats-panel-v1",
        seasonId: CURRENT_SEASON_ID,
        panelVisible: true,
        results: [],
      };
    },
    async archiveCandidateFrame(png, metadata) {
      if (metadata.targetId === "P013") await fallbackReady;
      const reference = `bounded-${++archiveIndex}.png`;
      archiveBodies.set(reference, png);
      archiveTargets.set(reference, metadata.targetId);
      return reference;
    },
    async readCandidateFrame(reference) {
      loaded.push(reference);
      return archiveBodies.get(reference);
    },
    queuePath: "/tmp/test-bounded-eager-prefetch.ndjson",
  });

  await Promise.all(targets.map(item => monitor.executeTask({ lane: "normal", target: item })));
  assert.equal(originalCalls, 12);
  assert.equal(monitor.getSnapshot(BASE_TIME).stats.candidatePrefetchesActive, 12);
  assert.equal(monitor.getSnapshot(BASE_TIME).stats.candidatePrefetchSaturated, 1);
  assert.equal(monitor.getSnapshot(BASE_TIME).stats.candidateFallbackArchiveStarts, 1);
  assert.equal(monitor.getSnapshot(BASE_TIME).stats.candidateFallbackArchivesActive, 1);
  assert.equal(monitor.getSnapshot(BASE_TIME).stats.candidateFallbackArchiveSaturated, 0);

  releaseFallback();
  while (monitor.getSnapshot(BASE_TIME).stats.candidateFallbackArchivesActive > 0) {
    await new Promise(resolve => setImmediate(resolve));
  }
  const fallbackOcr = await monitor.scanOcr(targets[12]);
  assert.equal(originalCalls, 12);
  assert.equal(fallbackOcr.frames.length, 2);
  assert.equal(loaded.length, 2);
  assert.equal(loaded.every(reference => archiveTargets.get(reference) === "P013"), true);

  releaseOriginal();
  while (monitor.getSnapshot(BASE_TIME).stats.candidatePrefetchesActive > 0) {
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(monitor.getSnapshot(BASE_TIME).stats.candidatePrefetchStarts, 12);
});

test("SD 후보는 normal 반환과 동시에 ORIGINAL prefetch를 시작하고 sequence가 달라도 저장본으로 OCR한다", async () => {
  const fetchQualities = [];
  const archived = [];
  const archiveBodies = new Map();
  const loaded = [];
  const pngDecoded = [];
  const fixture = monitorFixture({
    async fetchSegments(url) {
      const quality = url.slice("memory:".length);
      fetchQualities.push(quality);
      if (quality === "SD") return [batchSegment(301, "sd-candidate")];
      return [
        batchSegment(900, "hd-before"),
        batchSegment(901, "hd-candidate"),
      ];
    },
    async decodeGrayFrame(segment) {
      const label = segment.toString();
      if (label === "sd-candidate") return grayFrameBatch([1]);
      if (label === "hd-candidate") return grayFrameBatch([2]);
      return grayFrameBatch([]);
    },
    gate(frame) { return { uiCandidate: frame[0] === 1, reason: "test" }; },
    async decodePngFrame(segment, options) {
      pngDecoded.push([segment.toString(), options.sampleIndex]);
      return Buffer.concat([PNG_SIGNATURE, Buffer.from([options.sampleIndex])]);
    },
    async runOcr() {
      return { version: 2, profileId: "stats-panel-v1", seasonId: CURRENT_SEASON_ID, panelVisible: true, results: [] };
    },
    async archiveCandidateFrame(png, context) {
      archived.push({ png, context });
      const reference = `candidate-${archived.length}.png`;
      archiveBodies.set(reference, png);
      return reference;
    },
    async readCandidateFrame(reference) {
      loaded.push(reference);
      return archiveBodies.get(reference);
    },
    queuePath: "/tmp/test-prefetched-candidate.ndjson",
  });

  const normal = await fixture.monitor.executeTask({ lane: "normal", target: target() });
  assert.equal(normal.uiCandidate, true);

  const burst = await fixture.monitor.executeTask({ lane: "burst", target: target() });
  assert.equal(burst.ocr.sequenceMissed, false);
  assert.equal(burst.ocr.frames.length, 2);
  assert.equal(fetchQualities[0], "SD");
  assert.deepEqual(fetchQualities.slice(1).sort(), [OCR_STREAM_QUALITY, "SD"].sort());
  assert.deepEqual(pngDecoded, [
    ["sd-candidate", 1],
    ["sd-candidate", 2],
    ["hd-candidate", 2],
    ["hd-candidate", 3],
  ]);
  assert.deepEqual(loaded, ["candidate-3.png", "candidate-4.png"]);
  const stats = fixture.monitor.getSnapshot(BASE_TIME).stats;
  assert.equal(stats.candidateFramePrefetches, 1);
  assert.equal(stats.candidatePrefetchStarts, 1);
  assert.equal(stats.candidatePrefetchesActive, 0);
  assert.equal(stats.candidateFramesArchived, 4);
  assert.equal(stats.candidateSdFallbackArchivedFrames, 2);
  assert.equal(stats.candidateFramesLoaded, 2);
  assert.equal(stats.candidateFramesPending, 0);
  assert.equal(stats.candidateFrameCaptureErrors, 0);
  assert.equal(stats.ocrRuns, 2);
});

test("보존 frame 읽기 실패 뒤에도 pending을 유지해 다음 burst에서 재시도한다", async () => {
  let readCalls = 0;
  const png = Buffer.concat([PNG_SIGNATURE, Buffer.from([7])]);
  const fixture = monitorFixture({
    async fetchSegments(url) {
      return url === "memory:SD"
        ? [batchSegment(10, "sd-candidate")]
        : [batchSegment(99, "hd-candidate")];
    },
    async decodeGrayFrame(segment) {
      return grayFrameBatch(segment.toString() === "sd-candidate" ? [1] : [2]);
    },
    gate(frame) { return { uiCandidate: frame[0] === 1, reason: "test" }; },
    async decodePngFrame() { return png; },
    async archiveCandidateFrame() { return "candidate-retry.png"; },
    async readCandidateFrame() {
      readCalls += 1;
      if (readCalls === 1) throw errorWithCode("upstream_error");
      return png;
    },
    async runOcr() {
      return { version: 2, profileId: "stats-panel-v1", seasonId: CURRENT_SEASON_ID, panelVisible: true, results: [] };
    },
    queuePath: "/tmp/test-prefetched-retry.ndjson",
  });

  await fixture.monitor.executeTask({ lane: "normal", target: target() });
  await assert.rejects(
    fixture.monitor.executeTask({ lane: "burst", target: target() }),
    error => error.code === "upstream_error",
  );
  assert.equal(fixture.monitor.getSnapshot(BASE_TIME).stats.candidateFramesPending, 2);
  const retried = await fixture.monitor.executeTask({ lane: "burst", target: target() });
  assert.equal(retried.ocr.frames.length, 2);
  assert.equal(fixture.monitor.getSnapshot(BASE_TIME).stats.candidateFramesPending, 0);
});

test("ORIGINAL이 SD 후보 sequence보다 늦게 도착하면 이전 구간은 건너뛰고 같은 sequence를 기다린다", async () => {
  let hdCall = 0;
  let ocrRuns = 0;
  const hdOptions = [];
  const fixture = monitorFixture({
    async fetchSegments(url, options) {
      const quality = url.slice("memory:".length);
      if (quality === "SD") return [batchSegment(401, "sd-candidate")];
      hdOptions.push(options);
      hdCall += 1;
      return hdCall === 1
        ? [batchSegment(399), batchSegment(400)]
        : [batchSegment(401)];
    },
    gate: () => ({ uiCandidate: true, reason: "candidate" }),
    async decodePngFrame() { return Buffer.concat([PNG_SIGNATURE, Buffer.from([1])]); },
    async runOcr() {
      ocrRuns += 1;
      return { version: 2, profileId: "stats-panel-v1", seasonId: CURRENT_SEASON_ID, panelVisible: true, results: [] };
    },
    queuePath: "/tmp/test-observations.ndjson",
  });

  await fixture.monitor.executeTask({ lane: "normal", target: target() });
  const waiting = await fixture.monitor.executeTask({ lane: "burst", target: target() });
  const matched = await fixture.monitor.executeTask({ lane: "burst", target: target() });
  assert.equal(waiting.ocr.waitingForCandidateSequence, true);
  assert.equal(waiting.uiCandidate, true);
  assert.equal(ocrRuns, 1);
  assert.equal(matched.ocr.sequenceMatched, true);
  assert.equal(hdOptions[1].afterSegmentId, batchSegment(400).segmentId);
});

test("ORIGINAL이 늦어도 감지 당시 SD fallback frame을 보존해 바로 OCR한다", async () => {
  let originalCall = 0;
  const archivedSequences = [];
  const archiveBodies = new Map();
  const decodedLabels = [];
  const fixture = monitorFixture({
    async fetchSegments(url) {
      const quality = url.slice("memory:".length);
      if (quality === "SD") return [batchSegment(401, "sd-candidate")];
      originalCall += 1;
      return originalCall === 1
        ? [batchSegment(399, "original-old-399"), batchSegment(400, "original-old-400")]
        : [batchSegment(401, "original-candidate-401")];
    },
    async decodeGrayFrame(segment) {
      return grayFrameBatch(segment.toString() === "sd-candidate" ? [2] : []);
    },
    gate(frame) { return { uiCandidate: frame[0] === 1, reason: "test" }; },
    async decodePngFrame(segment, { sampleIndex }) {
      decodedLabels.push([segment.toString(), sampleIndex]);
      return Buffer.concat([PNG_SIGNATURE, Buffer.from([sampleIndex])]);
    },
    async runOcr() {
      return {
        version: 2,
        profileId: "stats-panel-v1",
        seasonId: CURRENT_SEASON_ID,
        panelVisible: true,
        results: [],
      };
    },
    async archiveCandidateFrame(png, context) {
      archivedSequences.push(context.mediaSequence);
      const reference = `lag-${archiveBodies.size + 1}.png`;
      archiveBodies.set(reference, png);
      return reference;
    },
    async readCandidateFrame(reference) { return archiveBodies.get(reference); },
    queuePath: "/tmp/test-eager-original-lag.ndjson",
  });

  await fixture.monitor.executeTask({ lane: "normal", target: target() });
  const burst = await fixture.monitor.executeTask({ lane: "burst", target: target() });

  assert.equal(originalCall, 1);
  assert.deepEqual(archivedSequences, [401, 401]);
  assert.deepEqual(decodedLabels, [
    ["sd-candidate", 2],
    ["sd-candidate", 3],
  ]);
  assert.equal(burst.ocr.frames.length, 2);
  assert.equal(burst.ocr.frames.every(frame => frame.mediaSequence === 401), true);
  assert.equal(fixture.monitor.getSnapshot(BASE_TIME).stats.candidateSdFallbackUses, 1);
});

test("batch segment ID와 media sequence 순서를 신뢰하지 않고 monitor 경계에서 재검증한다", async () => {
  const fixture = monitorFixture({
    async fetchSegments() {
      return [batchSegment(2), batchSegment(1)];
    },
  });
  await assert.rejects(
    () => fixture.monitor.scanGate(target()),
    error => error.code === "invalid_segment",
  );
});

test("순간 panel 값은 같은 segment의 서로 다른 frame으로 확인하고 중복 승격하지 않는다", async () => {
  const sampleIndices = [];
  const appendCalls = [];
  let hdRequests = 0;
  const fixture = monitorFixture({
    baselines: [{ playerId: "P001", field: "strength", value: 10 }],
    async fetchSegments(url) {
      const quality = url.slice("memory:".length);
      if (quality === "SD") return [batchSegment(500, `${quality}-500`)];
      const sequence = 500 + hdRequests;
      hdRequests += 1;
      return [batchSegment(sequence, `${quality}-${sequence}`)];
    },
    async decodeGrayFrame() { return grayFrameBatch(3); },
    gate(frame) { return { uiCandidate: frame[0] === 1, reason: "test" }; },
    async decodePngFrame(_segment, options) {
      sampleIndices.push(options.sampleIndex);
      return Buffer.concat([PNG_SIGNATURE, Buffer.from([options.sampleIndex])]);
    },
    async runOcr() {
      return {
        version: 2,
        profileId: "stats-panel-v1",
        seasonId: CURRENT_SEASON_ID,
        panelVisible: true,
        results: [{ field: "strength", value: 11, confidence: 0.99 }],
      };
    },
    queuePath: "/tmp/test-observations.ndjson",
    appendFn(_path, observations) {
      appendCalls.push(observations);
      return { inserted: observations };
    },
  });

  const normal = await fixture.monitor.executeTask({ lane: "normal", target: target() });
  const firstBurst = await fixture.monitor.executeTask({ lane: "burst", target: target() });
  assert.equal(normal.gate.sampleIndex, 3);
  assert.equal(firstBurst.ocr.sequenceMatched, true);
  assert.deepEqual(sampleIndices, [3, 4]);
  assert.equal(appendCalls.length, 1);
  assert.equal(appendCalls[0].length, 2);

  await fixture.monitor.executeTask({ lane: "burst", target: target() });
  assert.deepEqual(sampleIndices, [3, 4, 3, 4]);
  assert.equal(appendCalls.length, 1);
  assert.equal(new Set(appendCalls[0].map(item => item.sourceId)).size, 2);
  assert.equal(new Set(appendCalls[0].map(item => item.evidenceHash)).size, 2);
});

test("generic gate가 HUD를 놓쳐도 분산 probe가 플레이어·말 HP를 두 segment로 확인한 뒤 종료한다", async () => {
  let sdSequence = 700;
  let hdSequence = 700;
  const appendCalls = [];
  const fixture = monitorFixture({
    profileId: "hud-combat-v1",
    baselines: [
      { playerId: "P001", field: "maxHealth", value: 1200 },
      { playerId: "P001", field: "horseMaxHealth", value: 900 },
    ],
    async fetchSegments(url) {
      const quality = url.slice("memory:".length);
      const sequence = quality === "SD" ? sdSequence++ : hdSequence++;
      return [batchSegment(sequence, `${quality}-${sequence}`)];
    },
    async decodeGrayFrame() { return grayFrameBatch([]); },
    gate(frame) { return { uiCandidate: frame[0] === 1, reason: "test" }; },
    async decodePngFrame(_segment, options) {
      return Buffer.concat([PNG_SIGNATURE, Buffer.from([options.sampleIndex])]);
    },
    async runOcr() {
      return {
        version: 2,
        profileId: "hud-combat-v1",
        seasonId: CURRENT_SEASON_ID,
        panelVisible: true,
        results: [
          { field: "maxHealth", value: 1239, confidence: 0.99 },
          { field: "horseMaxHealth", value: 950, confidence: 0.99 },
        ],
      };
    },
    queuePath: "/tmp/test-hud-max-health-observations.ndjson",
    appendFn(_path, observations) {
      appendCalls.push(observations);
      return { inserted: observations };
    },
  });

  const normal = await fixture.monitor.executeTask({ lane: "normal", target: target() });
  assert.equal(normal.uiCandidate, true);
  assert.equal(normal.gate.hudProbe, true);

  const first = await fixture.monitor.executeTask({ lane: "burst", target: target() });
  assert.equal(first.uiCandidate, false);
  assert.equal(first.ocr.panelVisible, true);
  assert.equal(first.ocr.consecutiveHiddenFrames, 1);
  assert.equal(first.ocr.endBurst, false);
  assert.equal(first.ocr.frames.length, 1);
  assert.ok(first.ocr.frames.every(frame => frame.burstVisible === false));
  assert.equal(appendCalls.length, 0);

  const second = await fixture.monitor.executeTask({ lane: "burst", target: target() });
  assert.equal(second.endBurst, true);
  assert.equal(second.ocr.consecutiveHiddenFrames, 2);
  assert.equal(appendCalls.length, 1);
  assert.equal(appendCalls[0].length, 4);
  assert.equal(new Set(appendCalls[0].map(item => item.sourceId)).size, 2);
  assert.equal(new Set(appendCalls[0].map(item => item.evidenceHash)).size, 2);
  const immediateNormal = await fixture.monitor.executeTask({ lane: "normal", target: target() });
  assert.equal(immediateNormal.uiCandidate, false);
  const stats = fixture.monitor.getSnapshot(BASE_TIME).stats;
  assert.equal(stats.hudProbes, 1);
  assert.equal(stats.confirmedUiPanels, 0);
  assert.equal(stats.earlyBurstEnds, 1);
});

test("HUD panelVisible만 있거나 HP만 있으면 burst를 유지하지 않고 실제 panel field만 유지한다", async () => {
  async function runHud(results) {
    const fixture = monitorFixture({
      profileId: "hud-combat-v1",
      async fetchSegments(url) {
        const quality = url.slice("memory:".length);
        return [batchSegment(800, `${quality}-800`)];
      },
      async decodeGrayFrame() { return grayFrameBatch([2]); },
      gate(frame) { return { uiCandidate: frame[0] === 1, reason: "test" }; },
      async decodePngFrame(_segment, { sampleIndex }) {
        return Buffer.concat([PNG_SIGNATURE, Buffer.from([sampleIndex])]);
      },
      async runOcr() {
        return {
          version: 2,
          profileId: "hud-combat-v1",
          seasonId: CURRENT_SEASON_ID,
          panelVisible: true,
          results,
        };
      },
      queuePath: "/tmp/test-hud-burst-visibility.ndjson",
    });
    await fixture.monitor.executeTask({ lane: "normal", target: target() });
    return fixture.monitor.executeTask({ lane: "burst", target: target() });
  }

  const empty = await runHud([]);
  const passive = await runHud([{ field: "maxHealth", value: 1234, confidence: 0.99 }]);
  const transient = await runHud([{ field: "strength", value: 77, confidence: 0.99 }]);

  assert.equal(empty.uiCandidate, false);
  assert.equal(passive.uiCandidate, false);
  assert.equal(transient.uiCandidate, true);
  assert.equal(empty.ocr.frames.every(frame => frame.burstVisible === false), true);
  assert.equal(passive.ocr.frames.every(frame => frame.burstVisible === false), true);
  assert.equal(transient.ocr.frames.some(frame => frame.burstVisible === true), true);
});

test("segment의 모든 후보 run을 수집하고 뒤쪽 후보까지 OCR한 후에만 hidden 종료를 판단한다", async () => {
  const gatedSamples = [];
  const decodedSamples = [];
  const fixture = monitorFixture({
    async fetchSegments(url) {
      const quality = url.slice("memory:".length);
      return [batchSegment(550, `${quality}-550`)];
    },
    async decodeGrayFrame() { return grayFrameBatch([1, 2, 6]); },
    gate(frame) {
      gatedSamples.push(frame[0]);
      return { uiCandidate: frame[0] === 1, reason: "test" };
    },
    async decodePngFrame(_segment, options) {
      decodedSamples.push(options.sampleIndex);
      return Buffer.concat([PNG_SIGNATURE, Buffer.from([options.sampleIndex])]);
    },
    async runOcr(png) {
      const sampleIndex = png.at(-1);
      return {
        version: 2,
        profileId: "stats-panel-v1",
        seasonId: CURRENT_SEASON_ID,
        panelVisible: sampleIndex >= 6,
        results: [],
      };
    },
    queuePath: "/tmp/test-observations.ndjson",
  });

  const normal = await fixture.monitor.executeTask({ lane: "normal", target: target() });
  const burst = await fixture.monitor.executeTask({ lane: "burst", target: target() });

  assert.equal(gatedSamples.length, 8);
  assert.deepEqual(normal.gate.candidateIndices, [1, 2, 6]);
  assert.deepEqual(normal.gate.candidateRuns, [
    { startIndex: 1, endIndex: 2 },
    { startIndex: 6, endIndex: 6 },
  ]);
  assert.deepEqual(decodedSamples, [1, 2, 3, 6, 7]);
  assert.equal(burst.ocr.panelVisible, true);
  assert.equal(burst.endBurst, undefined);
  assert.equal(burst.ocr.endBurst, false);
});

test("burst 후속 ORIGINAL segment도 8-sample gate로 뒤 sample의 두 번째 UI를 찾아 선택 OCR한다", async () => {
  const grayDecoded = [];
  const pngDecoded = [];
  const fixture = monitorFixture({
    async fetchSegments(url) {
      const quality = url.slice("memory:".length);
      if (quality === "SD") return [batchSegment(560, "SD-560")];
      return [batchSegment(560, "HD-560"), batchSegment(561, "HD-561")];
    },
    async decodeGrayFrame(segment) {
      const label = segment.toString();
      grayDecoded.push(label);
      return grayFrameBatch(label === "SD-560" ? [1] : [6]);
    },
    gate(frame) { return { uiCandidate: frame[0] === 1, reason: "test" }; },
    async decodePngFrame(segment, options) {
      const label = segment.toString();
      pngDecoded.push([label, options.sampleIndex]);
      return Buffer.concat([
        PNG_SIGNATURE,
        Buffer.from([label === "HD-561" ? 1 : 0, options.sampleIndex]),
      ]);
    },
    async runOcr(png) {
      const isFollowup = png.at(-2) === 1;
      const sampleIndex = png.at(-1);
      return {
        version: 2,
        profileId: "stats-panel-v1",
        seasonId: CURRENT_SEASON_ID,
        panelVisible: (!isFollowup && sampleIndex === 1) || (isFollowup && sampleIndex === 6),
        results: [],
      };
    },
    queuePath: "/tmp/test-observations.ndjson",
  });

  await fixture.monitor.executeTask({ lane: "normal", target: target() });
  const burst = await fixture.monitor.executeTask({ lane: "burst", target: target() });

  assert.deepEqual(grayDecoded, ["SD-560", "HD-561"]);
  assert.deepEqual(pngDecoded, [
    ["HD-560", 1],
    ["HD-560", 2],
    ["HD-561", 6],
    ["HD-561", 7],
  ]);
  assert.equal(burst.ocr.panelVisible, true);
  assert.equal(burst.ocr.endBurst, false);
  assert.equal(fixture.monitor.getSnapshot(BASE_TIME).stats.ocrRuns, 4);
});

test("후속 ORIGINAL segment의 8개 gate가 모두 숨김이면 PNG 없이 segment당 hidden 1회로 세어 두 번에 종료한다", async () => {
  const grayDecoded = [];
  const pngDecoded = [];
  const fixture = monitorFixture({
    async fetchSegments(url) {
      const quality = url.slice("memory:".length);
      if (quality === "SD") return [batchSegment(570, "SD-570")];
      return [
        batchSegment(570, "HD-570"),
        batchSegment(571, "HD-571-hidden"),
        batchSegment(572, "HD-572-hidden"),
      ];
    },
    async decodeGrayFrame(segment) {
      const label = segment.toString();
      grayDecoded.push(label);
      return grayFrameBatch(label === "SD-570" ? [1] : []);
    },
    gate(frame) { return { uiCandidate: frame[0] === 1, reason: "test" }; },
    async decodePngFrame(segment, options) {
      pngDecoded.push([segment.toString(), options.sampleIndex]);
      return Buffer.concat([PNG_SIGNATURE, Buffer.from([options.sampleIndex])]);
    },
    async runOcr() {
      return { version: 2, profileId: "stats-panel-v1", seasonId: CURRENT_SEASON_ID, panelVisible: true, results: [] };
    },
    queuePath: "/tmp/test-observations.ndjson",
  });

  await fixture.monitor.executeTask({ lane: "normal", target: target() });
  const burst = await fixture.monitor.executeTask({ lane: "burst", target: target() });

  assert.deepEqual(grayDecoded, ["SD-570", "HD-571-hidden", "HD-572-hidden"]);
  assert.deepEqual(pngDecoded, [["HD-570", 1], ["HD-570", 2]]);
  assert.equal(burst.endBurst, true);
  assert.equal(burst.ocr.consecutiveHiddenFrames, 2);
  assert.equal(burst.ocr.gateOnlyHiddenSegments, 2);
  assert.equal(burst.ocr.frames.length, 2);
  assert.ok(burst.ocr.frames.every(frame => frame.panelVisible === true));
  assert.equal(fixture.monitor.getSnapshot(BASE_TIME).stats.ocrRuns, 2);
});

test("URL cursor가 회전해도 이미 처리한 media sequence를 뒤로 재생하지 않는다", async () => {
  let fetchCall = 0;
  let decodeCalls = 0;
  const fixture = monitorFixture({
    async fetchSegments() {
      fetchCall += 1;
      if (fetchCall === 1) return [batchSegment(600, "current-600")];
      return Array.from({ length: 6 }, (_value, index) => ({
        ...batchSegment(595 + index, `stale-${595 + index}`),
        segmentId: (1_000 + 595 + index).toString(16).padStart(64, "0"),
      }));
    },
    async decodeGrayFrame() {
      decodeCalls += 1;
      return Buffer.alloc(FRAME_BYTES, 0);
    },
  });

  await fixture.monitor.scanGate(target());
  const rotated = await fixture.monitor.scanGate(target());
  assert.equal(rotated.duplicate, true);
  assert.equal(rotated.processedSegments, 0);
  assert.equal(decodeCalls, 1);
  assert.equal(fixture.monitor.getSnapshot(BASE_TIME).stats.staleSegmentsSkipped, 6);
});

test("broadNo 변경은 작은 media sequence rollback도 새 방송으로 즉시 reset한다", async () => {
  let resolveCall = 0;
  let fetchCall = 0;
  let decodeCalls = 0;
  const fetchOptions = [];
  const invalidations = [];
  const fixture = monitorFixture({
    hlsCache: {
      async get() {
        resolveCall += 1;
        return {
          broadNo: resolveCall === 1 ? "100001" : "100002",
          hlsUrl: "memory:stable-url",
        };
      },
      async invalidate(bjId, quality) { invalidations.push([bjId, quality]); },
    },
    async fetchSegments(_url, options) {
      fetchOptions.push(options);
      fetchCall += 1;
      return fetchCall === 1
        ? [batchSegment(5, "old-broadcast-5")]
        : [
          batchSegment(1, "new-broadcast-1"),
          batchSegment(2, "new-broadcast-2"),
          batchSegment(3, "new-broadcast-3"),
        ];
    },
    async decodeGrayFrame() {
      decodeCalls += 1;
      return Buffer.alloc(FRAME_BYTES, 0);
    },
  });

  await fixture.monitor.scanGate(target());
  const restarted = await fixture.monitor.scanGate(target());
  assert.equal(fetchOptions[0].afterSegmentId, undefined);
  assert.equal(fetchOptions[1].afterSegmentId, undefined);
  assert.equal(restarted.processedSegments, 3);
  assert.equal(decodeCalls, 4);
  assert.deepEqual(invalidations, [["sample_bj", undefined]]);
  const stats = fixture.monitor.getSnapshot(BASE_TIME).stats;
  assert.equal(stats.streamResets, 1);
  assert.equal(stats.staleSegmentsSkipped, 0);
});

test("Sheet baseline은 값이 실제 변경될 때만 tracker에 원자 재적용한다", () => {
  const fixture = monitorFixture({
    async decodePngFrame() { return Buffer.concat([PNG_SIGNATURE, Buffer.from([1])]); },
    async runOcr() {
      return { version: 2, profileId: "stats-panel-v1", seasonId: CURRENT_SEASON_ID, panelVisible: false, results: [] };
    },
    queuePath: "/tmp/test-observations.ndjson",
  });
  const same = fixture.monitor.refreshBaselines([]);
  const changed = fixture.monitor.refreshBaselines([
    { playerId: "P001", field: "strength", value: 10 },
  ], BASE_TIME + 1_000);
  const repeated = fixture.monitor.refreshBaselines([
    { playerId: "P001", field: "strength", value: 10 },
  ], BASE_TIME + 2_000);
  assert.deepEqual(same, { changed: false, count: 0 });
  assert.deepEqual(changed, { changed: true, count: 1, applied: 1, preserved: 0 });
  assert.deepEqual(repeated, { changed: false, count: 1 });
  const stats = fixture.monitor.getSnapshot(BASE_TIME + 2_000).stats;
  assert.equal(stats.baselineRefreshes, 1);
  assert.equal(stats.lastBaselineRefreshAt, BASE_TIME + 1_000);
});
