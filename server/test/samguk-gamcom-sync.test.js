"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const {
  buildGamcomSnapshots,
  buildGamcomTerritoryChanges,
  buildReferenceRows,
  fetchGamcomTerritories,
  GAMCOM_TERRITORY_URL,
  mergeGamcomMembers,
  parseGamcomFactionPayload,
  parseGamcomTerritoryPayload,
  SNAPSHOT_FIELDS,
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
    healthStat: 153.9,
    activeGeneral: "영객 (하후돈)",
    defense: 7,
    attackPowerBonusPct: 5,
    damageReductionPct: 2.3,
    criticalChancePct: 15,
    criticalDamagePct: 120,
    skillCooldownReductionPct: 8,
    skillDamageBonusPct: 4.5,
    moveSpeedBonusPct: 3,
    horseMaxHealth: 176.9,
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

function territoryGroup(number) {
  if (number <= 20) return { group: "위", start: 1 };
  if (number <= 40) return { group: "촉", start: 21 };
  return { group: "오", start: 41 };
}

function territoryId(number) {
  const { group, start } = territoryGroup(number);
  return `${group}-${String(number - start + 1).padStart(3, "0")}`;
}

function normalizedTerritories(overrides = {}) {
  return Array.from({ length: 60 }, (_value, index) => {
    const number = index + 1;
    const owner = number === 8 ? "위" : number === 25 ? "촉" : number === 47 ? "오" : "미점령";
    return {
      id: territoryId(number),
      number,
      x: 310 + (index % 10) * 54,
      y: 115 + Math.floor(index / 10) * 54,
      owner,
      capital: [8, 25, 47].includes(number),
      facility: "없음",
      level: 3,
      ...(overrides[number] || {}),
    };
  });
}

function rawTerritoryPayload(overrides = {}) {
  const forces = { "위": [], "촉": [], "오": [] };
  normalizedTerritories(overrides).forEach(territory => {
    const { group } = territoryGroup(territory.number);
    forces[group].push({
      castleKey: territory.id,
      name: String(territory.number),
      level: territory.level,
      owner: territory.owner,
      isCapital: territory.capital,
      facilityType: territory.facility,
      x: territory.x,
      y: territory.y,
    });
  });
  return { forces };
}

