"use strict";

const { BATCH_FIELDS, MAX_BATCH_RESULTS } = require("./samguk-broadcast-batch");
const {
  MIN_BROADCAST_CONFIDENCE,
  broadcastEvidenceUnitId,
  normalizeObservation,
} = require("./samguk-observations");

const DEFAULT_CONFIRMATION_WINDOW_MS = 120_000;
const MAX_TRACKED_KEYS = 90 * MAX_BATCH_RESULTS;
const MAX_OBSERVATION_BATCH_SIZE = MAX_BATCH_RESULTS;
const MAX_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const BASELINE_KEYS = new Set(["playerId", "field", "value"]);
const BATCH_FIELD_SET = new Set(BATCH_FIELDS);
const BASELINE_CONTEXT = Object.freeze({
  sourceType: "broadcast",
  sourceId: "screen:stable-baseline",
  sourceUrl: "https://play.sooplive.com/stable-baseline",
  observedAt: "2026-01-01T00:00:00.000Z",
  collectedAt: "2026-01-01T00:00:00.000Z",
  evidenceHash: "0".repeat(64),
  ocrConfidence: 1,
});

class SamgukBroadcastChangeTrackerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SamgukBroadcastChangeTrackerError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new SamgukBroadcastChangeTrackerError(code, message);
}

function positiveInteger(value, fallback, maximum, label) {
  const candidate = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(candidate) || candidate <= 0 || candidate > maximum) {
    fail("invalid_config", `${label}은(는) 1 이상 ${maximum} 이하의 정수여야 합니다.`);
  }
  return candidate;
}

function normalizeNow(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    fail("invalid_time", "now는 0 이상의 유한한 millisecond timestamp여야 합니다.");
  }
  return value;
}

function targetKey(playerId, field) {
  return `${playerId}\u0000${field}`;
}

function valueKey(value) {
  return JSON.stringify(value);
}

function strictBaselineEntry(input, now) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    fail("invalid_baseline", "stable baseline은 객체여야 합니다.");
  }
  const unexpected = Object.keys(input).filter(key => !BASELINE_KEYS.has(key));
  if (unexpected.length > 0) {
    fail("invalid_baseline", `stable baseline에 허용되지 않은 항목이 있습니다: ${unexpected.join(", ")}`);
  }
  const missing = [...BASELINE_KEYS].filter(key => !Object.prototype.hasOwnProperty.call(input, key));
  if (missing.length > 0) {
    fail("invalid_baseline", `stable baseline에 필수 항목이 없습니다: ${missing.join(", ")}`);
  }
  if (!BATCH_FIELD_SET.has(input.field)) {
    fail("invalid_baseline", `stable baseline field가 허용되지 않습니다: ${input.field}`);
  }
  try {
    const normalized = normalizeObservation({
      ...BASELINE_CONTEXT,
      playerId: input.playerId,
      field: input.field,
      value: input.value,
    }, { now });
    return {
      playerId: normalized.playerId,
      field: normalized.field,
      value: normalized.value,
    };
  } catch (error) {
    fail("invalid_baseline", `stable baseline이 올바르지 않습니다: ${error.message}`);
  }
}

function normalizeBroadcastObservation(input, now) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    fail("invalid_observation", "방송 관측값은 객체여야 합니다.");
  }
  if (typeof input.evidenceHash !== "string" || !/^[a-fA-F0-9]{64}$/.test(input.evidenceHash)) {
    fail("invalid_observation", "방송 관측값에는 SHA-256 evidenceHash가 필요합니다.");
  }
  let normalized;
  try {
    normalized = normalizeObservation(input, { now });
  } catch (error) {
    fail("invalid_observation", `방송 관측값이 올바르지 않습니다: ${error.message}`);
  }
  if (normalized.sourceType !== "broadcast" || !normalized.sourceId.startsWith("screen:")) {
    fail("invalid_observation", "방송 관측값은 screen: sourceId를 사용해야 합니다.");
  }
  if (!BATCH_FIELD_SET.has(normalized.field)) {
    fail("invalid_observation", `변화 추적 field가 허용되지 않습니다: ${normalized.field}`);
  }
  if (normalized.sourceUrl === null) {
    fail("invalid_observation", "방송 관측값에는 SOOP sourceUrl이 필요합니다.");
  }
  if (normalized.ocrConfidence === null || normalized.ocrConfidence < MIN_BROADCAST_CONFIDENCE) {
    fail(
      "low_confidence",
      `방송 관측 confidence는 ${MIN_BROADCAST_CONFIDENCE} 이상이어야 합니다.`,
    );
  }
  return normalized;
}

