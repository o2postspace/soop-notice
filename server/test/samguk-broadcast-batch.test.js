"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  BATCH_FIELDS,
  MAX_BATCH_RESULTS,
  SamgukBroadcastBatchError,
  appendBroadcastBatch,
  flattenBroadcastBatch,
  parseBroadcastBatchOutput,
} = require("../lib/samguk-broadcast-batch");
const { CURRENT_SEASON_ID } = require("../lib/samguk-observations");
const { normalizeSkillBuild } = require("../lib/samguk-skill-build");

const FRAME_CONTEXT = Object.freeze({
  profileId: "stats-panel-v1",
  seasonId: CURRENT_SEASON_ID,
  playerId: "P001",
  sourceId: "screen:p001-stats-1785621600000-frame1",
  sourceUrl: "https://play.sooplive.com/cnsgkcnehd74",
  observedAt: "2026-08-02T10:00:00.000Z",
  collectedAt: "2026-08-02T10:00:01.000Z",
  evidenceHash: "a".repeat(64),
});

function batch(overrides = {}) {
  return {
    version: 2,
    profileId: "stats-panel-v1",
    seasonId: CURRENT_SEASON_ID,
    panelVisible: true,
    results: [
      { field: "level", value: 42, confidence: 0.99 },
      { field: "horse", value: "백룡마", confidence: 0.98 },
      { field: "weapon", value: 4, confidence: 0.94 },
    ],
    ...overrides,
  };
}

function skillBuild(overrides = {}) {
  return {
    version: 1,
    preset: 3,
    ownedPoints: 4,
    skills: Array.from({ length: 6 }, (_value, index) => ({
      name: `절기 ${index + 1}`,
      requiredPoints: index + 1,
      allocatedPoints: index,
    })),
    ...overrides,
  };
}

function rejectsWith(code, operation) {
  assert.throws(
    operation,
    error => error instanceof SamgukBroadcastBatchError && error.code === code,
  );
}

test("strict v2 JSON을 파싱하고 worker가 지정한 profile만 허용한다", () => {
  const parsed = parseBroadcastBatchOutput(JSON.stringify(batch()), {
    expectedProfileId: "stats-panel-v1",
  });
  assert.equal(parsed.version, 2);
  assert.equal(parsed.profileId, "stats-panel-v1");
  assert.equal(parsed.seasonId, CURRENT_SEASON_ID);
  assert.equal(parsed.results.length, 3);
  assert.ok(Object.isFrozen(parsed));
  assert.ok(Object.isFrozen(parsed.results));

  rejectsWith("invalid_json", () => parseBroadcastBatchOutput("debug output"));
  rejectsWith("invalid_version", () => parseBroadcastBatchOutput(JSON.stringify(batch({ version: "2" }))));
  rejectsWith("invalid_profile", () => parseBroadcastBatchOutput(JSON.stringify(batch({ profileId: "../bad" }))));
  rejectsWith("profile_mismatch", () => parseBroadcastBatchOutput(JSON.stringify(batch()), {
    expectedProfileId: "other-profile",
  }));
  rejectsWith("invalid_season", () => parseBroadcastBatchOutput(JSON.stringify(batch({
    seasonId: "samgukji-2026-08-03",
  }))));
  const missingSeason = batch();
  delete missingSeason.seasonId;
  rejectsWith("invalid_schema", () => parseBroadcastBatchOutput(JSON.stringify(missingSeason)));
});

test("top-level과 result extra key, 중복·미허용 field를 frame 전체 오류로 처리한다", () => {
  rejectsWith("invalid_schema", () => parseBroadcastBatchOutput(JSON.stringify({ ...batch(), debug: true })));
  rejectsWith("invalid_schema", () => parseBroadcastBatchOutput(JSON.stringify(batch({
    results: [{ field: "level", value: 1, confidence: 0.99, text: "1" }],
  }))));
  rejectsWith("duplicate_field", () => parseBroadcastBatchOutput(JSON.stringify(batch({
    results: [
      { field: "level", value: 1, confidence: 0.99 },
      { field: "level", value: 2, confidence: 0.99 },
    ],
  }))));
  rejectsWith("invalid_field", () => parseBroadcastBatchOutput(JSON.stringify(batch({
    results: [{ field: "powerScore", value: 100, confidence: 0.99 }],
  }))));
});

