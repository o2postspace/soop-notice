const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const {
  CURRENT_SEASON_ID,
  SamgukObservationError,
  MONOTONIC_NUMERIC_FIELDS,
  acceptSheetBaseline,
  appendObservationQueue,
  findAcceptedConsensus,
  normalizeObservation,
  observationFingerprint,
  readObservationQueue,
  rewriteObservationQueue,
  resolveLatestAccepted,
} = require("../lib/samguk-observations");

const FIXED_NOW = Date.parse("2026-08-02T12:00:00.000Z");

function skillBuild(overrides = {}) {
  return {
    version: 1,
    preset: 1,
    ownedPoints: 6,
    skills: Array.from({ length: 6 }, (_value, index) => ({
      name: `절기 ${index + 1}`,
      requiredPoints: index + 1,
      allocatedPoints: index,
    })),
    ...overrides,
  };
}

function observation(overrides = {}) {
  const sourceType = overrides.sourceType || "sheet";
  const urls = {
    sheet: "https://docs.google.com/spreadsheets/d/test/edit",
    gamcom: "https://gamcom-3kingdom.vercel.app/factions/%EC%9C%84",
    fmkorea: "https://www.fmkorea.com/123456",
    broadcast: "https://play.sooplive.co.kr/testbj/1234",
  };
  return {
    seasonId: CURRENT_SEASON_ID,
    playerId: "P001",
    field: "strength",
    value: 10,
    sourceType,
    sourceId: `${sourceType}-1`,
    sourceUrl: urls[sourceType],
    observedAt: "2026-08-02T10:00:00.000Z",
    collectedAt: "2026-08-02T10:01:00.000Z",
    ocrConfidence: null,
    ...overrides,
  };
}

function temporaryQueue(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "samguk-observations-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, "queue.ndjson");
}

test("관측 스키마를 정규화하고 같은 근거는 결정적인 ID와 hash를 만든다", () => {
  const first = normalizeObservation(observation({ value: "1,234" }), { now: FIXED_NOW });
  const second = normalizeObservation(observation({
    value: 1234,
    collectedAt: "2026-08-02T11:59:00.000Z",
  }), { now: FIXED_NOW });

  assert.deepEqual(Object.keys(first), [
    "observationId", "seasonId", "playerId", "field", "value", "sourceType", "sourceId", "sourceUrl",
    "observedAt", "collectedAt", "evidenceHash", "ocrConfidence",
  ]);
  assert.equal(first.seasonId, CURRENT_SEASON_ID);
  assert.equal(first.value, 1234);
  assert.match(first.observationId, /^OBS-[A-F0-9]{24}$/);
  assert.match(first.evidenceHash, /^[a-f0-9]{64}$/);
  assert.equal(first.observationId, second.observationId);
  assert.equal(observationFingerprint(first), observationFingerprint(second));
  assert.equal(first.sourceUrl, "https://docs.google.com/spreadsheets/d/test/edit");
});

test("seasonId 누락과 다른 season은 관측 경계에서 fail-closed 처리한다", () => {
  const explicit = normalizeObservation(observation({ seasonId: CURRENT_SEASON_ID }));
  assert.equal(explicit.seasonId, CURRENT_SEASON_ID);
  const missing = observation();
  delete missing.seasonId;
  assert.throws(
    () => normalizeObservation(missing),
    error => error instanceof SamgukObservationError && error.code === "invalid_season",
  );
  assert.throws(
    () => normalizeObservation(observation({ seasonId: "samgukji-2026-08-03" })),
    error => error instanceof SamgukObservationError && error.code === "invalid_season",
  );
});

test("skillBuild는 6행 전체를 canonical JSON 단일 값으로 정규화한다", () => {
  const canonical = normalizeObservation(observation({
    field: "skillBuild",
    value: skillBuild(),
  })).value;
  const reordered = normalizeObservation(observation({
    field: "skillBuild",
    value: JSON.stringify({
      skills: skillBuild().skills.map(skill => ({
        allocatedPoints: skill.allocatedPoints,
        name: skill.name,
        requiredPoints: skill.requiredPoints,
      })),
      ownedPoints: 6,
      preset: 1,
      version: 1,
    }),
  })).value;
  assert.equal(reordered, canonical);
  assert.equal(JSON.parse(canonical).skills.length, 6);
  assert.throws(
    () => normalizeObservation(observation({
      field: "skillBuild",
      value: skillBuild({ skills: skillBuild().skills.slice(0, 5) }),
    })),
    error => error.code === "invalid_value",
  );
});

