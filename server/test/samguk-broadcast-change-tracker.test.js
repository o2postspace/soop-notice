"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  DEFAULT_CONFIRMATION_WINDOW_MS,
  MAX_TRACKED_KEYS,
  SamgukBroadcastChangeTrackerError,
  createBroadcastChangeTracker,
} = require("../lib/samguk-broadcast-change-tracker");
const { BATCH_FIELDS } = require("../lib/samguk-broadcast-batch");

const BASE_TIME = Date.parse("2026-08-02T10:00:00.000Z");

function observation(overrides = {}) {
  const { observedAtMs = BASE_TIME, ...fields } = overrides;
  const sourceId = fields.sourceId || `screen:frame-${observedAtMs}`;
  return {
    playerId: "P001",
    field: "strength",
    value: 11,
    sourceType: "broadcast",
    sourceId,
    sourceUrl: "https://play.sooplive.com/cnsgkcnehd74",
    observedAt: new Date(observedAtMs).toISOString(),
    collectedAt: new Date(observedAtMs).toISOString(),
    evidenceHash: fields.evidenceHash || "a".repeat(64),
    ocrConfidence: 0.98,
    ...fields,
  };
}

function observationBatch({
  sourceId,
  evidenceHash,
  observedAtMs = BASE_TIME,
  playerId = "P001",
  values,
}) {
  return Object.entries(values).map(([field, value]) => observation({
    playerId,
    field,
    value,
    sourceId,
    evidenceHash,
    observedAtMs,
  }));
}

function rejectsWith(code, operation) {
  assert.throws(
    operation,
    error => error instanceof SamgukBroadcastChangeTrackerError && error.code === code,
  );
}

test("baseline stable 값을 초기화하고 같은 값은 후보 없이 억제한다", () => {
  const tracker = createBroadcastChangeTracker({
    baselines: [{ playerId: "P001", field: "strength", value: "10" }],
    now: BASE_TIME,
  });
  assert.equal(tracker.windowMs, DEFAULT_CONFIRMATION_WINDOW_MS);
  assert.equal(tracker.size, 1);
  assert.equal(tracker.getState("P001", "strength").stableValue, 10);
  assert.deepEqual(tracker.observe(observation({ value: 10 }), { now: BASE_TIME }), []);
  assert.equal(tracker.getState("P001", "strength").candidate, null);
});

test("같은 새 값을 서로 다른 sourceId와 evidenceHash 두 frame이 확인하면 한 번만 emit한다", () => {
  const tracker = createBroadcastChangeTracker({
    baselines: [{ playerId: "P001", field: "strength", value: 10 }],
    now: BASE_TIME,
  });
  const first = observation({ sourceId: "screen:frame-1", evidenceHash: "1".repeat(64) });
  const second = observation({
    sourceId: "screen:frame-2",
    evidenceHash: "2".repeat(64),
    observedAtMs: BASE_TIME + 5_000,
  });
  assert.deepEqual(tracker.observe(first, { now: BASE_TIME }), []);
  const emitted = tracker.observe(second, { now: BASE_TIME + 5_000 });
  assert.equal(emitted.length, 2);
  assert.deepEqual(emitted.map(item => item.sourceId), ["screen:frame-1", "screen:frame-2"]);
  assert.equal(tracker.getState("P001", "strength").stableValue, 11);

  const third = observation({
    sourceId: "screen:frame-3",
    evidenceHash: "3".repeat(64),
    observedAtMs: BASE_TIME + 10_000,
  });
  assert.deepEqual(tracker.observe(third, { now: BASE_TIME + 10_000 }), []);
  assert.equal(tracker.getState("P001", "strength").candidate, null);
});

