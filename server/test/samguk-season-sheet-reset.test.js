"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  CURRENT_HEADERS,
  DEFAULT_CUTOVER_AT,
  HUGUKJI_ROSTER_BY_NATION,
  PUBLIC_DETAIL_HEADERS,
  PUBLIC_RANKING_HEADERS,
  SEASON_ID,
  assertExactValueMatrix,
  backupSpreadsheet,
  buildCurrentRows,
  buildStaticPlan,
  executeSeasonReset,
  prepareGamcomMemberSeed,
  prepareMonitoring,
  prepareParticipants,
  prepareTerritoryBaseline,
} = require("../lib/samguk-season-sheet-reset");
const { parseArguments } = require("../scripts/reset-samguk-hugukji-sheets");
const FALLBACK = require("../data/samguk-fallback.json");

const PARTICIPANT_HEADERS = [
  "player_id", "국가", "세력/길드", "닉네임", "SOOP_ID", "장수/직업",
  "활동상태", "프로필URL", "방송URL", "메모",
];
const TERRITORY_HEADERS = [
  "territory_observation_id", "영토ID", "확인시각", "근거종류", "근거(URL/타임코드)",
  "번호", "X", "Y", "소유국", "수도", "시설", "레벨", "특수지", "점령상태",
  "점령률", "검증상태", "교차검증수", "증거해시", "메모", "입력시각",
];

function participantRange() {
  const rows = [PARTICIPANT_HEADERS];
  let index = 0;
  for (const [nation, names] of Object.entries(HUGUKJI_ROSTER_BY_NATION)) {
    for (const name of names) {
      index += 1;
      rows.push([
        `P${String(index).padStart(3, "0")}`, nation, "old crew", name, `user_${index}`,
        "old general", "활동", `https://www.sooplive.com/user_${index}`,
        `https://play.sooplive.com/user_${index}`, "old season",
      ]);
    }
  }
  return { values: rows };
}

function territoryRange() {
  const rows = [TERRITORY_HEADERS];
  for (const territory of FALLBACK.territories) {
    const number = territory.number;
    rows.push([
      `TINIT-OLD-${String(number).padStart(3, "0")}`,
      territory.id,
      1,
      "시트",
      "https://example.invalid",
      number,
      territory.x,
      territory.y,
      "미점령",
      [8, 42, 47].includes(number) ? "Y" : "N",
      territory.facility,
      territory.level,
      territory.special ? "Y" : "N",
      "미점령",
      "",
      "기준값",
      1,
      "",
      "legacy",
      1,
    ]);
  }
  return { values: rows };
}

function gamcomMemberSeed() {
  return {
    version: 1,
    seasonId: SEASON_ID,
    sourceUrl: "https://gamcom-3kingdom.vercel.app/factions?season=2",
    collectedAt: "2026-08-04T11:54:47.294Z",
    contentSha256: "4d10865b43421480207c1b30b8a3539864e02a583bdbf6cbf576ddd76108b64f",
    rows: FALLBACK.members.map(member => ({
      nation: `${member.nation}나라`,
      crew_name: member.crew,
      nickname: member.name,
      job: member.job,
      horse: member.horse,
      horse_level: member.horseLevel,
      weapon: member.weapon,
      helmet: member.helmet,
      armor: member.armor,
      shoes: member.shoes,
      stat_strength: member.strength,
      stat_agility: member.agility,
      stat_vitality: member.vitality,
      stat_intelligence: member.intelligence,
    })),
  };
}

function gamcomTerritorySeed() {
  return {
    version: 1,
    seasonId: SEASON_ID,
    sourceUrl: "https://gamcom-3kingdom.vercel.app/api/castles?fresh=1&season=2",
    collectedAt: "2026-08-04T11:54:47.294Z",
    contentSha256: "8534e87f86c97a6881b4704b7b9577c9b4e814fb9abbb93329b8c4f2bc91cb1b",
    rows: FALLBACK.territories.map(territory => ({
      castleKey: territory.id,
      name: String(territory.number),
      level: territory.level,
      owner: territory.owner,
      isCapital: territory.capital,
      isCheonrimun: territory.special,
      facilityType: territory.facility,
      x: territory.x,
      y: territory.y,
    })),
  };
}

