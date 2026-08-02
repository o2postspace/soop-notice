"use strict";

const {
  MIN_BROADCAST_CONFIDENCE,
  appendObservationQueue,
  normalizeObservation,
} = require("./samguk-observations");

const BATCH_VERSION = 2;
const MAX_BATCH_RESULTS = 24;
const PROFILE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const EVIDENCE_HASH_PATTERN = /^[a-fA-F0-9]{64}$/;
const BATCH_FIELDS = Object.freeze([
  "level",
  "horse",
  "horseLevel",
  "weapon",
  "helmet",
  "armor",
  "shoes",
  "strength",
  "agility",
  "vitality",
  "intelligence",
  "maxHealth",
  "attackPower",
  "healthStat",
  "activeGeneral",
  "defense",
  "attackPowerBonusPct",
  "damageReductionPct",
  "criticalChancePct",
  "criticalDamagePct",
  "skillCooldownReductionPct",
  "skillDamageBonusPct",
  "moveSpeedBonusPct",
  "horseMaxHealth",
]);
const BATCH_FIELD_SET = new Set(BATCH_FIELDS);
const BATCH_KEYS = new Set(["version", "profileId", "panelVisible", "results"]);
const RESULT_KEYS = new Set(["field", "value", "confidence"]);
const VALUE_VALIDATION_CONTEXT = Object.freeze({
  playerId: "P000",
  sourceType: "broadcast",
  sourceId: "screen:batch-value-validation",
  sourceUrl: "https://play.sooplive.com/batch-value-validation",
  observedAt: "2026-01-01T00:00:00.000Z",
  collectedAt: "2026-01-01T00:00:00.000Z",
  evidenceHash: "0".repeat(64),
});

class SamgukBroadcastBatchError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SamgukBroadcastBatchError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new SamgukBroadcastBatchError(code, message);
}

function strictObject(value, allowedKeys, requiredKeys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid_schema", `${label}은(는) 객체여야 합니다.`);
  }
  const unexpected = Object.keys(value).filter(key => !allowedKeys.has(key));
  if (unexpected.length > 0) {
    fail("invalid_schema", `${label}에 허용되지 않은 항목이 있습니다: ${unexpected.join(", ")}`);
  }
  const missing = requiredKeys.filter(key => !Object.prototype.hasOwnProperty.call(value, key));
  if (missing.length > 0) {
    fail("invalid_schema", `${label}에 필수 항목이 없습니다: ${missing.join(", ")}`);
  }
}

function normalizeProfileId(value, label = "profileId") {
  if (typeof value !== "string" || !PROFILE_ID_PATTERN.test(value)) {
    fail("invalid_profile", `${label} 형식이 올바르지 않습니다.`);
  }
  return value;
}

function normalizeResultValue(field, value, confidence) {
  try {
    return normalizeObservation({
      ...VALUE_VALIDATION_CONTEXT,
      field,
      value,
      ocrConfidence: confidence,
    }).value;
  } catch (error) {
    fail("invalid_result", `${field} 값이 올바르지 않습니다: ${error.message}`);
  }
}

function normalizeBatchObject(input, { expectedProfileId } = {}) {
  strictObject(input, BATCH_KEYS, [...BATCH_KEYS], "OCR batch");
  if (input.version !== BATCH_VERSION) {
    fail("invalid_version", `OCR batch version은 ${BATCH_VERSION}여야 합니다.`);
  }
  const profileId = normalizeProfileId(input.profileId);
  if (expectedProfileId !== undefined && profileId !== normalizeProfileId(expectedProfileId, "expectedProfileId")) {
    fail("profile_mismatch", "OCR batch profileId가 worker 설정과 다릅니다.");
  }
  if (typeof input.panelVisible !== "boolean") {
    fail("invalid_schema", "panelVisible은 boolean이어야 합니다.");
  }
  if (!Array.isArray(input.results) || input.results.length > MAX_BATCH_RESULTS) {
    fail("invalid_schema", `results는 0~${MAX_BATCH_RESULTS}개 배열이어야 합니다.`);
  }
  if (!input.panelVisible && input.results.length > 0) {
    fail("invalid_schema", "panelVisible=false이면 results는 비어 있어야 합니다.");
  }

  const fields = new Set();
  const results = input.results.map((result, index) => {
    const label = `results[${index}]`;
    strictObject(result, RESULT_KEYS, [...RESULT_KEYS], label);
    if (typeof result.field !== "string" || !BATCH_FIELD_SET.has(result.field)) {
      fail("invalid_field", `${label}.field가 허용된 batch 필드가 아닙니다.`);
    }
    if (fields.has(result.field)) {
      fail("duplicate_field", `${label}.field가 중복되었습니다: ${result.field}`);
    }
    fields.add(result.field);
    if (typeof result.confidence !== "number" || !Number.isFinite(result.confidence)
      || result.confidence < 0 || result.confidence > 1) {
      fail("invalid_confidence", `${label}.confidence는 0 이상 1 이하의 숫자여야 합니다.`);
    }
    return Object.freeze({
      field: result.field,
      value: normalizeResultValue(result.field, result.value, result.confidence),
      confidence: result.confidence,
    });
  });

  return Object.freeze({
    version: BATCH_VERSION,
    profileId,
    panelVisible: input.panelVisible,
    results: Object.freeze(results),
  });
}

