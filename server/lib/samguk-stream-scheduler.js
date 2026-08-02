"use strict";

const MAX_TARGETS = 90;
const TARGET_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

const DEFAULTS = Object.freeze({
  idleIntervalMs: 60_000,
  liveIntervalMs: 15_000,
  burstIntervalMs: 2_000,
  burstDurationMs: 30_000,
  normalConcurrency: 4,
  burstConcurrency: 2,
  jitterRatio: 0.15,
  backoffBaseMs: 30_000,
  backoffMaxMs: 15 * 60_000,
  taskLeaseMs: 30_000,
  initialSpreadMs: 60_000,
});

class SamgukStreamSchedulerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SamgukStreamSchedulerError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new SamgukStreamSchedulerError(code, message);
}

function positiveInteger(value, fallback, label) {
  const candidate = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(candidate) || candidate <= 0) {
    fail("invalid_config", `${label}은(는) 양의 정수여야 합니다.`);
  }
  return candidate;
}

function nonnegativeInteger(value, fallback, label) {
  const candidate = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(candidate) || candidate < 0) {
    fail("invalid_config", `${label}은(는) 0 이상의 정수여야 합니다.`);
  }
  return candidate;
}

function normalizeTimestamp(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    fail("invalid_time", `${label}은(는) 0 이상의 유한한 timestamp여야 합니다.`);
  }
  return value;
}

function normalizeTargets(inputs) {
  if (!Array.isArray(inputs) || inputs.length === 0 || inputs.length > MAX_TARGETS) {
    fail("invalid_targets", `targets는 1~${MAX_TARGETS}개여야 합니다.`);
  }
  const seen = new Set();
  return inputs.map((input, index) => {
    const target = typeof input === "string" ? { id: input } : input;
    if (!target || typeof target !== "object" || Array.isArray(target)) {
      fail("invalid_targets", `target[${index}] 형식이 올바르지 않습니다.`);
    }
    const id = String(target.id || "").normalize("NFKC").trim();
    if (!TARGET_ID_PATTERN.test(id)) {
      fail("invalid_targets", `target[${index}].id 형식이 올바르지 않습니다.`);
    }
    if (seen.has(id)) fail("duplicate_target", `target id '${id}'가 중복되었습니다.`);
    if (target.enabled !== undefined && typeof target.enabled !== "boolean") {
      fail("invalid_targets", `target[${index}].enabled는 boolean이어야 합니다.`);
    }
    seen.add(id);
    return Object.freeze({ ...target, id, enabled: target.enabled !== false });
  });
}

function normalizeOptions(options) {
  const config = {
    idleIntervalMs: positiveInteger(options.idleIntervalMs, DEFAULTS.idleIntervalMs, "idleIntervalMs"),
    liveIntervalMs: positiveInteger(options.liveIntervalMs, DEFAULTS.liveIntervalMs, "liveIntervalMs"),
    burstIntervalMs: positiveInteger(options.burstIntervalMs, DEFAULTS.burstIntervalMs, "burstIntervalMs"),
    burstDurationMs: positiveInteger(options.burstDurationMs, DEFAULTS.burstDurationMs, "burstDurationMs"),
    normalConcurrency: positiveInteger(
      options.normalConcurrency,
      DEFAULTS.normalConcurrency,
      "normalConcurrency",
    ),
    burstConcurrency: positiveInteger(
      options.burstConcurrency,
      DEFAULTS.burstConcurrency,
      "burstConcurrency",
    ),
    backoffBaseMs: positiveInteger(options.backoffBaseMs, DEFAULTS.backoffBaseMs, "backoffBaseMs"),
    backoffMaxMs: positiveInteger(options.backoffMaxMs, DEFAULTS.backoffMaxMs, "backoffMaxMs"),
    taskLeaseMs: positiveInteger(options.taskLeaseMs, DEFAULTS.taskLeaseMs, "taskLeaseMs"),
    initialSpreadMs: nonnegativeInteger(
      options.initialSpreadMs,
      DEFAULTS.initialSpreadMs,
      "initialSpreadMs",
    ),
    jitterRatio: options.jitterRatio === undefined ? DEFAULTS.jitterRatio : options.jitterRatio,
  };
  if (typeof config.jitterRatio !== "number" || !Number.isFinite(config.jitterRatio)
    || config.jitterRatio < 0 || config.jitterRatio > 0.5) {
    fail("invalid_config", "jitterRatio는 0 이상 0.5 이하여야 합니다.");
  }
  if (config.burstIntervalMs > config.liveIntervalMs || config.liveIntervalMs > config.idleIntervalMs) {
    fail("invalid_config", "주기는 burstIntervalMs <= liveIntervalMs <= idleIntervalMs 순서여야 합니다.");
  }
  if (config.burstDurationMs < config.burstIntervalMs) {
    fail("invalid_config", "burstDurationMs는 burstIntervalMs 이상이어야 합니다.");
  }
  if (config.backoffMaxMs < config.backoffBaseMs) {
    fail("invalid_config", "backoffMaxMs는 backoffBaseMs 이상이어야 합니다.");
  }
  if (config.normalConcurrency > MAX_TARGETS || config.burstConcurrency > MAX_TARGETS) {
    fail("invalid_config", `동시성은 각각 ${MAX_TARGETS} 이하여야 합니다.`);
  }
  return Object.freeze(config);
}