function normalizeObservationBatch(inputs, now) {
  if (!Array.isArray(inputs) || inputs.length > MAX_OBSERVATION_BATCH_SIZE) {
    fail(
      "invalid_batch",
      `방송 관측 batch는 0~${MAX_OBSERVATION_BATCH_SIZE}개 배열이어야 합니다.`,
    );
  }
  const observations = inputs.map(input => normalizeBroadcastObservation(input, now));
  if (observations.length === 0) return observations;
  const keys = new Set();
  const sourceId = observations[0].sourceId;
  const evidenceHash = observations[0].evidenceHash;
  for (const observation of observations) {
    const key = targetKey(observation.playerId, observation.field);
    if (keys.has(key)) {
      fail(
        "duplicate_batch_key",
        `방송 관측 batch key가 중복되었습니다: ${observation.playerId}/${observation.field}`,
      );
    }
    keys.add(key);
    if (observation.sourceId !== sourceId || observation.evidenceHash !== evidenceHash) {
      fail("mixed_frame", "방송 관측 batch에는 서로 다른 frame 근거를 섞을 수 없습니다.");
    }
  }
  return observations;
}

function createState(entry) {
  return {
    playerId: entry.playerId,
    field: entry.field,
    hasStable: true,
    stableValue: entry.value,
    stableValueKey: valueKey(entry.value),
    candidate: null,
  };
}

