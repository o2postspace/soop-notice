const test = require("node:test");
const assert = require("node:assert/strict");
const {
  MAX_TARGETS,
  SamgukStreamSchedulerError,
  createSamgukStreamScheduler,
} = require("../lib/samguk-stream-scheduler");

function targets(count, prefix = "target") {
  return Array.from({ length: count }, (_value, index) => ({ id: `${prefix}-${index + 1}` }));
}

function scheduler(overrides = {}) {
  return createSamgukStreamScheduler({
    targets: targets(1),
    now: 0,
    initialSpreadMs: 0,
    jitterRatio: 0,
    idleIntervalMs: 60_000,
    liveIntervalMs: 15_000,
    burstIntervalMs: 2_000,
    burstDurationMs: 30_000,
    normalConcurrency: 4,
    burstConcurrency: 2,
    backoffBaseMs: 10_000,
    backoffMaxMs: 40_000,
    taskLeaseMs: 5_000,
    ...overrides,
  });
}

test("최대 90개 target과 고유 ID만 허용한다", () => {
  const instance = scheduler({ targets: targets(MAX_TARGETS) });
  assert.equal(instance.getSnapshot(0).targets.length, 90);
  assert.throws(
    () => scheduler({ targets: targets(MAX_TARGETS + 1) }),
    error => error instanceof SamgukStreamSchedulerError && error.code === "invalid_targets",
  );
  assert.throws(
    () => scheduler({ targets: [{ id: "same" }, { id: "same" }] }),
    error => error.code === "duplicate_target",
  );
});

test("unknown/offline target은 저빈도 probe만 예약한다", () => {
  const instance = scheduler();
  const [probe] = instance.selectDue(0);
  assert.equal(probe.kind, "live-probe");
  assert.equal(probe.lane, "normal");

  const state = instance.applyResult(probe.taskId, { live: false }, 1);
  assert.equal(state.status, "offline");
  assert.equal(state.nextDueAt, 60_001);
  assert.deepEqual(instance.selectDue(60_000), []);
  assert.equal(instance.selectDue(60_001)[0].kind, "live-probe");
});

test("LIVE target은 normal live scan 주기로 전환한다", () => {
  const instance = scheduler();
  const [probe] = instance.selectDue(0);
  const state = instance.applyResult(probe.taskId, { live: true, uiCandidate: false }, 1);
  assert.equal(state.status, "live");
  assert.equal(state.mode, "live");
  assert.equal(state.nextDueAt, 15_000);
  assert.deepEqual(instance.selectDue(14_999), []);
  const [scan] = instance.selectDue(15_000);
  assert.equal(scan.kind, "live-scan");
  assert.equal(scan.lane, "normal");
});

test("normal scan의 UI candidate만 고정 시간 burst를 시작하고 재감지는 연장하지 않는다", () => {
  const instance = scheduler();
  const [probe] = instance.selectDue(0);
  let state = instance.applyResult(probe.taskId, { live: true, uiCandidate: true }, 1);
  assert.equal(state.mode, "burst");
  assert.equal(state.burstStartedAt, 1);
  assert.equal(state.burstUntil, 30_001);
  assert.equal(state.nextDueAt, 2_000);

  const [burst] = instance.selectDue(2_000);
  assert.equal(burst.kind, "burst-scan");
  assert.equal(burst.lane, "burst");
  state = instance.applyResult(burst.taskId, { live: true, uiCandidate: true }, 2_002);
  assert.equal(state.burstUntil, 30_001);
  assert.equal(state.nextDueAt, 4_000);

  const snapshot = instance.getSnapshot(30_001);
  assert.equal(snapshot.targets[0].mode, "live");
  assert.equal(snapshot.targets[0].burstUntil, null);
});

test("burst 중 endBurst 결과는 남은 고정 시간을 기다리지 않고 normal scan으로 복귀한다", () => {
  const instance = scheduler();
  const [probe] = instance.selectDue(0);
  instance.applyResult(probe.taskId, { live: true, uiCandidate: true }, 1);
  const [burst] = instance.selectDue(2_000);
  const state = instance.applyResult(burst.taskId, {
    live: true,
    uiCandidate: false,
    endBurst: true,
  }, 2_002);
  assert.equal(state.mode, "live");
  assert.equal(state.burstStartedAt, null);
  assert.equal(state.burstUntil, null);
  assert.equal(state.nextDueAt, 17_000);
});

test("normal과 burst lane의 global concurrency cap을 각각 지킨다", () => {
  const normal = scheduler({ targets: targets(10), normalConcurrency: 3 });
  assert.equal(normal.selectDue(0).length, 3);
  assert.equal(normal.selectDue(0).length, 0);

  const burst = scheduler({ targets: targets(6), normalConcurrency: 6, burstConcurrency: 2 });
  const probes = burst.selectDue(0);
  assert.equal(probes.length, 6);
  for (const task of probes) burst.applyResult(task.taskId, { live: true, uiCandidate: true }, 1);
  const burstTasks = burst.selectDue(2_001);
  assert.equal(burstTasks.length, 2);
  assert.ok(burstTasks.every(task => task.lane === "burst"));
  assert.equal(burst.getSnapshot(2_001).counts.burstInFlight, 2);
});