function createSamgukStreamScheduler(options = {}) {
  const targets = normalizeTargets(options.targets);
  const config = normalizeOptions(options);
  const clock = options.clock || Date.now;
  const random = options.random || Math.random;
  if (typeof clock !== "function" || typeof random !== "function") {
    fail("invalid_config", "clock과 random은 함수여야 합니다.");
  }

  let lastNow = normalizeTimestamp(options.now === undefined ? clock() : options.now, "now");
  let sequence = 0;
  const inFlight = new Map();
  const states = new Map();

  function readRandom() {
    const value = random();
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value >= 1) {
      fail("invalid_random", "random은 0 이상 1 미만의 숫자를 반환해야 합니다.");
    }
    return value;
  }

  function initialOffset() {
    if (config.initialSpreadMs === 0) return 0;
    return Math.floor(readRandom() * (config.initialSpreadMs + 1));
  }

  function jitter(intervalMs) {
    if (config.jitterRatio === 0) return intervalMs;
    const multiplier = 1 + (readRandom() * 2 - 1) * config.jitterRatio;
    return Math.max(1, Math.round(intervalMs * multiplier));
  }

  for (const target of targets) {
    states.set(target.id, {
      target,
      status: "unknown",
      nextDueAt: target.enabled ? lastNow + initialOffset() : Number.POSITIVE_INFINITY,
      burstStartedAt: null,
      burstUntil: null,
      consecutiveFailures: 0,
      inFlightTaskId: null,
      lastIssuedAt: null,
      lastResultAt: null,
      lastSuccessAt: null,
      lastLiveAt: null,
      lastCandidateAt: null,
      lastErrorCode: null,
    });
  }

  function nowValue(value) {
    const now = normalizeTimestamp(value === undefined ? clock() : value, "now");
    if (now < lastNow) fail("time_regression", "scheduler 시간은 이전 호출보다 과거일 수 없습니다.");
    lastNow = now;
    return now;
  }

  function requireState(targetId) {
    const state = states.get(targetId);
    if (!state) fail("unknown_target", `알 수 없는 target입니다: ${targetId}`);
    return state;
  }

  function isBurst(state, now) {
    return state.status === "live" && state.burstUntil !== null && state.burstUntil > now;
  }

  function laneFor(state, now) {
    return isBurst(state, now) ? "burst" : "normal";
  }

  function kindFor(state, now) {
    if (isBurst(state, now)) return "burst-scan";
    if (state.status === "live") return "live-scan";
    return "live-probe";
  }

  function clearExpiredBurst(state, now) {
    if (state.burstUntil !== null && state.burstUntil <= now) {
      state.burstStartedAt = null;
      state.burstUntil = null;
    }
  }

  function removeInFlight(task, state) {
    inFlight.delete(task.taskId);
    if (state.inFlightTaskId === task.taskId) state.inFlightTaskId = null;
  }

  function backoffDelay(state) {
    const exponent = Math.min(Math.max(0, state.consecutiveFailures - 1), 30);
    return Math.min(config.backoffMaxMs, config.backoffBaseMs * (2 ** exponent));
  }

  function scheduleFailure(task, state, now, errorCode) {
    removeInFlight(task, state);
    state.consecutiveFailures += 1;
    state.lastResultAt = now;
    state.lastErrorCode = String(errorCode || "task_failed").slice(0, 80);
    clearExpiredBurst(state, now);
    state.nextDueAt = now + jitter(backoffDelay(state));
  }

  function expireLeasesInternal(now) {
    let expired = 0;
    for (const task of [...inFlight.values()]) {
      if (task.leaseExpiresAt > now) continue;
      const state = requireState(task.targetId);
      scheduleFailure(task, state, now, "task_timeout");
      expired += 1;
    }
    return expired;
  }

  function issue(state, lane, now) {
    const taskId = `${state.target.id}:${++sequence}`;
    const task = Object.freeze({
      taskId,
      targetId: state.target.id,
      target: state.target,
      lane,
      kind: kindFor(state, now),
      dueAt: state.nextDueAt,
      issuedAt: now,
      leaseExpiresAt: now + config.taskLeaseMs,
      attempt: state.consecutiveFailures + 1,
    });
    state.inFlightTaskId = taskId;
    state.lastIssuedAt = now;
    inFlight.set(taskId, task);
    return task;
  }

  function countInFlight(lane) {
    let count = 0;
    for (const task of inFlight.values()) if (task.lane === lane) count += 1;
    return count;
  }

  function selectDue(value, {
    limit = Number.POSITIVE_INFINITY,
    expireLeases = true,
  } = {}) {
    const now = nowValue(value);
    if (limit !== Number.POSITIVE_INFINITY && (!Number.isSafeInteger(limit) || limit < 0)) {
      fail("invalid_limit", "limit은 0 이상의 정수여야 합니다.");
    }
    if (typeof expireLeases !== "boolean") {
      fail("invalid_config", "expireLeases는 boolean이어야 합니다.");
    }
    if (expireLeases) expireLeasesInternal(now);
    const due = [];
    for (const state of states.values()) {
      clearExpiredBurst(state, now);
      if (!state.target.enabled || state.inFlightTaskId || state.nextDueAt > now) continue;
      due.push(state);
    }
    due.sort((left, right) => (
      Number(laneFor(right, now) === "burst") - Number(laneFor(left, now) === "burst")
      || left.nextDueAt - right.nextDueAt
      || left.target.id.localeCompare(right.target.id)
    ));

    let normalAvailable = Math.max(0, config.normalConcurrency - countInFlight("normal"));
    let burstAvailable = Math.max(0, config.burstConcurrency - countInFlight("burst"));
    const selected = [];
    for (const state of due) {
      if (selected.length >= limit) break;
      const lane = laneFor(state, now);
      if (lane === "burst") {
        if (burstAvailable === 0) continue;
        burstAvailable -= 1;
      } else {
        if (normalAvailable === 0) continue;
        normalAvailable -= 1;
      }
      selected.push(issue(state, lane, now));
    }
    return selected;
  }

  function publicState(state, now) {
    return {
      targetId: state.target.id,
      enabled: state.target.enabled,
      status: state.status,
      mode: isBurst(state, now) ? "burst" : state.status,
      nextDueAt: Number.isFinite(state.nextDueAt) ? state.nextDueAt : null,
      burstStartedAt: state.burstStartedAt,
      burstUntil: state.burstUntil,
      consecutiveFailures: state.consecutiveFailures,
      inFlightTaskId: state.inFlightTaskId,
      lastIssuedAt: state.lastIssuedAt,
      lastResultAt: state.lastResultAt,
      lastSuccessAt: state.lastSuccessAt,
      lastLiveAt: state.lastLiveAt,
      lastCandidateAt: state.lastCandidateAt,
      lastErrorCode: state.lastErrorCode,
    };
  }

  function applyResult(taskId, result, value) {
    const now = nowValue(value);
    const task = inFlight.get(taskId);
    if (!task) fail("unknown_task", `진행 중이 아닌 task입니다: ${taskId}`);
    const state = requireState(task.targetId);
    if (now < task.issuedAt) fail("invalid_time", "결과 시각이 task 발급 시각보다 빠릅니다.");
    if (now >= task.leaseExpiresAt) {
      scheduleFailure(task, state, now, "task_timeout");
      fail("expired_task", `task lease가 만료되었습니다: ${taskId}`);
    }
    if (!result || typeof result !== "object" || Array.isArray(result)) {
      fail("invalid_result", "result는 객체여야 합니다.");
    }
    if (result.ok === false) {
      scheduleFailure(task, state, now, result.errorCode);
      return publicState(state, now);
    }
    if (typeof result.live !== "boolean") {
      fail("invalid_result", "성공 result에는 live boolean이 필요합니다.");
    }
    if (result.uiCandidate !== undefined && typeof result.uiCandidate !== "boolean") {
      fail("invalid_result", "uiCandidate는 boolean이어야 합니다.");
    }
    if (result.endBurst !== undefined && typeof result.endBurst !== "boolean") {
      fail("invalid_result", "endBurst는 boolean이어야 합니다.");
    }

    removeInFlight(task, state);
    state.consecutiveFailures = 0;
    state.lastErrorCode = null;
    state.lastResultAt = now;
    state.lastSuccessAt = now;
    if (!result.live) {
      state.status = "offline";
      state.burstStartedAt = null;
      state.burstUntil = null;
      state.nextDueAt = now + jitter(config.idleIntervalMs);
      return publicState(state, now);
    }

    state.status = "live";
    state.lastLiveAt = now;
    if (result.uiCandidate) state.lastCandidateAt = now;
    if (result.endBurst === true && task.lane === "burst") {
      state.burstStartedAt = null;
      state.burstUntil = null;
    }
    // normal scan의 최초 감지만 고정 길이 burst를 시작한다. burst 중 재감지는
    // 종료시각을 계속 연장하지 않아 한 방송이 자원을 영구 점유하지 못하게 한다.
    if (result.uiCandidate && task.lane === "normal" && !isBurst(state, now)) {
      state.burstStartedAt = now;
      state.burstUntil = now + config.burstDurationMs;
    }
    clearExpiredBurst(state, now);
    const interval = jitter(isBurst(state, now) ? config.burstIntervalMs : config.liveIntervalMs);
    // 실행 시간까지 주기에 더하면 모든 target이 매 scan마다 늦어져 HLS cursor가
    // 결국 playlist 밖으로 밀린다. 원래 예정 시각을 기준으로 다음 cadence를 잡고,
    // 이미 밀린 경우 즉시 catch-up한다.
    state.nextDueAt = Math.max(now, task.dueAt + interval);
    return publicState(state, now);
  }

  function expireLeases(value) {
    return expireLeasesInternal(nowValue(value));
  }

  function cancelTask(taskId, value) {
    const now = nowValue(value);
    const task = inFlight.get(taskId);
    if (!task) fail("unknown_task", `진행 중이 아닌 task입니다: ${taskId}`);
    const state = requireState(task.targetId);
    removeInFlight(task, state);
    state.nextDueAt = now;
    return publicState(state, now);
  }

  function setTargetEnabled(targetId, enabled, value) {
    if (typeof enabled !== "boolean") fail("invalid_target_state", "enabled는 boolean이어야 합니다.");
    const now = nowValue(value);
    const state = requireState(targetId);
    if (state.target.enabled === enabled) return publicState(state, now);
    state.target = Object.freeze({ ...state.target, enabled });
    if (!enabled) {
      const task = state.inFlightTaskId ? inFlight.get(state.inFlightTaskId) : null;
      if (task) removeInFlight(task, state);
      state.burstStartedAt = null;
      state.burstUntil = null;
      state.nextDueAt = Number.POSITIVE_INFINITY;
    } else {
      state.status = "unknown";
      state.consecutiveFailures = 0;
      state.lastErrorCode = null;
      state.nextDueAt = now;
    }
    return publicState(state, now);
  }

  function getTargetState(targetId, value) {
    const now = nowValue(value);
    const state = requireState(targetId);
    clearExpiredBurst(state, now);
    return publicState(state, now);
  }

  function getSnapshot(value) {
    const now = nowValue(value);
    const targetStates = [...states.values()].map(state => {
      clearExpiredBurst(state, now);
      return publicState(state, now);
    });
    const counts = { unknown: 0, offline: 0, live: 0, burst: 0, normalInFlight: 0, burstInFlight: 0 };
    for (const state of targetStates) {
      counts[state.status] += 1;
      if (state.mode === "burst") counts.burst += 1;
    }
    counts.normalInFlight = countInFlight("normal");
    counts.burstInFlight = countInFlight("burst");
    return { now, counts, targets: targetStates };
  }

  return Object.freeze({
    config,
    selectDue,
    applyResult,
    cancelTask,
    expireLeases,
    getSnapshot,
    getTargetState,
    setTargetEnabled,
  });
}

module.exports = {
  DEFAULTS,
  MAX_TARGETS,
  SamgukStreamSchedulerError,
  createSamgukStreamScheduler,
};