test("기본 plan은 네트워크와 OAuth token을 사용하지 않고 정확한 reset 범위를 알린다", () => {
  const plan = buildStaticPlan("master-id", "public-id");
  assert.equal(plan.mode, "plan-only");
  assert.equal(plan.networkAccess, false);
  assert.equal(plan.seasonId, SEASON_ID);
  assert.equal(plan.master.clearDynamicRanges.length, 9);
  assert.ok(plan.master.clearDynamicRanges.every(value => /실제 grid 마지막행/.test(value)));
  assert.match(plan.backup.order, /spreadsheets\.create \+ sheets\.copyTo/);
  assert.ok(plan.requiredVerifiedSeeds.gamcomMemberJson);
  assert.ok(plan.requiredVerifiedSeeds.gamcomTerritoryJson);
  assert.equal(plan.executeRequiresBothExactSeeds, true);
});

test("CLI는 기본 plan이며 execute와 writer 중지 확인을 별도 파싱한다", () => {
  assert.deepEqual(parseArguments([]), { mode: "plan", writersPaused: false });
  assert.deepEqual(parseArguments(["--execute", "--writers-paused", "--confirm", `RESET-${SEASON_ID}`]), {
    mode: "execute",
    writersPaused: true,
    confirm: `RESET-${SEASON_ID}`,
  });
  assert.throws(() => parseArguments(["--unknown"]), /알 수 없는 옵션/);
});

test("참가자 90명 identity를 보존하고 old crew/general/dynamic 메모를 초기화한다", () => {
  const result = prepareParticipants(participantRange());
  assert.equal(result.length, 90);
  assert.deepEqual(result.map(row => row[1]).reduce((counts, nation) => {
    counts[nation] = (counts[nation] || 0) + 1;
    return counts;
  }, {}), { 위: 30, 촉: 30, 오: 30 });
  assert.ok(result.every(row => row[2] === "" && row[5] === "" && row[6] === "활동"));
  assert.equal(result[0][0], "P001");
  assert.equal(result[0][4], "user_1");
  assert.match(result[0][9], /후국지 명단 확인/);
});

test("참가자 player_id는 P001~P090 exact-set만 허용한다", () => {
  const invalid = participantRange();
  invalid.values[1][0] = "P091";
  assert.throws(
    () => prepareParticipants(invalid),
    error => error.code === "invalid_roster" && /P001~P090/.test(error.message),
  );
});

test("Gamcom season2 90명 exact-set은 C/F와 새 관측·외부참고를 시드한다", () => {
  const participants = prepareParticipants(participantRange());
  const result = prepareGamcomMemberSeed(gamcomMemberSeed(), participants, DEFAULT_CUTOVER_AT);
  assert.equal(result.participants.length, 90);
  assert.equal(result.observations.length, 90);
  assert.equal(result.externalReferences.length, 90);
  assert.equal(result.participants[0][2], "버인협회");
  assert.equal(result.participants[0][5], "조조");
  assert.equal(result.observations[0].length, 51);
  assert.equal(result.observations[0][3], "Gamcom");
  assert.equal(result.observations[0][18], "기준값");
  assert.equal(result.externalReferences[0].length, 24);

  const duplicate = gamcomMemberSeed();
  duplicate.rows[1].nickname = duplicate.rows[0].nickname;
  assert.throws(
    () => prepareGamcomMemberSeed(duplicate, participants, DEFAULT_CUTOVER_AT),
    error => error.code === "invalid_seed",
  );

  const forgedRows = gamcomMemberSeed();
  forgedRows.rows[0].weapon = 15;
  forgedRows.contentSha256 = "f".repeat(64);
  assert.throws(
    () => prepareGamcomMemberSeed(forgedRows, participants, DEFAULT_CUTOVER_AT),
    error => error.code === "invalid_seed",
  );

  const forgedEnvelope = gamcomMemberSeed();
  forgedEnvelope.untrusted = true;
  assert.throws(
    () => prepareGamcomMemberSeed(forgedEnvelope, participants, DEFAULT_CUTOVER_AT),
    error => error.code === "invalid_seed",
  );
});