test("onConfirmed 성공 뒤에만 stable 값을 commit한다", () => {
  const tracker = createBroadcastChangeTracker({
    baselines: [{ playerId: "P001", field: "strength", value: 10 }],
    now: BASE_TIME,
  });
  tracker.observe(observation({
    sourceId: "screen:frame-1",
    evidenceHash: "1".repeat(64),
  }), { now: BASE_TIME });

  let callbackEmitted;
  const emitted = tracker.observe(observation({
    sourceId: "screen:frame-2",
    evidenceHash: "2".repeat(64),
    observedAtMs: BASE_TIME + 1_000,
  }), {
    now: BASE_TIME + 1_000,
    onConfirmed(items) {
      callbackEmitted = items;
      assert.equal(tracker.getState("P001", "strength").stableValue, 10);
      assert.equal(tracker.getState("P001", "strength").candidate.sourceId, "screen:frame-1");
    },
  });
  assert.strictEqual(callbackEmitted, emitted);
  assert.equal(tracker.getState("P001", "strength").stableValue, 11);
  assert.equal(tracker.getState("P001", "strength").candidate, null);
});

test("onConfirmed 실패 시 두 번째 frame을 보존하고 다음 distinct frame으로 재시도한다", () => {
  const tracker = createBroadcastChangeTracker({
    baselines: [{ playerId: "P001", field: "strength", value: 10 }],
    now: BASE_TIME,
  });
  tracker.observe(observation({
    sourceId: "screen:frame-1",
    evidenceHash: "1".repeat(64),
  }), { now: BASE_TIME });

  const appendError = new Error("queue append failed");
  assert.throws(() => tracker.observe(observation({
    sourceId: "screen:frame-2",
    evidenceHash: "2".repeat(64),
    observedAtMs: BASE_TIME + 1_000,
  }), {
    now: BASE_TIME + 1_000,
    onConfirmed() { throw appendError; },
  }), error => error === appendError);
  assert.equal(tracker.getState("P001", "strength").stableValue, 10);
  assert.equal(tracker.getState("P001", "strength").candidate.sourceId, "screen:frame-2");

  let retried;
  const emitted = tracker.observe(observation({
    sourceId: "screen:frame-3",
    evidenceHash: "3".repeat(64),
    observedAtMs: BASE_TIME + 2_000,
  }), {
    now: BASE_TIME + 2_000,
    onConfirmed(items) { retried = items; },
  });
  assert.deepEqual(emitted.map(item => item.sourceId), ["screen:frame-2", "screen:frame-3"]);
  assert.strictEqual(retried, emitted);
  assert.equal(tracker.getState("P001", "strength").stableValue, 11);
  assert.equal(tracker.getState("P001", "strength").candidate, null);
});

test("비동기 onConfirmed는 commit하지 않고 재시도 후보를 보존한다", () => {
  const tracker = createBroadcastChangeTracker({
    baselines: [{ playerId: "P001", field: "strength", value: 10 }],
    now: BASE_TIME,
  });
  tracker.observe(observation({
    sourceId: "screen:frame-1",
    evidenceHash: "1".repeat(64),
  }), { now: BASE_TIME });

  rejectsWith("invalid_callback", () => tracker.observe(observation({
    sourceId: "screen:frame-2",
    evidenceHash: "2".repeat(64),
    observedAtMs: BASE_TIME + 1_000,
  }), {
    now: BASE_TIME + 1_000,
    onConfirmed: async () => {},
  }));
  assert.equal(tracker.getState("P001", "strength").stableValue, 10);
  assert.equal(tracker.getState("P001", "strength").candidate.sourceId, "screen:frame-2");
});