function createBroadcastChangeTracker(options = {}) {
  const windowMs = positiveInteger(
    options.windowMs,
    DEFAULT_CONFIRMATION_WINDOW_MS,
    MAX_WINDOW_MS,
    "windowMs",
  );
  const ttlMs = positiveInteger(options.ttlMs, windowMs, MAX_WINDOW_MS, "ttlMs");
  if (ttlMs < windowMs) fail("invalid_config", "ttlMs는 windowMs보다 짧을 수 없습니다.");
  const maxKeys = positiveInteger(options.maxKeys, MAX_TRACKED_KEYS, MAX_TRACKED_KEYS, "maxKeys");
  let states = new Map();

  function cleanup(now = Date.now()) {
    const currentTime = normalizeNow(now);
    let removedCandidates = 0;
    let removedKeys = 0;
    for (const [key, state] of states) {
      if (state.candidate && state.candidate.expiresAt <= currentTime) {
        state.candidate = null;
        removedCandidates += 1;
      }
      if (!state.hasStable && !state.candidate) {
        states.delete(key);
        removedKeys += 1;
      }
    }
    return { removedCandidates, removedKeys };
  }

  function assertCapacity(key) {
    if (!states.has(key) && states.size >= maxKeys) {
      fail("capacity_exceeded", `변화 추적 key는 최대 ${maxKeys}개입니다.`);
    }
  }

  function initializeStable(entries, { now = Date.now() } = {}) {
    const currentTime = normalizeNow(now);
    if (!Array.isArray(entries)) fail("invalid_baseline", "stable baseline 목록은 배열이어야 합니다.");
    if (entries.length > maxKeys) fail("capacity_exceeded", `stable baseline은 최대 ${maxKeys}개입니다.`);
    const next = new Map();
    for (const input of entries) {
      const entry = strictBaselineEntry(input, currentTime);
      const key = targetKey(entry.playerId, entry.field);
      if (next.has(key)) fail("duplicate_baseline", `stable baseline key가 중복되었습니다: ${entry.playerId}/${entry.field}`);
      next.set(key, createState(entry));
    }
    states = next;
    return states.size;
  }

  function reconcileStable(entries, { now = Date.now() } = {}) {
    const currentTime = normalizeNow(now);
    if (!Array.isArray(entries)) fail("invalid_baseline", "stable baseline 목록은 배열이어야 합니다.");
    if (entries.length > maxKeys) fail("capacity_exceeded", `stable baseline은 최대 ${maxKeys}개입니다.`);

    // Validate the complete replacement before looking at or mutating live
    // state. A malformed refresh therefore cannot partially reset candidates.
    const desired = new Map();
    for (const input of entries) {
      const entry = strictBaselineEntry(input, currentTime);
      const key = targetKey(entry.playerId, entry.field);
      if (desired.has(key)) {
        fail("duplicate_baseline", `stable baseline key가 중복되었습니다: ${entry.playerId}/${entry.field}`);
      }
      desired.set(key, entry);
    }

    const next = new Map();
    let added = 0;
    let updated = 0;
    let removed = 0;
    let unchanged = 0;
    let preservedCandidates = 0;

    for (const [key, entry] of desired) {
      const previous = states.get(key);
      if (previous?.hasStable && previous.stableValueKey === valueKey(entry.value)) {
        const candidate = previous.candidate?.expiresAt > currentTime
          ? previous.candidate
          : null;
        next.set(key, candidate === previous.candidate ? previous : { ...previous, candidate });
        unchanged += 1;
        if (candidate) preservedCandidates += 1;
      } else {
        next.set(key, createState(entry));
        if (previous) updated += 1;
        else added += 1;
      }
    }

    for (const [key, previous] of states) {
      if (desired.has(key)) continue;
      if (previous.hasStable) {
        removed += 1;
        continue;
      }
      const candidate = previous.candidate?.expiresAt > currentTime
        ? previous.candidate
        : null;
      if (candidate) {
        next.set(key, candidate === previous.candidate ? previous : { ...previous, candidate });
        preservedCandidates += 1;
      }
    }
    if (next.size > maxKeys) {
      fail("capacity_exceeded", `변화 추적 key는 최대 ${maxKeys}개입니다.`);
    }

    states = next;
    return Object.freeze({
      size: states.size,
      added,
      updated,
      removed,
      unchanged,
      preservedCandidates,
    });
  }

  function setStable(input, { now = Date.now() } = {}) {
    const currentTime = normalizeNow(now);
    cleanup(currentTime);
    const entry = strictBaselineEntry(input, currentTime);
    const key = targetKey(entry.playerId, entry.field);
    assertCapacity(key);
    states.set(key, createState(entry));
    return entry;
  }

  function observe(input, { now = Date.now(), onConfirmed = () => {} } = {}) {
    const currentTime = normalizeNow(now);
    if (typeof onConfirmed !== "function") {
      fail("invalid_callback", "onConfirmed는 동기 함수여야 합니다.");
    }
    cleanup(currentTime);
    const observation = normalizeBroadcastObservation(input, currentTime);
    const key = targetKey(observation.playerId, observation.field);
    assertCapacity(key);
    let state = states.get(key);
    if (!state) {
      state = {
        playerId: observation.playerId,
        field: observation.field,
        hasStable: false,
        stableValue: undefined,
        stableValueKey: null,
        candidate: null,
      };
      states.set(key, state);
    }

    const observedValueKey = valueKey(observation.value);
    if (state.hasStable && observedValueKey === state.stableValueKey) {
      state.candidate = null;
      return [];
    }

    const observedAtMs = Date.parse(observation.observedAt);
    const candidate = state.candidate;
    if (!candidate || candidate.valueKey !== observedValueKey) {
      state.candidate = {
        valueKey: observedValueKey,
        observation,
        observedAtMs,
        expiresAt: currentTime + ttlMs,
      };
      return [];
    }

    const deltaMs = observedAtMs - candidate.observedAtMs;
    if (Math.abs(deltaMs) > windowMs) {
      if (deltaMs > 0) {
        state.candidate = {
          valueKey: observedValueKey,
          observation,
          observedAtMs,
          expiresAt: currentTime + ttlMs,
        };
      }
      return [];
    }
    if (broadcastEvidenceUnitId(candidate.observation.sourceId)
        === broadcastEvidenceUnitId(observation.sourceId)
      || candidate.observation.evidenceHash === observation.evidenceHash) {
      return [];
    }

    const emitted = deltaMs < 0
      ? [observation, candidate.observation]
      : [candidate.observation, observation];
    try {
      const callbackResult = onConfirmed(emitted);
      if (callbackResult && typeof callbackResult.then === "function") {
        fail("invalid_callback", "onConfirmed는 Promise를 반환할 수 없습니다.");
      }
    } catch (error) {
      state.candidate = {
        valueKey: observedValueKey,
        observation,
        observedAtMs,
        expiresAt: currentTime + ttlMs,
      };
      throw error;
    }
    state.hasStable = true;
    state.stableValue = observation.value;
    state.stableValueKey = observedValueKey;
    state.candidate = null;
    return emitted;
  }

  function observeBatch(inputs, { now = Date.now(), onConfirmed = () => {} } = {}) {
    const currentTime = normalizeNow(now);
    if (typeof onConfirmed !== "function") {
      fail("invalid_callback", "onConfirmed는 동기 함수여야 합니다.");
    }
    const observations = normalizeObservationBatch(inputs, currentTime);
    cleanup(currentTime);

    const newKeys = observations
      .map(observation => targetKey(observation.playerId, observation.field))
      .filter(key => !states.has(key));
    if (states.size + newKeys.length > maxKeys) {
      fail("capacity_exceeded", `변화 추적 key는 최대 ${maxKeys}개입니다.`);
    }

    const plans = observations.map((observation) => {
      const key = targetKey(observation.playerId, observation.field);
      const previous = states.get(key) || {
        playerId: observation.playerId,
        field: observation.field,
        hasStable: false,
        stableValue: undefined,
        stableValueKey: null,
        candidate: null,
      };
      const observedValueKey = valueKey(observation.value);
      const observedAtMs = Date.parse(observation.observedAt);
      const currentCandidate = {
        valueKey: observedValueKey,
        observation,
        observedAtMs,
        expiresAt: currentTime + ttlMs,
      };

      if (previous.hasStable && observedValueKey === previous.stableValueKey) {
        const unchanged = { ...previous, candidate: null };
        return { key, success: unchanged, failure: unchanged, emitted: null };
      }

      const candidate = previous.candidate;
      if (!candidate || candidate.valueKey !== observedValueKey) {
        const pending = { ...previous, candidate: currentCandidate };
        return { key, success: pending, failure: pending, emitted: null };
      }

      const deltaMs = observedAtMs - candidate.observedAtMs;
      if (Math.abs(deltaMs) > windowMs) {
        const pending = deltaMs > 0
          ? { ...previous, candidate: currentCandidate }
          : { ...previous };
        return { key, success: pending, failure: pending, emitted: null };
      }
      if (broadcastEvidenceUnitId(candidate.observation.sourceId)
          === broadcastEvidenceUnitId(observation.sourceId)
        || candidate.observation.evidenceHash === observation.evidenceHash) {
        const pending = { ...previous };
        return { key, success: pending, failure: pending, emitted: null };
      }

      const emitted = deltaMs < 0
        ? [observation, candidate.observation]
        : [candidate.observation, observation];
      return {
        key,
        success: {
          ...previous,
          hasStable: true,
          stableValue: observation.value,
          stableValueKey: observedValueKey,
          candidate: null,
        },
        failure: { ...previous, candidate: currentCandidate },
        emitted,
      };
    });

    const confirmed = plans.flatMap(plan => plan.emitted || []);
    if (confirmed.length === 0) {
      for (const plan of plans) states.set(plan.key, plan.success);
      return [];
    }

    try {
      const callbackResult = onConfirmed(confirmed);
      if (callbackResult && typeof callbackResult.then === "function") {
        fail("invalid_callback", "onConfirmed는 Promise를 반환할 수 없습니다.");
      }
    } catch (error) {
      for (const plan of plans) states.set(plan.key, plan.failure);
      throw error;
    }
    for (const plan of plans) states.set(plan.key, plan.success);
    return confirmed;
  }

  function getState(playerId, field) {
    const state = states.get(targetKey(playerId, field));
    if (!state) return null;
    return {
      playerId: state.playerId,
      field: state.field,
      hasStable: state.hasStable,
      stableValue: state.hasStable ? state.stableValue : null,
      candidate: state.candidate ? {
        value: state.candidate.observation.value,
        sourceId: state.candidate.observation.sourceId,
        evidenceHash: state.candidate.observation.evidenceHash,
        observedAt: state.candidate.observation.observedAt,
        expiresAt: state.candidate.expiresAt,
      } : null,
    };
  }

  if (options.baselines !== undefined) {
    initializeStable(options.baselines, { now: options.now ?? Date.now() });
  }

  return Object.freeze({
    cleanup,
    getState,
    initializeStable,
    reconcileStable,
    observe,
    observeBatch,
    setStable,
    get size() { return states.size; },
    maxKeys,
    ttlMs,
    windowMs,
  });
}

module.exports = {
  DEFAULT_CONFIRMATION_WINDOW_MS,
  MAX_OBSERVATION_BATCH_SIZE,
  MAX_TRACKED_KEYS,
  SamgukBroadcastChangeTrackerError,
  createBroadcastChangeTracker,
};