test("허용 필드, 값, URL host와 임의 상태 필드를 엄격히 검증한다", () => {
  assert.throws(
    () => normalizeObservation(observation({ field: "territory" })),
    error => error instanceof SamgukObservationError && error.code === "invalid_field",
  );
  assert.throws(
    () => normalizeObservation(observation({ sourceUrl: "https://evil.example/sheet" })),
    error => error.code === "invalid_url",
  );
  assert.throws(
    () => normalizeObservation(observation({ value: -1 })),
    error => error.code === "invalid_value",
  );
  assert.throws(
    () => normalizeObservation({ ...observation(), status: "검수대기" }),
    error => error.code === "invalid_schema",
  );

  const broadcast = normalizeObservation(observation({
    sourceType: "broadcast",
    sourceId: "frame-1",
    sourceUrl: "https://vod.sooplive.co.kr/player/1",
    ocrConfidence: "0.97",
  }));
  assert.equal(broadcast.ocrConfidence, 0.97);

  const gamcom = normalizeObservation(observation({ sourceType: "gamcom" }));
  assert.equal(gamcom.sourceType, "gamcom");
});

test("숫자 필드는 원장 validation과 같은 상한 및 정수 규칙을 사용한다", () => {
  for (const [field, maximum] of Object.entries({
    level: 10_000,
    horseLevel: 80,
    weapon: 15,
    helmet: 15,
    armor: 15,
    shoes: 15,
    strength: 1_000_000,
    agility: 1_000_000,
    vitality: 1_000_000,
    intelligence: 1_000_000,
    powerScore: 1_000_000,
    maxHealth: 1_000_000,
    attackPower: 1_000_000,
    basicAttackDamage: 1_000_000,
    basicAttackSampleCount: 10_000,
    healthStat: 1_000_000,
    defense: 1_000_000,
    attackPowerBonusPct: 1_000,
    damageReductionPct: 1_000,
    criticalChancePct: 1_000,
    criticalDamagePct: 1_000,
    skillCooldownReductionPct: 1_000,
    skillDamageBonusPct: 1_000,
    moveSpeedBonusPct: 1_000,
    horseMaxHealth: 1_000_000,
  })) {
    assert.equal(normalizeObservation(observation({ field, value: maximum })).value, maximum);
    assert.throws(
      () => normalizeObservation(observation({ field, value: maximum + 1 })),
      error => error.code === "invalid_value",
    );
  }
  assert.throws(
    () => normalizeObservation(observation({ field: "level", value: 1.5 })),
    error => error.code === "invalid_value",
  );
  assert.equal(normalizeObservation(observation({ field: "powerScore", value: 1234.5 })).value, 1234.5);
  assert.equal(normalizeObservation(observation({ field: "attackPower", value: 110.5 })).value, 110.5);
  assert.equal(normalizeObservation(observation({ field: "basicAttackDamage", value: 343.5 })).value, 343.5);
  assert.equal(normalizeObservation(observation({ field: "healthStat", value: 176.9 })).value, 176.9);
  assert.equal(normalizeObservation(observation({ field: "defense", value: 88.25 })).value, 88.25);
  assert.equal(normalizeObservation(observation({ field: "criticalChancePct", value: 12.5 })).value, 12.5);
  assert.throws(
    () => normalizeObservation(observation({ field: "horseMaxHealth", value: 123.5 })),
    error => error.code === "invalid_value",
  );
  assert.equal(normalizeObservation(observation({ field: "activeGeneral", value: "  조조  " })).value, "조조");
  assert.equal(normalizeObservation(observation({ field: "basicAttackTarget", value: "  훈련용 허수아비  " })).value, "훈련용 허수아비");
  assert.equal(normalizeObservation(observation({ field: "combatConditions", value: "무버프·비치명" })).value, "무버프·비치명");
  assert.throws(
    () => normalizeObservation(observation({ field: "basicAttackTarget", value: "가".repeat(121) })),
    error => error.code === "invalid_schema",
  );
  assert.throws(
    () => normalizeObservation(observation({ field: "combatConditions", value: "가".repeat(241) })),
    error => error.code === "invalid_schema",
  );
});