test("observeBatch는 여러 field pair를 한 callback으로 저장한 뒤 원자적으로 commit한다", () => {
  const tracker = createBroadcastChangeTracker({
    baselines: [
      { playerId: "P001", field: "strength", value: 10 },
      { playerId: "P001", field: "agility", value: 20 },
    ],
    now: BASE_TIME,
  });
  const first = observationBatch({
    sourceId: "screen:batch-1",
    evidenceHash: "1".repeat(64),
    values: { strength: 11, agility: 21 },
  });
  let callbackCalls = 0;
  assert.deepEqual(tracker.observeBatch(first, {
    now: BASE_TIME,
    onConfirmed() { callbackCalls += 1; },
  }), []);
  assert.equal(callbackCalls, 0);

  const second = observationBatch({
    sourceId: "screen:batch-2",
    evidenceHash: "2".repeat(64),
    observedAtMs: BASE_TIME + 1_000,
    values: { strength: 11, agility: 21 },
  });
  let callbackFlat;
  const emitted = tracker.observeBatch(second, {
    now: BASE_TIME + 1_000,
    onConfirmed(flat) {
      callbackCalls += 1;
      callbackFlat = flat;
      assert.equal(tracker.getState("P001", "strength").stableValue, 10);
      assert.equal(tracker.getState("P001", "agility").stableValue, 20);
      assert.equal(tracker.getState("P001", "strength").candidate.sourceId, "screen:batch-1");
    },
  });
  assert.equal(callbackCalls, 1);
  assert.strictEqual(callbackFlat, emitted);
  assert.deepEqual(emitted.map(item => item.field), [
    "strength", "strength", "agility", "agility",
  ]);
  assert.deepEqual(emitted.map(item => item.sourceId), [
    "screen:batch-1", "screen:batch-2", "screen:batch-1", "screen:batch-2",
  ]);
  assert.equal(tracker.getState("P001", "strength").stableValue, 11);
  assert.equal(tracker.getState("P001", "agility").stableValue, 21);
  assert.equal(tracker.getState("P001", "strength").candidate, null);
  assert.equal(tracker.getState("P001", "agility").candidate, null);
});

test("observeBatch callback 실패는 모든 commit을 막고 확인·미확인 field 후보를 일관되게 보존한다", () => {
  const tracker = createBroadcastChangeTracker({
    baselines: [
      { playerId: "P001", field: "strength", value: 10 },
      { playerId: "P001", field: "agility", value: 20 },
      { playerId: "P001", field: "vitality", value: 30 },
    ],
    now: BASE_TIME,
  });
  tracker.observeBatch(observationBatch({
    sourceId: "screen:batch-1",
    evidenceHash: "1".repeat(64),
    values: { strength: 11, agility: 21 },
  }), { now: BASE_TIME });

  const appendError = new Error("batch append failed");
  let callbackCalls = 0;
  assert.throws(() => tracker.observeBatch(observationBatch({
    sourceId: "screen:batch-2",
    evidenceHash: "2".repeat(64),
    observedAtMs: BASE_TIME + 1_000,
    values: { strength: 11, agility: 21, vitality: 31 },
  }), {
    now: BASE_TIME + 1_000,
    onConfirmed() {
      callbackCalls += 1;
      throw appendError;
    },
  }), error => error === appendError);
  assert.equal(callbackCalls, 1);
  assert.equal(tracker.getState("P001", "strength").stableValue, 10);
  assert.equal(tracker.getState("P001", "agility").stableValue, 20);
  assert.equal(tracker.getState("P001", "vitality").stableValue, 30);
  for (const field of ["strength", "agility", "vitality"]) {
    assert.equal(tracker.getState("P001", field).candidate.sourceId, "screen:batch-2");
  }

  let retried;
  const emitted = tracker.observeBatch(observationBatch({
    sourceId: "screen:batch-3",
    evidenceHash: "3".repeat(64),
    observedAtMs: BASE_TIME + 2_000,
    values: { strength: 11, agility: 21, vitality: 32 },
  }), {
    now: BASE_TIME + 2_000,
    onConfirmed(flat) { retried = flat; },
  });
  assert.strictEqual(retried, emitted);
  assert.deepEqual(emitted.map(item => item.sourceId), [
    "screen:batch-2", "screen:batch-3", "screen:batch-2", "screen:batch-3",
  ]);
  assert.equal(tracker.getState("P001", "strength").stableValue, 11);
  assert.equal(tracker.getState("P001", "agility").stableValue, 21);
  assert.equal(tracker.getState("P001", "vitality").stableValue, 30);
  assert.equal(tracker.getState("P001", "vitality").candidate.value, 32);
});