test("방송모니터링은 Gamcom crew를 C열에 반영하고 identity/link/profile/담당자만 보존한다", () => {
  const base = prepareParticipants(participantRange());
  const seeded = prepareGamcomMemberSeed(gamcomMemberSeed(), base, DEFAULT_CUTOVER_AT).participants;
  const headers = [
    "player_id", "국가", "세력/길드", "닉네임", "SOOP_ID", "방송링크",
    "방송상태", "방송제목", "시청자", "모니터링상태", "화면/창번호",
    "해상도", "OCR프로필", "상태확인시각", "담당자", "메모",
  ];
  const range = {
    values: [headers, ...base.map(row => [
      row[0], row[1], "old crew", row[3], row[4], row[8],
      "LIVE", "old title", 999, "OCR연결", "old screen", "1080p", "hud-combat-v1",
      12345, "operator", "old note",
    ])],
  };
  const result = prepareMonitoring(range, seeded);
  assert.equal(result.length, 90);
  assert.equal(result[0][2], "버인협회");
  assert.equal(result[0][5], seeded[0][8]);
  assert.equal(result[0][6], "확인필요");
  assert.equal(result[0][9], "대기");
  assert.equal(result[0][12], "hud-combat-v1");
  assert.equal(result[0][14], "operator");
  assert.equal(result[0][15], "후국지 전환 초기화");
});

test("영토는 기본 static 미점령 또는 검증된 season2 수도 소유 baseline을 만든다", () => {
  const blank = prepareTerritoryBaseline(territoryRange(), DEFAULT_CUTOVER_AT);
  assert.equal(blank.length, 60);
  assert.ok(blank.every(row => row[8] === "미점령" && row[13] === "미점령"));
  assert.ok(blank.every(row => row[0].startsWith("TINIT-HUGUKJI-")));

  const seeded = prepareTerritoryBaseline(territoryRange(), DEFAULT_CUTOVER_AT, gamcomTerritorySeed());
  assert.equal(seeded.filter(row => row[8] !== "미점령").length, 4);
  assert.deepEqual(seeded.filter(row => row[8] !== "미점령").map(row => [row[5], row[8], row[9]]), [
    [8, "위", "Y"], [33, "촉", "N"], [42, "촉", "Y"], [47, "오", "Y"],
  ]);
  assert.ok(seeded.every(row => row[3] === "Gamcom"));
  assert.ok(seeded.every(row => row[12] === "N"));

  const forgedTopology = gamcomTerritorySeed();
  forgedTopology.rows.find(row => row.name === "33").isCapital = true;
  forgedTopology.contentSha256 = "e".repeat(64);
  assert.throws(
    () => prepareTerritoryBaseline(territoryRange(), DEFAULT_CUTOVER_AT, forgedTopology),
    error => error.code === "invalid_seed",
  );
});