test("dueAt과 ID 순으로 공정하게 task를 선택한다", () => {
  const instance = scheduler({
    targets: [{ id: "c" }, { id: "a" }, { id: "b" }],
    normalConcurrency: 1,
  });
  const first = instance.selectDue(0)[0];
  assert.equal(first.targetId, "a");
  instance.applyResult(first.taskId, { live: false }, 1);
  const second = instance.selectDue(1)[0];
  assert.equal(second.targetId, "b");
  instance.applyResult(second.taskId, { live: false }, 2);
  assert.equal(instance.selectDue(2)[0].targetId, "c");
});

test("jitter를 interval에 대칭 적용한다", () => {
  const instance = scheduler({ jitterRatio: 0.2, random: () => 0.75 });
  const [probe] = instance.selectDue(0);
  const state = instance.applyResult(probe.taskId, { live: false }, 0);
  // 0.75는 [-0.2,+0.2] 구간의 +0.1 배율이다.
  assert.equal(state.nextDueAt, 66_000);
});

test("실패는 지수 backoff하고 성공 시 실패 횟수를 초기화한다", () => {
  const instance = scheduler();
  let [task] = instance.selectDue(0);
  let state = instance.applyResult(task.taskId, { ok: false, errorCode: "capture_failed" }, 1);
  assert.equal(state.consecutiveFailures, 1);
  assert.equal(state.nextDueAt, 10_001);

  [task] = instance.selectDue(10_001);
  state = instance.applyResult(task.taskId, { ok: false }, 10_002);
  assert.equal(state.consecutiveFailures, 2);
  assert.equal(state.nextDueAt, 30_002);

  [task] = instance.selectDue(30_002);
  state = instance.applyResult(task.taskId, { live: true }, 30_003);
  assert.equal(state.consecutiveFailures, 0);
  assert.equal(state.lastErrorCode, null);
  assert.equal(state.nextDueAt, 45_002);
});

test("LIVE scan 실행 시간은 주기에 누적하지 않고 밀린 target은 즉시 catch-up한다", () => {
  const instance = scheduler({ taskLeaseMs: 60_000 });
  let [task] = instance.selectDue(0);
  let state = instance.applyResult(task.taskId, { live: true }, 4_000);
  assert.equal(state.nextDueAt, 15_000);

  [task] = instance.selectDue(15_000);
  state = instance.applyResult(task.taskId, { live: true }, 35_000);
  assert.equal(state.nextDueAt, 35_000);
  assert.equal(instance.selectDue(35_000).length, 1);
});

test("만료된 task lease를 회수하고 concurrency를 영구 점유하지 않는다", () => {
  const instance = scheduler({ targets: targets(2), normalConcurrency: 1 });
  const task = instance.selectDue(0)[0];
  assert.equal(instance.selectDue(4_999).length, 0);
  assert.equal(instance.expireLeases(5_000), 1);
  assert.equal(instance.getTargetState(task.targetId, 5_000).lastErrorCode, "task_timeout");
  assert.equal(instance.selectDue(5_000).length, 1);
  assert.throws(
    () => instance.applyResult(task.taskId, { live: false }, 5_000),
    error => error.code === "unknown_task",
  );
});

test("실제 작업 promise를 소유한 loop는 lease 자동 회수를 끌 수 있다", () => {
  const instance = scheduler({ targets: targets(2), normalConcurrency: 1 });
  const task = instance.selectDue(0)[0];
  assert.deepEqual(instance.selectDue(5_000, { expireLeases: false }), []);
  assert.equal(instance.getTargetState(task.targetId, 5_000).inFlightTaskId, task.taskId);
  assert.throws(
    () => instance.selectDue(5_000, { expireLeases: "no" }),
    error => error.code === "invalid_config",
  );
});

test("소유 loop가 취소한 task는 실패로 기록하지 않고 in-flight만 해제한다", () => {
  const instance = scheduler();
  const [task] = instance.selectDue(0);
  const state = instance.cancelTask(task.taskId, 1);
  assert.equal(state.inFlightTaskId, null);
  assert.equal(state.consecutiveFailures, 0);
  assert.equal(state.lastErrorCode, null);
  assert.equal(instance.getSnapshot(1).counts.normalInFlight, 0);
});

test("비활성 target은 선택하지 않고 재활성화하면 즉시 probe한다", () => {
  const instance = scheduler({ targets: [{ id: "off", enabled: false }, { id: "on" }] });
  assert.equal(instance.selectDue(0)[0].targetId, "on");
  const state = instance.setTargetEnabled("off", true, 1);
  assert.equal(state.status, "unknown");
  assert.equal(state.nextDueAt, 1);
  assert.equal(instance.selectDue(1)[0].targetId, "off");
});

test("성공 결과의 live와 uiCandidate 타입을 엄격히 검사한다", () => {
  const instance = scheduler();
  const [task] = instance.selectDue(0);
  assert.throws(
    () => instance.applyResult(task.taskId, { uiCandidate: true }, 1),
    error => error.code === "invalid_result",
  );
  assert.equal(instance.getSnapshot(1).counts.normalInFlight, 1);
  assert.throws(
    () => instance.applyResult(task.taskId, { live: true, endBurst: "yes" }, 1),
    error => error.code === "invalid_result",
  );
});