test("observeBatch는 thenable callback에서도 어느 stable도 commit하지 않는다", () => {
  const tracker = createBroadcastChangeTracker({
    baselines: [
      { playerId: "P001", field: "strength", value: 10 },
      { playerId: "P001", field: "agility", value: 20 },
    ],
    now: BASE_TIME,
  });
  tracker.observeBatch(observationBatch({
    sourceId: "screen:batch-1",
    evidenceHash: "1".repeat(64),
    values: { strength: 11, agility: 21 },
  }), { now: BASE_TIME });

  rejectsWith("invalid_callback", () => tracker.observeBatch(observationBatch({
    sourceId: "screen:batch-2",
    evidenceHash: "2".repeat(64),
    observedAtMs: BASE_TIME + 1_000,
    values: { strength: 11, agility: 21 },
  }), {
    now: BASE_TIME + 1_000,
    onConfirmed: async () => {},
  }));
  for (const [field, stableValue] of [["strength", 10], ["agility", 20]]) {
    assert.equal(tracker.getState("P001", field).stableValue, stableValue);
    assert.equal(tracker.getState("P001", field).candidate.sourceId, "screen:batch-2");
  }
});

test("observeBatch는 중복 key와 섞인 frame 근거를 상태 변경 없이 거부한다", () => {
  const tracker = createBroadcastChangeTracker({
    baselines: [{ playerId: "P001", field: "strength", value: 10 }],
    now: BASE_TIME,
  });
  tracker.observeBatch(observationBatch({
    sourceId: "screen:original",
    evidenceHash: "1".repeat(64),
    values: { strength: 11 },
  }), { now: BASE_TIME });
  const original = tracker.getState("P001", "strength");

  const duplicate = observation({
    field: "strength",
    value: 12,
    sourceId: "screen:duplicate",
    evidenceHash: "2".repeat(64),
    observedAtMs: BASE_TIME + 1_000,
  });
  rejectsWith("duplicate_batch_key", () => tracker.observeBatch(
    [duplicate, { ...duplicate, value: 13 }],
    { now: BASE_TIME + 1_000 },
  ));
  rejectsWith("mixed_frame", () => tracker.observeBatch([
    observation({
      field: "strength",
      value: 12,
      sourceId: "screen:mixed-a",
      evidenceHash: "3".repeat(64),
      observedAtMs: BASE_TIME + 1_000,
    }),
    observation({
      field: "agility",
      value: 22,
      sourceId: "screen:mixed-b",
      evidenceHash: "3".repeat(64),
      observedAtMs: BASE_TIME + 1_000,
    }),
  ], { now: BASE_TIME + 1_000 }));
  rejectsWith("mixed_frame", () => tracker.observeBatch([
    observation({
      field: "strength",
      value: 12,
      sourceId: "screen:mixed",
      evidenceHash: "4".repeat(64),
      observedAtMs: BASE_TIME + 1_000,
    }),
    observation({
      field: "agility",
      value: 22,
      sourceId: "screen:mixed",
      evidenceHash: "5".repeat(64),
      observedAtMs: BASE_TIME + 1_000,
    }),
  ], { now: BASE_TIME + 1_000 }));
  assert.deepEqual(tracker.getState("P001", "strength"), original);
  assert.equal(tracker.getState("P001", "agility"), null);
});