test("서로 다른 두 출처가 window 안에서 같은 값을 관측해야 교차검증된다", () => {
  const sheet = observation();
  const fmkorea = observation({
    sourceType: "fmkorea",
    sourceId: "post-123",
    sourceUrl: "https://m.fmkorea.com/123",
    observedAt: "2026-08-02T10:30:00.000Z",
  });
  const accepted = findAcceptedConsensus([sheet, fmkorea], { windowMs: 60 * 60 * 1000 });

  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].verification, "cross-source");
  assert.deepEqual(accepted[0].sourceTypes, ["fmkorea", "sheet"]);
  assert.equal(accepted[0].value, 10);

  assert.deepEqual(findAcceptedConsensus([
    sheet,
    { ...fmkorea, value: 11 },
  ]), []);
  assert.deepEqual(findAcceptedConsensus([
    sheet,
    { ...fmkorea, observedAt: "2026-08-03T12:00:00.000Z" },
  ], { windowMs: 60 * 60 * 1000 }), []);
});

test("고신뢰 방송은 서로 다른 frame 두 개가 같은 값을 잡을 때만 교차검증된다", () => {
  const frame1 = observation({
    sourceType: "broadcast",
    sourceId: "vod-1@00:10:01#frame-1",
    sourceUrl: "https://play.sooplive.co.kr/testbj/1",
    ocrConfidence: 0.96,
  });
  const frame2 = observation({
    sourceType: "broadcast",
    sourceId: "vod-1@00:10:03#frame-2",
    sourceUrl: "https://play.sooplive.co.kr/testbj/1",
    observedAt: "2026-08-02T10:00:02.000Z",
    ocrConfidence: 0.99,
  });
  const accepted = findAcceptedConsensus([frame1, frame2]);
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].verification, "broadcast-repeat");

  assert.deepEqual(findAcceptedConsensus([frame1, { ...frame2, sourceId: frame1.sourceId }]), []);
  assert.deepEqual(findAcceptedConsensus([frame1, { ...frame2, ocrConfidence: 0.94 }]), []);
  assert.deepEqual(findAcceptedConsensus([frame1, { ...frame2, value: 11 }]), []);
});

test("일반 HUD 방송은 같은 media segment의 연속 frame을 독립 근거로 세지 않는다", () => {
  const first = observation({
    field: "maxHealth",
    sourceType: "broadcast",
    sourceId: "screen:P001:1770000000000:1111111111111111:4",
    sourceUrl: "https://play.sooplive.co.kr/testbj/1",
    evidenceHash: "1".repeat(64),
    ocrConfidence: 0.99,
  });
  const sameSegment = observation({
    field: "maxHealth",
    sourceType: "broadcast",
    sourceId: "screen:P001:1770000003000:1111111111111111:5",
    sourceUrl: "https://play.sooplive.co.kr/testbj/1",
    observedAt: "2026-08-02T10:00:03.000Z",
    evidenceHash: "2".repeat(64),
    ocrConfidence: 0.99,
  });
  const nextSegment = observation({
    field: "maxHealth",
    sourceType: "broadcast",
    sourceId: "screen:P001:1770000006000:2222222222222222:0",
    sourceUrl: "https://play.sooplive.co.kr/testbj/1",
    observedAt: "2026-08-02T10:00:06.000Z",
    evidenceHash: "3".repeat(64),
    ocrConfidence: 0.99,
  });

  assert.deepEqual(findAcceptedConsensus([first, sameSegment]), []);
  const accepted = findAcceptedConsensus([first, sameSegment, nextSegment]);
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].evidenceUnitIds.length, 2);
});