test("panel이 보이지 않으면 빈 결과만 허용하고 results는 전체 OCR field 수까지다", () => {
  const complete = parseBroadcastBatchOutput(JSON.stringify(batch({
    results: BATCH_FIELDS.map((field, index) => ({
      field,
      value: field === "horse" ? "백룡마"
        : field === "activeGeneral" ? "조조"
          : field === "skillBuild" ? skillBuild()
            : index,
      confidence: 0.99,
    })),
  })));
  assert.equal(MAX_BATCH_RESULTS, BATCH_FIELDS.length);
  assert.equal(complete.results.length, BATCH_FIELDS.length);
  assert.ok(BATCH_FIELDS.includes("maxHealth"));
  assert.ok(BATCH_FIELDS.includes("attackPower"));
  assert.ok(BATCH_FIELDS.includes("horseMaxHealth"));
  assert.ok(BATCH_FIELDS.includes("strengthBonus"));
  assert.ok(BATCH_FIELDS.includes("skillHasteIncrease"));
  assert.ok(BATCH_FIELDS.includes("skillBuild"));

  const hidden = parseBroadcastBatchOutput(JSON.stringify(batch({ panelVisible: false, results: [] })));
  assert.deepEqual(Array.from(hidden.results), []);
  rejectsWith("invalid_schema", () => parseBroadcastBatchOutput(JSON.stringify(batch({ panelVisible: false }))));
  rejectsWith("invalid_schema", () => parseBroadcastBatchOutput(JSON.stringify(batch({
    results: Array.from({ length: MAX_BATCH_RESULTS + 1 }, (_value, index) => ({
      field: BATCH_FIELDS[index % BATCH_FIELDS.length],
      value: index,
      confidence: 0.99,
    })),
  }))));
});

test("skillBuild result는 정확한 6행을 canonical JSON 문자열 하나로 만든다", () => {
  const parsed = parseBroadcastBatchOutput(JSON.stringify(batch({
    seasonId: CURRENT_SEASON_ID,
    results: [{ field: "skillBuild", value: skillBuild(), confidence: 0.99 }],
  })));
  assert.equal(parsed.results[0].value, normalizeSkillBuild(skillBuild()));

  rejectsWith("invalid_result", () => parseBroadcastBatchOutput(JSON.stringify(batch({
    results: [{
      field: "skillBuild",
      value: skillBuild({ skills: skillBuild().skills.slice(0, 5) }),
      confidence: 0.99,
    }],
  }))));
});

test("confidence와 기존 observation 값 타입·범위를 동일하게 검증한다", () => {
  rejectsWith("invalid_confidence", () => parseBroadcastBatchOutput(JSON.stringify(batch({
    results: [{ field: "level", value: 1, confidence: 1.01 }],
  }))));
  rejectsWith("invalid_result", () => parseBroadcastBatchOutput(JSON.stringify(batch({
    results: [{ field: "strength", value: -1, confidence: 0.99 }],
  }))));
  rejectsWith("invalid_result", () => parseBroadcastBatchOutput(JSON.stringify(batch({
    results: [{ field: "armor", value: 1.5, confidence: 0.99 }],
  }))));
  rejectsWith("invalid_result", () => parseBroadcastBatchOutput(JSON.stringify(batch({
    results: [{ field: "horse", value: "", confidence: 0.99 }],
  }))));

  const normalized = parseBroadcastBatchOutput(JSON.stringify(batch({
    results: [
      { field: "strength", value: "1,234", confidence: 0.99 },
      { field: "attackPower", value: "110.5", confidence: 0.99 },
      { field: "healthStat", value: "176.9", confidence: 0.99 },
      { field: "defense", value: "88.25", confidence: 0.99 },
      { field: "criticalChancePct", value: "12.5", confidence: 0.99 },
    ],
  })));
  assert.equal(normalized.results[0].value, 1234);
  assert.deepEqual(normalized.results.slice(1).map(result => result.value), [110.5, 176.9, 88.25, 12.5]);
});