test("observeBatch는 전체 OCR field 수와 key capacity를 batch 전체에 선적용한다", () => {
  const tracker = createBroadcastChangeTracker({
    maxKeys: 2,
    baselines: [{ playerId: "P001", field: "strength", value: 10 }],
    now: BASE_TIME,
  });
  rejectsWith("capacity_exceeded", () => tracker.observeBatch(observationBatch({
    sourceId: "screen:capacity",
    evidenceHash: "1".repeat(64),
    values: { agility: 1, vitality: 1 },
  }), { now: BASE_TIME }));
  assert.equal(tracker.size, 1);
  assert.equal(tracker.getState("P001", "agility"), null);

  let emptyCallbackCalls = 0;
  assert.deepEqual(tracker.observeBatch([], {
    now: BASE_TIME,
    onConfirmed() { emptyCallbackCalls += 1; },
  }), []);
  assert.equal(emptyCallbackCalls, 0);
  const maximumBatch = BATCH_FIELDS.map(field => observation({
    field,
    value: field === "horse" ? "백룡마" : field === "activeGeneral" ? "조조" : 1,
    sourceId: "screen:too-many",
    evidenceHash: "2".repeat(64),
  }));
  const maximumTracker = createBroadcastChangeTracker();
  assert.deepEqual(maximumTracker.observeBatch(maximumBatch, { now: BASE_TIME }), []);
  assert.equal(maximumTracker.size, BATCH_FIELDS.length);
  maximumBatch.push(observation({
    playerId: "P002",
    field: "level",
    value: 1,
    sourceId: "screen:too-many",
    evidenceHash: "2".repeat(64),
  }));
  rejectsWith("invalid_batch", () => maximumTracker.observeBatch(maximumBatch, { now: BASE_TIME }));
});

test("sourceId 또는 evidenceHash가 같은 frame은 두 번째 근거로 세지 않는다", () => {
  const sameSource = createBroadcastChangeTracker();
  assert.deepEqual(sameSource.observe(observation({
    sourceId: "screen:shared",
    evidenceHash: "1".repeat(64),
  }), { now: BASE_TIME }), []);
  assert.deepEqual(sameSource.observe(observation({
    sourceId: "screen:shared",
    evidenceHash: "2".repeat(64),
    observedAtMs: BASE_TIME + 1_000,
  }), { now: BASE_TIME + 1_000 }), []);

  const sameEvidence = createBroadcastChangeTracker();
  assert.deepEqual(sameEvidence.observe(observation({
    sourceId: "screen:frame-1",
    evidenceHash: "f".repeat(64),
  }), { now: BASE_TIME }), []);
  assert.deepEqual(sameEvidence.observe(observation({
    sourceId: "screen:frame-2",
    evidenceHash: "f".repeat(64),
    observedAtMs: BASE_TIME + 1_000,
  }), { now: BASE_TIME + 1_000 }), []);
});

test("같은 HLS media segment의 인접 frame은 확인 근거 하나로만 센다", () => {
  const tracker = createBroadcastChangeTracker({
    baselines: [{ playerId: "P001", field: "strength", value: 10 }],
    now: BASE_TIME,
  });
  const first = observation({
    sourceId: "screen:P001:1770000000000:1111111111111111:4",
    evidenceHash: "1".repeat(64),
  });
  const sameSegment = observation({
    sourceId: "screen:P001:1770000003000:1111111111111111:5",
    evidenceHash: "2".repeat(64),
    observedAtMs: BASE_TIME + 3_000,
  });
  const nextSegment = observation({
    sourceId: "screen:P001:1770000006000:2222222222222222:0",
    evidenceHash: "3".repeat(64),
    observedAtMs: BASE_TIME + 6_000,
  });

  assert.deepEqual(tracker.observe(first, { now: BASE_TIME }), []);
  assert.deepEqual(tracker.observe(sameSegment, { now: BASE_TIME + 3_000 }), []);
  assert.equal(tracker.getState("P001", "strength").candidate.sourceId, first.sourceId);
  assert.deepEqual(
    tracker.observe(nextSegment, { now: BASE_TIME + 6_000 }).map(item => item.sourceId),
    [first.sourceId, nextSegment.sourceId],
  );
});