test("고신뢰 장비·절기·기량은 같은 HLS segment의 서로 다른 frame도 합의한다", () => {
  for (const field of ["weapon", "skillBuild", "strength"]) {
    const value = field === "skillBuild" ? skillBuild() : 11;
    const first = observation({
      field,
      value,
      sourceType: "broadcast",
      sourceId: "screen:P001:1770000000000:1111111111111111:4",
      sourceUrl: "https://play.sooplive.co.kr/testbj/1",
      evidenceHash: "1".repeat(64),
      ocrConfidence: 0.99,
    });
    const second = observation({
      ...first,
      sourceId: "screen:P001:1770000000000:1111111111111111:5",
      evidenceHash: "2".repeat(64),
    });
    const accepted = findAcceptedConsensus([first, second]);
    assert.equal(accepted.length, 1);
    assert.equal(accepted[0].field, field);
    assert.equal(accepted[0].evidenceUnitIds.length, 2);
  }
});

test("skillBuild canonical snapshot 전체가 서로 다른 HLS 근거 두 번 일치해야 합의된다", () => {
  const frame = (segment, observedAt, value = skillBuild()) => observation({
    field: "skillBuild",
    value,
    sourceType: "broadcast",
    sourceId: `screen:P001:${Date.parse(observedAt)}:${segment}:0`,
    sourceUrl: "https://play.sooplive.co.kr/testbj/1",
    observedAt,
    evidenceHash: segment[0].repeat(64),
    ocrConfidence: 0.99,
  });
  const first = frame("1111111111111111", "2026-08-02T10:00:00.000Z");
  const changedRows = skillBuild({
    skills: skillBuild().skills.map((skill, index) => (
      index === 5 ? { ...skill, allocatedPoints: skill.allocatedPoints + 1 } : skill
    )),
  });
  assert.deepEqual(findAcceptedConsensus([
    first,
    frame("2222222222222222", "2026-08-02T10:00:03.000Z", changedRows),
  ]), []);

  const accepted = findAcceptedConsensus([
    first,
    frame("2222222222222222", "2026-08-02T10:00:03.000Z"),
  ]);
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].field, "skillBuild");
  assert.equal(JSON.parse(accepted[0].value).skills.length, 6);
  assert.equal(accepted[0].seasonId, CURRENT_SEASON_ID);
});

test("서로 다른 방송 근거도 현재 시각 기준 window보다 오래되면 승격하지 않는다", () => {
  const rows = [
    observation({
      sourceType: "broadcast",
      sourceId: "screen:old-frame-1",
      sourceUrl: "https://play.sooplive.co.kr/testbj/1",
      evidenceHash: "1".repeat(64),
      ocrConfidence: 0.99,
    }),
    observation({
      sourceType: "broadcast",
      sourceId: "screen:old-frame-2",
      sourceUrl: "https://play.sooplive.co.kr/testbj/1",
      observedAt: "2026-08-02T10:00:03.000Z",
      evidenceHash: "2".repeat(64),
      ocrConfidence: 0.99,
    }),
  ];
  assert.deepEqual(findAcceptedConsensus(rows, {
    windowMs: 60 * 60 * 1000,
    now: Date.parse("2026-08-02T11:00:04.000Z"),
  }), []);
});

test("저신뢰 방송은 다른 출처와 값이 같아도 교차검증 근거로 세지 않는다", () => {
  const fmkorea = observation({
    sourceType: "fmkorea",
    sourceId: "post-low-confidence",
    sourceUrl: "https://www.fmkorea.com/123",
  });
  const broadcast = observation({
    sourceType: "broadcast",
    sourceId: "frame-low-confidence",
    sourceUrl: "https://play.sooplive.co.kr/testbj/1",
    ocrConfidence: 0.94,
  });
  assert.deepEqual(findAcceptedConsensus([fmkorea, broadcast]), []);
});