test("flatten은 저신뢰 결과를 제외하고 같은 worker frame 근거로 observation 배열을 만든다", () => {
  const observations = flattenBroadcastBatch(batch(), FRAME_CONTEXT, {
    now: Date.parse("2026-08-02T10:00:02.000Z"),
  });
  assert.equal(observations.length, 2);
  assert.deepEqual(observations.map(item => item.field), ["level", "horse"]);
  assert.ok(observations.every(item => item.sourceType === "broadcast"));
  assert.ok(observations.every(item => item.sourceId === FRAME_CONTEXT.sourceId));
  assert.ok(observations.every(item => item.observedAt === FRAME_CONTEXT.observedAt));
  assert.ok(observations.every(item => item.evidenceHash === FRAME_CONTEXT.evidenceHash));
  assert.deepEqual(observations.map(item => item.ocrConfidence), [0.99, 0.98]);
  assert.ok(observations.every(item => item.seasonId === CURRENT_SEASON_ID));

  rejectsWith("profile_mismatch", () => flattenBroadcastBatch(batch(), {
    ...FRAME_CONTEXT,
    profileId: "other-profile",
  }));
  const missingContextSeason = { ...FRAME_CONTEXT };
  delete missingContextSeason.seasonId;
  rejectsWith("invalid_context", () => flattenBroadcastBatch(batch(), missingContextSeason));
  rejectsWith("invalid_context", () => flattenBroadcastBatch(batch(), {
    ...FRAME_CONTEXT,
    sourceId: "not-a-screen-frame",
  }));
  rejectsWith("invalid_context", () => flattenBroadcastBatch(batch({
    panelVisible: false,
    results: [],
  }), {
    ...FRAME_CONTEXT,
    playerId: "unknown-player",
  }));
});

test("flatten은 skillBuild 6행 전체를 한 field 관측으로 유지한다", () => {
  const observations = flattenBroadcastBatch(batch({
    results: [{ field: "skillBuild", value: skillBuild(), confidence: 0.99 }],
  }), FRAME_CONTEXT, { now: Date.parse("2026-08-02T10:00:02.000Z") });
  assert.equal(observations.length, 1);
  assert.equal(observations[0].field, "skillBuild");
  assert.equal(observations[0].value, normalizeSkillBuild(skillBuild()));
  assert.equal(JSON.parse(observations[0].value).skills.length, 6);
});

test("같은 frame batch는 observation 배열 전체를 queue append에 정확히 한 번 전달한다", () => {
  const calls = [];
  const result = appendBroadcastBatch("/not-used/queue.ndjson", batch(), FRAME_CONTEXT, {
    now: Date.parse("2026-08-02T10:00:02.000Z"),
    appendFn(queuePath, observations, options) {
      calls.push({ queuePath, observations, options });
      return { inserted: observations, duplicates: [] };
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].observations, result.observations);
  assert.equal(calls[0].observations.length, 2);
  assert.equal(result.queueResult.inserted.length, 2);

  let hiddenCalls = 0;
  const hidden = appendBroadcastBatch("/not-used/queue.ndjson", batch({
    panelVisible: false,
    results: [],
  }), FRAME_CONTEXT, {
    appendFn() { hiddenCalls += 1; },
  });
  assert.equal(hiddenCalls, 0);
  assert.deepEqual(hidden, { observations: [], queueResult: null });
});