test("값이 바뀌면 후보를 교체하고 새 후보 값 두 frame만 emit한다", () => {
  const tracker = createBroadcastChangeTracker({
    baselines: [{ playerId: "P001", field: "strength", value: 10 }],
    now: BASE_TIME,
  });
  tracker.observe(observation({
    value: 11,
    sourceId: "screen:value-11",
    evidenceHash: "1".repeat(64),
  }), { now: BASE_TIME });
  tracker.observe(observation({
    value: 12,
    sourceId: "screen:value-12-a",
    evidenceHash: "2".repeat(64),
    observedAtMs: BASE_TIME + 1_000,
  }), { now: BASE_TIME + 1_000 });
  const emitted = tracker.observe(observation({
    value: 12,
    sourceId: "screen:value-12-b",
    evidenceHash: "3".repeat(64),
    observedAtMs: BASE_TIME + 2_000,
  }), { now: BASE_TIME + 2_000 });
  assert.deepEqual(emitted.map(item => item.value), [12, 12]);
  assert.equal(tracker.getState("P001", "strength").stableValue, 12);
});

test("window 밖의 같은 값은 최신 frame으로 후보를 교체한다", () => {
  const tracker = createBroadcastChangeTracker({ windowMs: 120_000, ttlMs: 180_000 });
  tracker.observe(observation({
    sourceId: "screen:old",
    evidenceHash: "1".repeat(64),
  }), { now: BASE_TIME });
  assert.deepEqual(tracker.observe(observation({
    sourceId: "screen:new-first",
    evidenceHash: "2".repeat(64),
    observedAtMs: BASE_TIME + 121_000,
  }), { now: BASE_TIME + 121_000 }), []);
  const emitted = tracker.observe(observation({
    sourceId: "screen:new-second",
    evidenceHash: "3".repeat(64),
    observedAtMs: BASE_TIME + 122_000,
  }), { now: BASE_TIME + 122_000 });
  assert.deepEqual(emitted.map(item => item.sourceId), ["screen:new-first", "screen:new-second"]);
});

test("입력을 엄격히 검증하고 저신뢰·비방송·powerScore를 거부한다", () => {
  const tracker = createBroadcastChangeTracker();
  rejectsWith("low_confidence", () => tracker.observe(observation({ ocrConfidence: 0.94 }), { now: BASE_TIME }));
  rejectsWith("invalid_observation", () => tracker.observe(observation({
    sourceType: "fmkorea",
    sourceUrl: "https://www.fmkorea.com/1",
  }), { now: BASE_TIME }));
  rejectsWith("invalid_observation", () => tracker.observe(observation({ field: "powerScore" }), { now: BASE_TIME }));
  rejectsWith("invalid_observation", () => tracker.observe({ ...observation(), extra: true }, { now: BASE_TIME }));
});

test("TTL cleanup은 만료 후보와 stable 없는 key만 제거한다", () => {
  const tracker = createBroadcastChangeTracker({
    maxKeys: 2,
    windowMs: 1_000,
    ttlMs: 2_000,
    baselines: [{ playerId: "P001", field: "level", value: 1 }],
    now: BASE_TIME,
  });
  tracker.observe(observation(), { now: BASE_TIME });
  assert.equal(tracker.size, 2);
  assert.deepEqual(tracker.cleanup(BASE_TIME + 1_999), { removedCandidates: 0, removedKeys: 0 });
  assert.deepEqual(tracker.cleanup(BASE_TIME + 2_000), { removedCandidates: 1, removedKeys: 1 });
  assert.equal(tracker.size, 1);
  assert.equal(tracker.getState("P001", "level").stableValue, 1);
});