test("저신뢰 최신 frame은 이미 검증된 값의 확인시각을 갱신하지 않는다", () => {
  const frames = [
    observation({
      sourceType: "broadcast",
      sourceId: "frame-eligible-1",
      sourceUrl: "https://play.sooplive.co.kr/testbj/1",
      observedAt: "2026-08-02T10:00:00.000Z",
      ocrConfidence: 0.98,
    }),
    observation({
      sourceType: "broadcast",
      sourceId: "frame-eligible-2",
      sourceUrl: "https://play.sooplive.co.kr/testbj/1",
      observedAt: "2026-08-02T10:00:02.000Z",
      ocrConfidence: 0.99,
    }),
    observation({
      sourceType: "broadcast",
      sourceId: "frame-low-latest",
      sourceUrl: "https://play.sooplive.co.kr/testbj/1",
      observedAt: "2026-08-02T10:10:00.000Z",
      ocrConfidence: 0.1,
    }),
  ];
  const accepted = findAcceptedConsensus(frames);
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].observedAt, "2026-08-02T10:00:02.000Z");
  assert.equal(accepted[0].observationIds.length, 2);
});

test("sheet baseline은 즉시 채택하지만 새 값은 교차검증된 경우에만 덮어쓴다", () => {
  const baseline = observation({
    sourceId: "sheet-baseline-row-1",
    observedAt: "2026-08-02T08:00:00.000Z",
  });
  assert.equal(acceptSheetBaseline(baseline).verification, "sheet-baseline");
  assert.throws(
    () => acceptSheetBaseline(observation({ sourceType: "fmkorea", sourceUrl: "https://www.fmkorea.com/1" })),
    error => error.code === "invalid_baseline",
  );

  const unverifiedNew = observation({
    sourceType: "fmkorea",
    sourceId: "post-new",
    sourceUrl: "https://www.fmkorea.com/2",
    observedAt: "2026-08-02T10:00:00.000Z",
    value: 11,
  });
  let latest = resolveLatestAccepted([unverifiedNew], { baselines: [baseline] });
  assert.equal(latest.length, 1);
  assert.equal(latest[0].value, 10);
  assert.equal(latest[0].verification, "sheet-baseline");

  const broadcastNew = observation({
    sourceType: "broadcast",
    sourceId: "frame-new",
    sourceUrl: "https://play.sooplive.co.kr/testbj/2",
    observedAt: "2026-08-02T10:05:00.000Z",
    value: 11,
    ocrConfidence: 0.98,
  });
  latest = resolveLatestAccepted([unverifiedNew, broadcastNew], { baselines: [baseline] });
  assert.equal(latest[0].value, 11);
  assert.equal(latest[0].verification, "cross-source");
});

test("기존 MAX 필드는 낮은 최신 검증값이 와도 최고값을 유지하고 동적 필드는 최신값을 쓴다", () => {
  const acceptedPair = (field, value, suffix, observedAt) => [
    observation({ field, value, sourceType: "sheet", sourceId: `sheet-${suffix}`, observedAt }),
    observation({
      field,
      value,
      sourceType: "fmkorea",
      sourceId: `fmk-${suffix}`,
      sourceUrl: `https://www.fmkorea.com/${suffix}`,
      observedAt,
    }),
  ];
  const inputs = [
    ...acceptedPair("attackPower", 210.5, "attack-high", "2026-08-02T09:00:00.000Z"),
    ...acceptedPair("attackPower", 210.5, "attack-high-latest", "2026-08-02T10:30:00.000Z"),
    ...acceptedPair("attackPower", 180.25, "attack-low", "2026-08-02T10:00:00.000Z"),
    ...acceptedPair("healthStat", 200.5, "health-high", "2026-08-02T09:00:00.000Z"),
    ...acceptedPair("healthStat", 176.9, "health-latest", "2026-08-02T10:00:00.000Z"),
  ];
  const latest = resolveLatestAccepted(inputs);

  assert.equal(latest.find(candidate => candidate.field === "attackPower").value, 210.5);
  assert.equal(latest.find(candidate => candidate.field === "attackPower").observedAt, "2026-08-02T10:30:00.000Z");
  assert.equal(latest.find(candidate => candidate.field === "healthStat").value, 176.9);
  assert.equal(latest.find(candidate => candidate.field === "healthStat").observedAt, "2026-08-02T10:00:00.000Z");
  assert.ok([
    "level", "horseLevel", "weapon", "helmet", "armor", "shoes", "strength", "agility",
    "vitality", "intelligence", "powerScore", "maxHealth", "attackPower",
    "basicAttackDamage", "basicAttackSampleCount",
  ].every(field => MONOTONIC_NUMERIC_FIELDS.has(field)));
  assert.ok([
    "healthStat", "activeGeneral", "defense", "attackPowerBonusPct", "damageReductionPct",
    "criticalChancePct", "criticalDamagePct", "skillCooldownReductionPct", "skillDamageBonusPct",
    "moveSpeedBonusPct", "horseMaxHealth",
  ].every(field => !MONOTONIC_NUMERIC_FIELDS.has(field)));
});