function loadGamcomAppsScript() {
  const context = {
    Utilities: {
      DigestAlgorithm: { SHA_256: "SHA_256" },
      Charset: { UTF_8: "UTF_8" },
      computeDigest: (_algorithm, value) => Array.from(
        crypto.createHash("sha256").update(value, "utf8").digest(),
        byte => byte > 127 ? byte - 256 : byte,
      ),
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(
    __dirname,
    "../scripts/google-apps-script/samguk-gamcom-sync.gs",
  ), "utf8"), context);
  return context;
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

test("Node와 Apps Script의 Gamcom 완전 스냅샷 계약은 같은 29개 필드다", () => {
  const context = loadGamcomAppsScript();
  const appsScriptFields = Array.from(context.SAMGUK_GAMCOM_SNAPSHOT_FIELDS);

  assert.equal(SNAPSHOT_FIELDS.length, 29);
  assert.deepEqual(appsScriptFields, Array.from(SNAPSHOT_FIELDS));
  assert.ok(SNAPSHOT_FIELDS.includes("maxHealth"));
  assert.ok(SNAPSHOT_FIELDS.includes("attackPower"));
  assert.ok(SNAPSHOT_FIELDS.includes("horseMaxHealth"));
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

test("Gamcom 영토는 60칸 전체와 우리 원장의 불변 ID·번호·좌표를 검증한다", () => {
  const current = normalizedTerritories();
  const territories = parseGamcomTerritoryPayload(JSON.stringify(rawTerritoryPayload()), {
    currentTerritories: current,
  });

  assert.equal(territories.length, 60);
  assert.deepEqual(territories[0], current[0]);
  assert.deepEqual(territories.at(-1), current.at(-1));
  assert.deepEqual(
    territories.filter(territory => territory.capital).map(territory => [territory.number, territory.owner]),
    [[8, "위"], [25, "촉"], [47, "오"]],
  );
});

test("Apps Script도 60칸을 검증하고 바뀐 영토만 기존 영토입력 20열로 만든다", () => {
  const context = loadGamcomAppsScript();
  const current = normalizedTerritories();
  const externalPayload = rawTerritoryPayload({
    1: { owner: "위", facility: "병영", level: 4 },
    27: { owner: "위" },
  });
  const external = context.samgukGamcomParseTerritories_(JSON.stringify(externalPayload), current);
  const headers = [
    "territory_observation_id", "영토ID", "확인시각", "근거종류", "근거(URL/타임코드)",
    "번호", "X", "Y", "소유국", "수도", "시설", "레벨", "특수지", "점령상태",
    "점령률", "검증상태", "교차검증수", "증거해시", "메모", "입력시각",
  ];
  const sheet = {
    getLastColumn: () => headers.length,
    getRange: () => ({ getDisplayValues: () => [headers] }),
  };
  const result = context.samgukGamcomTerritoryRows_(
    sheet,
    current,
    external,
    new Date(COLLECTED_AT),
  );
  const rows = Array.from(result.rows, row => Array.from(row));

  assert.equal(rows.length, 2);
  assert.ok(rows.every(row => row.length === 20));
  assert.equal(rows[0][headers.indexOf("영토ID")], "위-001");
  assert.equal(rows[0][headers.indexOf("소유국")], "위");
  assert.equal(rows[0][headers.indexOf("시설")], "병영");
  assert.equal(rows[1][headers.indexOf("특수지")], "Y");
  assert.equal(rows[1][headers.indexOf("근거종류")], "Gamcom");
  assert.match(rows[1][headers.indexOf("메모")], /원문 갱신시각 미제공/);
  assert.equal(rows[0][headers.indexOf("증거해시")], rows[1][headers.indexOf("증거해시")]);
});

test("Gamcom 영토의 누락·중복·불변 좌표 변경·잘못된 상태를 전부 거부한다", () => {
  const current = normalizedTerritories();

  const missing = rawTerritoryPayload();
  missing.forces["위"].pop();
  assert.throws(
    () => parseGamcomTerritoryPayload(JSON.stringify(missing), { currentTerritories: current }),
    error => error?.code === "invalid_territories",
  );

  const duplicateCoordinate = rawTerritoryPayload();
  duplicateCoordinate.forces["위"][1].x = duplicateCoordinate.forces["위"][0].x;
  duplicateCoordinate.forces["위"][1].y = duplicateCoordinate.forces["위"][0].y;
  assert.throws(
    () => parseGamcomTerritoryPayload(JSON.stringify(duplicateCoordinate), { currentTerritories: current }),
    /중복/,
  );

  const coordinateDrift = rawTerritoryPayload();
  coordinateDrift.forces["위"][0].x += 1;
  assert.throws(
    () => parseGamcomTerritoryPayload(JSON.stringify(coordinateDrift), { currentTerritories: current }),
    /불변|좌표/,
  );

  const invalidUnclaimed = rawTerritoryPayload();
  invalidUnclaimed.forces["위"][0].facilityType = "장원";
  assert.throws(
    () => parseGamcomTerritoryPayload(JSON.stringify(invalidUnclaimed), { currentTerritories: current }),
    /미점령/,
  );

  const missingCapital = rawTerritoryPayload();
  missingCapital.forces["오"][6].isCapital = false;
  assert.throws(
    () => parseGamcomTerritoryPayload(JSON.stringify(missingCapital), { currentTerritories: current }),
    /수도/,
  );
});

test("Gamcom 영토 변경분만 상태형 관측으로 만들고 낮아진 값과 재점령도 반영한다", () => {
  const baseline = normalizedTerritories();
  const occupied = normalizedTerritories({
    1: { owner: "위", facility: "병영", level: 4 },
    27: { owner: "위" },
  });
  const first = buildGamcomTerritoryChanges(baseline, occupied, { collectedAt: COLLECTED_AT });

  assert.equal(first.changedCount, 2);
  assert.equal(first.observedAt, COLLECTED_AT);
  assert.equal(first.sourceUpdatedAt, null);
  assert.equal(first.changes[0].sourceType, "Gamcom");
  assert.equal(first.changes[0].evidence, GAMCOM_TERRITORY_URL);
  assert.deepEqual(first.changes[0].changedFields, ["owner", "facility", "level"]);
  assert.match(first.changes[0].note, /원문 갱신시각 미제공/);
  assert.equal(first.changes[1].number, 27);
  assert.equal(first.changes[1].special, true);
  assert.equal(new Set(first.changes.map(change => change.evidenceHash)).size, 1);

  const reverted = buildGamcomTerritoryChanges(occupied, baseline, {
    collectedAt: "2026-08-03T03:19:05.000Z",
  });
  assert.equal(reverted.changedCount, 2);
  assert.equal(reverted.changes[0].owner, "미점령");
  assert.equal(reverted.changes[0].facility, "없음");
  assert.equal(reverted.changes[0].level, 3, "영토 레벨도 MAX가 아닌 최신 상태를 써야 한다");
  assert.notEqual(reverted.changes[0].territoryObservationId, first.changes[0].territoryObservationId);

  const unchanged = buildGamcomTerritoryChanges(baseline, baseline, { collectedAt: COLLECTED_AT });
  assert.equal(unchanged.changedCount, 0);
  assert.deepEqual(unchanged.changes, []);
});

test("Gamcom 영토 fetch는 고정 JSON endpoint와 content-type을 강제한다", async () => {
  let requestedUrl = null;
  const payload = JSON.stringify(rawTerritoryPayload());
  const territories = await fetchGamcomTerritories({
    currentTerritories: normalizedTerritories(),
    fetchImpl: async (url, options) => {
      requestedUrl = url;
      assert.equal(options.redirect, "error");
      assert.equal(options.headers.Accept, "application/json");
      return new Response(payload, {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    },
  });
  assert.equal(requestedUrl, GAMCOM_TERRITORY_URL);
  assert.equal(territories.length, 60);

  await assert.rejects(
    fetchGamcomTerritories({
      currentTerritories: normalizedTerritories(),
      fetchImpl: async () => new Response(payload, {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    }),
    error => error?.code === "invalid_response",
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
  assert.equal(Object.keys(snapshots[0].fields).length, 29);
  assert.equal(snapshots[0].fields.weapon, 9);
  assert.equal(snapshots[0].fields.maxHealth, 1575);
  assert.equal(snapshots[0].fields.attackPower, 110);
  assert.equal(snapshots[0].fields.healthStat, 153.9);
  assert.equal(snapshots[0].fields.activeGeneral, "영객 (하후돈)");
  assert.equal(snapshots[0].fields.defense, 7);
  assert.equal(snapshots[0].fields.attackPowerBonusPct, 5);
  assert.equal(snapshots[0].fields.damageReductionPct, 2.3);
  assert.equal(snapshots[0].fields.criticalChancePct, 15);
  assert.equal(snapshots[0].fields.criticalDamagePct, 120);
  assert.equal(snapshots[0].fields.skillCooldownReductionPct, 8);
  assert.equal(snapshots[0].fields.skillDamageBonusPct, 4.5);
  assert.equal(snapshots[0].fields.moveSpeedBonusPct, 3);
  assert.equal(snapshots[0].fields.horseMaxHealth, 176.9);
  assert.equal(typeof snapshots[0].fields.healthStat, "number");
  assert.equal(typeof snapshots[0].fields.activeGeneral, "string");
  assert.equal(typeof snapshots[0].fields.horseMaxHealth, "number");
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