test("최대 key 상한은 90*전체 OCR field 수이고 초과 시 기존 상태를 보존한다", () => {
  assert.equal(MAX_TRACKED_KEYS, 90 * BATCH_FIELDS.length);
  const tracker = createBroadcastChangeTracker({ maxKeys: 2 });
  tracker.setStable({ playerId: "P001", field: "level", value: 1 }, { now: BASE_TIME });
  tracker.setStable({ playerId: "P001", field: "strength", value: 10 }, { now: BASE_TIME });
  rejectsWith("capacity_exceeded", () => tracker.setStable({
    playerId: "P002",
    field: "level",
    value: 1,
  }, { now: BASE_TIME }));
  assert.equal(tracker.size, 2);

  rejectsWith("invalid_config", () => createBroadcastChangeTracker({ maxKeys: MAX_TRACKED_KEYS + 1 }));
});

test("baseline 재초기화는 중복 key를 거부하고 기존 상태를 원자적으로 보존한다", () => {
  const tracker = createBroadcastChangeTracker({
    baselines: [{ playerId: "P001", field: "level", value: 1 }],
    now: BASE_TIME,
  });
  rejectsWith("duplicate_baseline", () => tracker.initializeStable([
    { playerId: "P002", field: "level", value: 2 },
    { playerId: "P002", field: "level", value: 3 },
  ], { now: BASE_TIME }));
  assert.equal(tracker.size, 1);
  assert.equal(tracker.getState("P001", "level").stableValue, 1);
});

test("baseline reconcile은 변경 없는 key의 pending 후보를 보존한다", () => {
  const tracker = createBroadcastChangeTracker({
    baselines: [
      { playerId: "P001", field: "strength", value: 10 },
      { playerId: "P001", field: "level", value: 1 },
    ],
    now: BASE_TIME,
  });
  tracker.observe(observation({
    sourceId: "screen:frame-before-refresh",
    evidenceHash: "1".repeat(64),
  }), { now: BASE_TIME });

  const reconciled = tracker.reconcileStable([
    { playerId: "P001", field: "strength", value: 10 },
    { playerId: "P001", field: "level", value: 2 },
  ], { now: BASE_TIME + 1_000 });
  assert.deepEqual(reconciled, {
    size: 2,
    added: 0,
    updated: 1,
    removed: 0,
    unchanged: 1,
    preservedCandidates: 1,
  });
  assert.equal(
    tracker.getState("P001", "strength").candidate.sourceId,
    "screen:frame-before-refresh",
  );

  const emitted = tracker.observe(observation({
    sourceId: "screen:frame-after-refresh",
    evidenceHash: "2".repeat(64),
    observedAtMs: BASE_TIME + 2_000,
  }), { now: BASE_TIME + 2_000 });
  assert.equal(emitted.length, 2);
  assert.equal(tracker.getState("P001", "strength").stableValue, 11);
});

test("baseline reconcile은 stable이 바뀐 key만 pending을 지우고 실패 시 원자 보존한다", () => {
  const tracker = createBroadcastChangeTracker({
    baselines: [{ playerId: "P001", field: "strength", value: 10 }],
    now: BASE_TIME,
  });
  tracker.observe(observation({
    value: 12,
    sourceId: "screen:pending",
    evidenceHash: "3".repeat(64),
  }), { now: BASE_TIME });

  rejectsWith("duplicate_baseline", () => tracker.reconcileStable([
    { playerId: "P001", field: "strength", value: 11 },
    { playerId: "P001", field: "strength", value: 12 },
  ], { now: BASE_TIME + 1_000 }));
  assert.equal(tracker.getState("P001", "strength").stableValue, 10);
  assert.equal(tracker.getState("P001", "strength").candidate.sourceId, "screen:pending");

  tracker.reconcileStable([
    { playerId: "P001", field: "strength", value: 11 },
  ], { now: BASE_TIME + 1_000 });
  assert.equal(tracker.getState("P001", "strength").stableValue, 11);
  assert.equal(tracker.getState("P001", "strength").candidate, null);
  assert.deepEqual(tracker.observe(observation({
    value: 12,
    sourceId: "screen:after-change",
    evidenceHash: "4".repeat(64),
    observedAtMs: BASE_TIME + 2_000,
  }), { now: BASE_TIME + 2_000 }), []);
});