test("같은 최신 시각의 검증 결과가 충돌하면 그 값들은 버리고 직전 accepted를 유지한다", () => {
  const baseline = observation({ field: "healthStat", observedAt: "2026-08-02T08:00:00.000Z" });
  const conflicting = [
    observation({
      field: "healthStat",
      sourceType: "sheet",
      sourceId: "sheet-11",
      observedAt: "2026-08-02T10:00:00.000Z",
      value: 11,
    }),
    observation({
      field: "healthStat",
      sourceType: "fmkorea",
      sourceId: "fmk-11",
      sourceUrl: "https://www.fmkorea.com/11",
      observedAt: "2026-08-02T10:00:00.000Z",
      value: 11,
    }),
    observation({
      field: "healthStat",
      sourceType: "sheet",
      sourceId: "sheet-12",
      observedAt: "2026-08-02T10:00:00.000Z",
      value: 12,
    }),
    observation({
      field: "healthStat",
      sourceType: "broadcast",
      sourceId: "frame-12",
      sourceUrl: "https://play.sooplive.co.kr/testbj/12",
      observedAt: "2026-08-02T10:00:00.000Z",
      value: 12,
      ocrConfidence: 0.99,
    }),
  ];
  const latest = resolveLatestAccepted(conflicting, { baselines: [baseline] });
  assert.equal(latest.length, 1);
  assert.equal(latest[0].value, 10);
  assert.equal(latest[0].verification, "sheet-baseline");
});

test("동일 관측은 NDJSON queue에 한 번만 append하고 ID 충돌과 손상 파일을 거부한다", (t) => {
  const queue = temporaryQueue(t);
  const first = appendObservationQueue(queue, observation(), { now: FIXED_NOW });
  const second = appendObservationQueue(queue, observation({
    collectedAt: "2026-08-02T11:00:00.000Z",
  }), { now: FIXED_NOW });

  assert.equal(first.inserted.length, 1);
  assert.equal(second.inserted.length, 0);
  assert.equal(second.duplicates.length, 1);
  assert.equal(readObservationQueue(queue).length, 1);
  assert.equal(JSON.parse(fs.readFileSync(queue, "utf8")).seasonId, CURRENT_SEASON_ID);
  assert.equal(fs.readFileSync(queue, "utf8").trim().split("\n").length, 1);

  assert.throws(
    () => appendObservationQueue(queue, observation({
      observationId: first.inserted[0].observationId,
      sourceId: "different-source-row",
    })),
    error => error.code === "observation_id_conflict",
  );

  const corrupt = temporaryQueue(t);
  fs.writeFileSync(corrupt, "not-json\n", { mode: 0o600 });
  assert.throws(() => readObservationQueue(corrupt), error => error.code === "queue_corrupt");
});

test("seasonId 도입 전 영속 queue 행은 검증 후 현재 season 합의에서 제외한다", (t) => {
  const queue = temporaryQueue(t);
  const legacy = normalizeObservation(observation());
  delete legacy.seasonId;
  fs.writeFileSync(queue, `${JSON.stringify(legacy)}\n`, { mode: 0o600 });
  assert.deepEqual(readObservationQueue(queue), []);

  delete legacy.playerId;
  fs.writeFileSync(queue, `${JSON.stringify(legacy)}\n`, { mode: 0o600 });
  assert.throws(() => readObservationQueue(queue), error => error.code === "queue_corrupt");

  fs.writeFileSync(queue, "null\n", { mode: 0o600 });
  assert.throws(() => readObservationQueue(queue), error => error.code === "queue_corrupt");
});