test("관측 AY와 현재 BD 수식 계약이 90행 전체에 설치된다", () => {
  const rows = buildCurrentRows();
  assert.equal(CURRENT_HEADERS.length, 56);
  assert.equal(CURRENT_HEADERS[55], "절기배분");
  assert.equal(rows.length, 90);
  assert.ok(rows.every(row => row.length === 56));
  assert.match(rows[0][55], /'관측입력'!\$AY/);
  assert.match(rows[0][55], /MAX\(FILTER/);
  assert.equal(rows[0][26], '=IF(S2<>"",S2,O2)');
  assert.equal(PUBLIC_RANKING_HEADERS.length, 44);
  assert.equal(PUBLIC_DETAIL_HEADERS.length, 47);
});

test("backup은 create 뒤 숨김 포함 모든 탭을 copyTo하고 검증한다", async () => {
  const calls = [];
  const source = {
    properties: { title: "source", timeZone: "Asia/Seoul" },
    sheets: [
      { properties: { sheetId: 11, title: "visible", index: 0, hidden: false, gridProperties: { rowCount: 3, columnCount: 3 } } },
      { properties: { sheetId: 12, title: "hidden", index: 1, hidden: true, gridProperties: { rowCount: 2, columnCount: 2 } } },
    ],
  };
  const client = {
    async createSpreadsheet(payload) {
      calls.push(["create", payload]);
      return { spreadsheetId: "backupSpreadsheetId12345" };
    },
    async copySheet(sourceId, sheetId, destinationId) {
      calls.push(["copy", sourceId, sheetId, destinationId]);
      return { sheetId: sheetId + 100 };
    },
    async batchUpdateSpreadsheet(id, requests) {
      calls.push(["rename", id, requests]);
      return {};
    },
    async batchUpdateValues(id, mode, data) {
      calls.push(["manifest", id, mode, data]);
      return {};
    },
    async getSpreadsheet(id) {
      calls.push(["verify", id]);
      return {
        sheets: [
          { properties: { sheetId: 1, title: "백업정보", gridProperties: { rowCount: 20, columnCount: 4 } } },
          { properties: { sheetId: 111, title: "visible", hidden: false, gridProperties: { rowCount: 3, columnCount: 3 } } },
          { properties: { sheetId: 112, title: "hidden", hidden: true, gridProperties: { rowCount: 2, columnCount: 2 } } },
        ],
      };
    },
    async batchGetValues(id, ranges) {
      calls.push(["fingerprint", id, ranges]);
      return ranges.map(range => ({
        range,
        values: range.includes("visible") ? [["값", "=1+1"]] : [["숨김값"]],
      }));
    },
  };
  const result = await backupSpreadsheet(client, "sourceSpreadsheetId12", source, "운영원장", "2026-08-04T12:00:00.000Z");
  assert.equal(result.spreadsheetId, "backupSpreadsheetId12345");
  assert.deepEqual(calls.filter(call => call[0] === "copy").map(call => call[2]), [11, 12]);
  assert.equal(calls[0][0], "create");
  assert.equal(result.verifiedSheetCount, 2);
  assert.match(result.valueFormulaSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(calls.filter(call => call[0] === "fingerprint").map(call => call[1]), [
    "sourceSpreadsheetId12", "backupSpreadsheetId12345",
  ]);
});

test("backup 값/수식이 원본과 한 셀이라도 다르면 mutation 전에 실패한다", async () => {
  const source = {
    properties: { title: "source", timeZone: "Asia/Seoul" },
    sheets: [{
      properties: {
        sheetId: 11,
        title: "원본",
        index: 0,
        hidden: false,
        gridProperties: { rowCount: 3, columnCount: 3 },
      },
    }],
  };
  const client = {
    async createSpreadsheet() { return { spreadsheetId: "backupSpreadsheetId12345" }; },
    async copySheet() { return { sheetId: 111 }; },
    async batchUpdateSpreadsheet() { return {}; },
    async batchUpdateValues() { return {}; },
    async getSpreadsheet() {
      return {
        sheets: [
          { properties: { sheetId: 1, title: "백업정보", gridProperties: { rowCount: 20, columnCount: 4 } } },
          { properties: { ...source.sheets[0].properties, sheetId: 111 } },
        ],
      };
    },
    async batchGetValues(id, ranges) {
      return ranges.map(range => ({ range, values: [[id.startsWith("source") ? "원본" : "변조"]] }));
    },
  };
  await assert.rejects(
    backupSpreadsheet(client, "sourceSpreadsheetId12", source, "운영원장", "2026-08-04T12:00:00.000Z"),
    error => error.code === "backup_failed" && /값\/수식 fingerprint/.test(error.message),
  );
});

test("deep read-back은 92행 이후 남은 stale 동적값도 거부한다", () => {
  assert.doesNotThrow(() => assertExactValueMatrix({ values: [["new"]] }, [["new"]], "관측입력"));
  assert.throws(
    () => assertExactValueMatrix({ values: [["new"], ...Array.from({ length: 91 }, () => []), ["old"]] }, [["new"]], "관측입력"),
    error => error.code === "verification_failed",
  );
});

test("execute는 두 exact seed가 없으면 Google API를 호출하기 전에 중단한다", async () => {
  let calls = 0;
  const client = new Proxy({}, {
    get() {
      return async () => { calls += 1; return {}; };
    },
  });
  await assert.rejects(executeSeasonReset({
    client,
    masterSheetId: "masterSpreadsheetId12345",
    publicSheetId: "publicSpreadsheetId12345",
  }), error => error.code === "invalid_seed");
  assert.equal(calls, 0);
});