function parseBroadcastBatchOutput(stdout, options = {}) {
  if (typeof stdout !== "string") {
    fail("invalid_json", "OCR batch 출력은 JSON 문자열이어야 합니다.");
  }
  let parsed;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    fail("invalid_json", "OCR adapter는 batch JSON 한 개만 stdout에 출력해야 합니다.");
  }
  return normalizeBatchObject(parsed, options);
}

function normalizeFrameContext(input, profileId, now) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    fail("invalid_context", "worker frame context가 필요합니다.");
  }
  if (normalizeProfileId(input.profileId, "frameContext.profileId") !== profileId) {
    fail("profile_mismatch", "OCR batch profileId가 worker frame context와 다릅니다.");
  }
  if (typeof input.sourceId !== "string" || !input.sourceId.startsWith("screen:")) {
    fail("invalid_context", "frameContext.sourceId는 screen: prefix가 필요합니다.");
  }
  if (typeof input.evidenceHash !== "string" || !EVIDENCE_HASH_PATTERN.test(input.evidenceHash)) {
    fail("invalid_context", "frameContext.evidenceHash는 SHA-256 hex여야 합니다.");
  }
  if (input.observedAt === undefined || input.observedAt === null || input.observedAt === "") {
    fail("invalid_context", "frameContext.observedAt이 필요합니다.");
  }
  try {
    const normalized = normalizeObservation({
      playerId: input.playerId,
      field: "level",
      value: 0,
      sourceType: "broadcast",
      sourceId: input.sourceId,
      sourceUrl: input.sourceUrl,
      observedAt: input.observedAt,
      collectedAt: input.collectedAt ?? input.observedAt,
      evidenceHash: input.evidenceHash,
      ocrConfidence: 1,
    }, { now });
    return {
      playerId: normalized.playerId,
      sourceType: normalized.sourceType,
      sourceId: normalized.sourceId,
      sourceUrl: normalized.sourceUrl,
      observedAt: normalized.observedAt,
      collectedAt: normalized.collectedAt,
      evidenceHash: normalized.evidenceHash,
    };
  } catch (error) {
    fail("invalid_context", `worker frame context가 올바르지 않습니다: ${error.message}`);
  }
}

/** 반환 배열 전체를 appendObservationQueue에 한 번만 전달해야 같은 frame batch 경계를 유지할 수 있습니다. */
function flattenBroadcastBatch(input, frameContext, { now = Date.now() } = {}) {
  const expectedProfileId = frameContext && frameContext.profileId;
  const batch = typeof input === "string"
    ? parseBroadcastBatchOutput(input, { expectedProfileId })
    : normalizeBatchObject(input, { expectedProfileId });
  const context = normalizeFrameContext(frameContext, batch.profileId, now);
  if (!batch.panelVisible) return [];

  return batch.results
    .filter(result => result.confidence >= MIN_BROADCAST_CONFIDENCE)
    .map(result => normalizeObservation({
      ...context,
      field: result.field,
      value: result.value,
      ocrConfidence: result.confidence,
    }, { now }));
}

function appendBroadcastBatch(queuePath, input, frameContext, options = {}) {
  const now = options.now ?? Date.now();
  const observations = flattenBroadcastBatch(input, frameContext, { now });
  if (observations.length === 0) return { observations, queueResult: null };
  const appendFn = options.appendFn || appendObservationQueue;
  const queueResult = appendFn(queuePath, observations, { now });
  return { observations, queueResult };
}

module.exports = {
  BATCH_FIELDS,
  BATCH_VERSION,
  MAX_BATCH_RESULTS,
  PROFILE_ID_PATTERN,
  SamgukBroadcastBatchError,
  appendBroadcastBatch,
  flattenBroadcastBatch,
  normalizeBatchObject,
  parseBroadcastBatchOutput,
};