test("queue rewrite는 검증·dedupe한 완전한 0600 파일로 원자 교체한다", (t) => {
  const queue = temporaryQueue(t);
  appendObservationQueue(queue, observation(), { now: FIXED_NOW });
  const previousInode = fs.statSync(queue).ino;
  const replacement = observation({
    sourceType: "fmkorea",
    sourceId: "post-rewrite",
    sourceUrl: "https://www.fmkorea.com/888",
    value: 11,
  });

  const result = rewriteObservationQueue(queue, [
    replacement,
    { ...replacement, collectedAt: "2026-08-02T11:00:00.000Z" },
  ], { now: FIXED_NOW });

  assert.equal(result.written, 1);
  assert.equal(readObservationQueue(queue).length, 1);
  assert.equal(readObservationQueue(queue)[0].value, 11);
  assert.notEqual(fs.statSync(queue).ino, previousInode);
  assert.equal(fs.statSync(queue).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(path.dirname(queue)), [path.basename(queue)]);

  const empty = rewriteObservationQueue(queue, [], { now: FIXED_NOW });
  assert.equal(empty.written, 0);
  assert.equal(fs.readFileSync(queue, "utf8"), "");
  assert.equal(fs.statSync(queue).mode & 0o777, 0o600);
});

test("queue rewrite 검증 실패는 기존 파일을 그대로 보존하고 임시 파일을 남기지 않는다", (t) => {
  const queue = temporaryQueue(t);
  appendObservationQueue(queue, observation(), { now: FIXED_NOW });
  const original = fs.readFileSync(queue, "utf8");

  assert.throws(
    () => rewriteObservationQueue(queue, [observation({ field: "unknown" })], { now: FIXED_NOW }),
    error => error.code === "invalid_field",
  );
  assert.throws(
    () => rewriteObservationQueue(queue, [observation()], { maxBytes: 1, now: FIXED_NOW }),
    error => error.code === "queue_too_large",
  );
  assert.equal(fs.readFileSync(queue, "utf8"), original);
  assert.deepEqual(fs.readdirSync(path.dirname(queue)), [path.basename(queue)]);
});

test("queue rewrite는 symlink와 일반 파일이 아닌 목적지를 거부한다", (t) => {
  const queue = temporaryQueue(t);
  const directory = path.dirname(queue);
  const target = path.join(directory, "target.ndjson");
  const link = path.join(directory, "link.ndjson");
  const invalidDirectory = path.join(directory, "queue-directory");
  fs.writeFileSync(target, "sentinel\n", { mode: 0o600 });
  fs.symlinkSync(target, link);
  fs.mkdirSync(invalidDirectory);

  assert.throws(
    () => rewriteObservationQueue(link, [observation()], { now: FIXED_NOW }),
    error => error.code === "invalid_path",
  );
  assert.throws(
    () => rewriteObservationQueue(invalidDirectory, [observation()], { now: FIXED_NOW }),
    error => error.code === "invalid_path",
  );
  assert.equal(fs.readFileSync(target, "utf8"), "sentinel\n");
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
});

test("CLI는 stdin 입력을 append하고 교차검증 결과를 JSON으로 출력한다", (t) => {
  const queue = temporaryQueue(t);
  const script = path.resolve(__dirname, "../scripts/samguk-submit-observation.js");
  const first = spawnSync(process.execPath, [script, "--queue", queue, "--baseline-sheet"], {
    input: JSON.stringify(observation()),
    encoding: "utf8",
  });
  assert.equal(first.status, 0, first.stderr);
  const firstResult = JSON.parse(first.stdout);
  assert.equal(firstResult.inserted, 1);
  assert.equal(firstResult.accepted[0].verification, "sheet-baseline");

  const second = spawnSync(process.execPath, [script, "--queue", queue], {
    input: JSON.stringify(observation({
      sourceType: "fmkorea",
      sourceId: "post-cli",
      sourceUrl: "https://www.fmkorea.com/777",
      observedAt: "2026-08-02T10:10:00.000Z",
    })),
    encoding: "utf8",
  });
  assert.equal(second.status, 0, second.stderr);
  const secondResult = JSON.parse(second.stdout);
  assert.equal(secondResult.inserted, 1);
  assert.equal(secondResult.accepted[0].verification, "cross-source");
  assert.equal(readObservationQueue(queue).length, 2);
});
