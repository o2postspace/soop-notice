const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const express = require("express");
const {
  DEFAULT_MAX_BYTES,
  DEFAULT_SHEET_ID,
  buildCsvUrl,
  createSamgukSheetService,
  enrichMembersWithPowerIndex,
  parseCsv,
  parseMembersCsv,
  parseTerritoriesCsv,
  readTextLimited,
} = require("../lib/samguk-sheet");
const { createRouter } = require("../routes/samguk")._test;

const MEMBER_HEADERS = [
  "국가", "세력/길드", "닉네임", "SOOP_ID", "장수/직업", "레벨", "말", "말강화",
  "무기강화", "두갑강화", "흉갑강화", "각갑강화", "무력", "기민", "기력", "지모",
  "최종확인", "최근근거", "검수상태",
];
const TERRITORY_HEADERS = [
  "영토ID", "번호", "X", "Y", "소유국", "수도", "거점유형", "레벨", "최종확인", "근거", "검수상태",
];
const RULE_HEADERS = ["분류", "항목", "내용", "근거", "기준일", "검수상태"];
const EQUIPMENT_HEADERS = [
  "닉네임", "SOOP_ID",
  "무기각인1", "무기각인2", "무기각인3",
  "두갑각인1", "두갑각인2", "두갑각인3",
  "흉갑각인1", "흉갑각인2", "흉갑각인3",
  "각갑각인1", "각갑각인2", "각갑각인3",
  "최종확인", "최근근거", "출처종류", "교차검증수",
];

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function makeCsv(headers, rows) {
  return [headers, ...rows].map(row => row.map(csvCell).join(",")).join("\r\n");
}

function sheetCsv() {
  return {
    현재현황: makeCsv(MEMBER_HEADERS, [[
      "위나라", "버,인협회", "테스트", "test_bj", "조조", "18", "백룡마", "2", "4", "3", "2", "1",
      "1,234", "7", "8", "9", "2026-08-02 02:30:00", "https://example.com/vod\n01:23", "확정",
    ]]),
    영토현황: makeCsv(TERRITORY_HEADERS, [[
      "T001", "1", "634", "115", "위나라", "TRUE", "장원", "3", "2026-08-02 02:31:00", "https://example.com/map", "확정",
    ]]),
    게임정보: makeCsv(RULE_HEADERS, [[
      "영토", "영토 수", "총 60개", "https://example.com/rule", "2026-07-29", "참고",
    ]]),
  };
}

function googleFetch(csvBySheet, state = {}) {
  return async (url) => {
    state.urls ||= [];
    state.urls.push(url);
    if (state.fail) return new Response("private", { status: 401 });
    const sheet = new URL(url).searchParams.get("sheet");
    const body = csvBySheet[sheet];
    return new Response(body ?? "missing", {
      status: body === undefined ? 404 : 200,
      headers: { "Content-Type": "text/csv; charset=utf-8" },
    });
  };
}

const PAYLOAD_KEYS = [
  "members", "rules", "sheetUrl", "source", "stale", "territories", "updatedAt", "warnings",
].sort();
const RAW_MEMBER_KEYS = [
  "agility", "armor", "crew", "evidence", "helmet", "horse", "horseLevel", "intelligence", "job", "level",
  "basicAttackDamage", "basicAttackSampleCount", "basicAttackTarget", "combatConditions", "maxHealth",
  "name", "nation", "observedAt", "powerScore", "reviewStatus", "shoes", "soopId", "sourceCount",
  "sourceType", "strength", "verificationStatus", "vitality", "weapon",
].sort();
const MEMBER_KEYS = [
  ...RAW_MEMBER_KEYS,
  "engravings", "equipmentEvidence", "equipmentObservedAt", "equipmentSourceCount", "equipmentSourceType",
  "powerComponents", "powerCoverage", "powerIndex", "powerPopulation", "powerRange", "powerRankScore", "powerRankable", "powerSourcesVerified", "powerStatus", "powerVerified", "powerVersion",
].sort();
const TERRITORY_KEYS = [
  "capital", "evidence", "facility", "id", "level", "number", "observedAt", "owner", "reviewStatus",
  "sourceCount", "sourceType", "verificationStatus", "x", "y",
].sort();
const RULE_KEYS = ["category", "description", "reviewStatus", "sourceDate", "sourceUrl", "title"].sort();

test("CSV의 쉼표, escaped quote, 셀 내부 줄바꿈을 보존한다", () => {
  assert.deepEqual(parseCsv('a,"b,b","c""d","line1\nline2"\r\n1,2,3,4'), [
    ["a", "b,b", 'c"d', "line1\nline2"],
    ["1", "2", "3", "4"],
  ]);
});

test("현재현황은 열 순서가 아니라 헤더명으로 계약 필드를 만든다", () => {
  const result = parseMembersCsv(sheetCsv().현재현황);
  assert.equal(result.members.length, 1);
  assert.deepEqual(Object.keys(result.members[0]).sort(), RAW_MEMBER_KEYS);
  assert.equal(result.members[0].crew, "버,인협회");
  assert.equal(result.members[0].strength, 1234);
  assert.equal(result.members[0].evidence, "https://example.com/vod\n01:23");
  assert.equal(result.members[0].observedAt, "2026-08-01T17:30:00.000Z");
  assert.equal(result.members[0].powerScore, null);
  assert.equal(result.members[0].sourceType, "sheet");
  assert.equal(result.members[0].sourceCount, 1);
  assert.equal(result.members[0].verificationStatus, "baseline");

  const reordered = makeCsv(
    [...MEMBER_HEADERS].reverse(),
    [[...[
      "위", "크루", "이름", "bj_1", "직업", "1", "말", "1", "1", "1", "1", "1", "1", "1", "1", "1",
      "2026-08-02 00:00:00", "근거", "확정",
    ]].reverse()],
  );
  assert.equal(parseMembersCsv(reordered).members[0].soopId, "bj_1");
});

test("말 80강·장비 15강 초과값은 전체 시트 대신 해당 셀만 제외한다", () => {
  const rows = parseCsv(sheetCsv().현재현황);
  rows[1][7] = "81";
  rows[1][8] = "16";
  rows[1][10] = "999";
  const result = parseMembersCsv(makeCsv(rows[0], [rows[1]]));

  assert.equal(result.members[0].horseLevel, null);
  assert.equal(result.members[0].weapon, null);
  assert.equal(result.members[0].armor, null);
  assert.equal(result.members[0].helmet, 3);
  assert.match(result.warnings.join(" "), /말강화/);
  assert.match(result.warnings.join(" "), /무기강화/);
  assert.match(result.warnings.join(" "), /흉갑강화/);
});

test("현재현황의 선택형 무력점수와 교차검증 메타데이터를 정규화한다", () => {
  const headers = [
    ...MEMBER_HEADERS,
    "무력점수", "출처종류/출처", "교차검증수", "검증상태",
  ];
  const base = [
    "촉", "테스트", "관우", "test_kwanwoo", "관우", "20", "적토마", "3", "5", "4", "4", "4",
    "40", "10", "20", "5", "2026-08-02 03:00:00", "https://www.fmkorea.com/1", "확정",
  ];
  const parsed = parseMembersCsv(makeCsv(headers, [[
    ...base, "12,345", "에펨코리아", "3", "교차검증",
  ]]));

  assert.equal(parsed.members[0].powerScore, 12345);
  assert.equal(parsed.members[0].sourceType, "fmkorea");
  assert.equal(parsed.members[0].sourceCount, 3);
  assert.equal(parsed.members[0].verificationStatus, "cross-verified");

  const combined = parseMembersCsv(makeCsv(headers, [[
    ...base, "12,345", "방송/시트·에펨코리아", "3", "방송교차검증",
  ]]));
  assert.equal(combined.members[0].sourceType, "sheet+fmkorea+broadcast");
  assert.equal(combined.members[0].verificationStatus, "broadcast-verified");

  const invalid = parseMembersCsv(makeCsv(headers, [[
    ...base, "not-a-score", "직접 방송", "0", "",
  ]]));
  assert.equal(invalid.members[0].powerScore, null);
  assert.equal(invalid.members[0].sourceType, "broadcast");
  assert.equal(invalid.members[0].sourceCount, 1);
  assert.equal(invalid.members[0].verificationStatus, "baseline");
  assert.match(invalid.warnings.join(" "), /무력점수/);
  assert.match(invalid.warnings.join(" "), /교차검증수/);

  for (const [input, expected] of [
    ["기준값", "baseline"],
    ["방송교차검증", "broadcast-verified"],
    ["충돌", "conflict"],
    ["알 수 없음", "baseline"],
  ]) {
    const status = parseMembersCsv(makeCsv(headers, [[...base, "", "시트", "1", input]]));
    assert.equal(status.members[0].verificationStatus, expected);
  }
});

test("현재현황의 최대체력과 검증된 평타 대표값은 선택형 전투 관측으로 읽는다", () => {
  const headers = [
    ...MEMBER_HEADERS,
    "최대체력", "평타피해대표값", "평타표본수", "평타대상", "전투조건",
  ];
  const row = [
    "촉", "테스트", "관우", "test_combat", "관우", "20", "적토마", "3", "5", "4", "4", "4",
    "40", "10", "20", "5", "2026-08-02 03:00:00", "https://play.sooplive.com/test", "확정",
    "1,239", "343.5", "4", "동일 훈련 대상", "일반 평타·비치명",
  ];
  const member = parseMembersCsv(makeCsv(headers, [row])).members[0];

  assert.equal(member.maxHealth, 1239);
  assert.equal(member.basicAttackDamage, 343.5);
  assert.equal(member.basicAttackSampleCount, 4);
  assert.equal(member.basicAttackTarget, "동일 훈련 대상");
  assert.equal(member.combatConditions, "일반 평타·비치명");
});

test("새 검증상태 헤더를 verificationStatus와 호환 reviewStatus가 함께 읽는다", () => {
  const headers = MEMBER_HEADERS.map(header => header === "검수상태" ? "검증상태" : header);
  const row = [
    "오", "테스트", "주유", "test_juyu", "주유", "20", "적토마", "3", "5", "4", "4", "4",
    "30", "15", "10", "20", "2026-08-02 03:00:00", "방송 00:10:00", "방송교차검증",
  ];
  const member = parseMembersCsv(makeCsv(headers, [row])).members[0];

  assert.equal(member.reviewStatus, "방송교차검증");
  assert.equal(member.verificationStatus, "broadcast-verified");
});

test("호환 검수대기 값은 별도 승인 절차 없이 기준값으로 정규화한다", () => {
  const row = [
    "위", "테스트", "조조", "test_jojo", "조조", "20", "적토마", "3", "5", "4", "4", "4",
    "30", "15", "10", "20", "2026-08-02 03:00:00", "시트", "검수대기",
  ];
  const member = parseMembersCsv(makeCsv(MEMBER_HEADERS, [row])).members[0];

  assert.equal(member.reviewStatus, "기준값");
  assert.equal(member.verificationStatus, "baseline");
});

test("영토현황은 기존 검수상태와 새 검증상태 헤더를 모두 지원한다", () => {
  const headers = TERRITORY_HEADERS.map(header => header === "검수상태" ? "검증상태" : header);
  const row = [
    "T001", "1", "634", "115", "위", "TRUE", "장원", "3",
    "2026-08-02 03:00:00", "방송 00:20:00", "검수대기",
  ];
  const territory = parseTerritoriesCsv(makeCsv(headers, [row])).territories[0];

  assert.equal(territory.reviewStatus, "기준값");
  assert.equal(territory.sourceType, "sheet");
  assert.equal(territory.sourceCount, 1);
  assert.equal(territory.verificationStatus, "baseline");
});

test("필수 헤더 누락과 응답 크기 초과를 거부한다", async () => {
  assert.throws(() => parseMembersCsv("닉네임,SOOP_ID\n테스트,test"), /필수 헤더/);
  await assert.rejects(
    readTextLimited(new Response("x".repeat(DEFAULT_MAX_BYTES + 1)), DEFAULT_MAX_BYTES),
    /크기 제한/,
  );
});

test("Google gviz CSV URL은 첫 행 헤더와 표준 쿼리 파라미터를 고정한다", () => {
  const url = new URL(buildCsvUrl(DEFAULT_SHEET_ID, "현재현황"));

  assert.equal(url.origin, "https://docs.google.com");
  assert.equal(url.pathname, `/spreadsheets/d/${DEFAULT_SHEET_ID}/gviz/tq`);
  assert.deepEqual([...url.searchParams.keys()].sort(), ["headers", "sheet", "tqx"]);
  assert.equal(url.searchParams.get("tqx"), "out:csv");
  assert.equal(url.searchParams.get("sheet"), "현재현황");
  assert.equal(url.searchParams.get("headers"), "1");
});

test("Google Sheet 핵심 3개 탭과 선택형 장비현황을 읽어 정규 payload 계약으로 반환한다", async () => {
  const state = {};
  const service = createSamgukSheetService({
    fetchImpl: googleFetch(sheetCsv(), state),
    now: () => Date.parse("2026-08-02T03:00:00+09:00"),
    expectedMemberCount: 1,
    expectedTerritoryCount: 1,
  });
  const payload = await service.load();

  assert.deepEqual(Object.keys(payload).sort(), PAYLOAD_KEYS);
  assert.equal(payload.source, "google-sheet");
  assert.equal(payload.stale, false);
  assert.equal(DEFAULT_SHEET_ID, "1xC3leW9fFl4ytHI6i2UkQ8iViBFIwjLrug66lYmVckY");
  assert.equal(payload.sheetUrl, `https://docs.google.com/spreadsheets/d/${DEFAULT_SHEET_ID}/edit`);
  assert.deepEqual(Object.keys(payload.members[0]).sort(), MEMBER_KEYS);
  assert.deepEqual(Object.keys(payload.territories[0]).sort(), TERRITORY_KEYS);
  assert.deepEqual(Object.keys(payload.rules[0]).sort(), RULE_KEYS);
  assert.equal(payload.territories[0].owner, "위");
  assert.equal(payload.territories[0].capital, true);
  assert.equal(payload.rules[0].title, "영토 수");
  assert.equal(state.urls.length, 4);
  assert.ok(state.urls.every(url => new URL(url).hostname === "docs.google.com"));
  assert.ok(state.urls.every(url => new URL(url).pathname.includes(`/d/${DEFAULT_SHEET_ID}/`)));
  assert.ok(state.urls.every(url => new URL(url).searchParams.get("headers") === "1"));
  assert.ok(state.urls.every(url => !url.includes("vercel.app")));
  assert.equal(payload.members[0].powerVersion, "v1.1");
  assert.equal(payload.members[0].powerStatus, "insufficient");
  assert.equal(payload.members[0].powerCoverage, 80);
  assert.deepEqual(payload.members[0].engravings, []);
  assert.match(payload.warnings.join(" "), /장비현황/);
});

test("선택형 장비현황 각인을 참가자에 합치고 파워 v1을 확정 계산한다", async () => {
  const csv = sheetCsv();
  const memberRows = parseCsv(csv.현재현황);
  memberRows[0].push("출처종류", "교차검증수", "검증상태");
  memberRows[1].push("시트/방송", "2", "방송교차검증");
  csv.현재현황 = makeCsv(memberRows[0], [memberRows[1]]);
  csv.장비현황 = makeCsv(EQUIPMENT_HEADERS, [[
    "테스트", "test_bj",
    "필살 13.5%", "없음", "없음",
    "없음", "없음", "없음",
    "강건", "없음", "없음",
    "난격 3.4", "없음", "없음",
    "2026-08-02 22:00:00", "방송 01:07:54", "방송/시트", "2",
  ]]);
  const service = createSamgukSheetService({
    fetchImpl: googleFetch(csv),
    expectedMemberCount: 1,
    expectedTerritoryCount: 1,
  });
  const payload = await service.load();
  const member = payload.members[0];

  assert.equal(payload.source, "google-sheet");
  assert.doesNotMatch(payload.warnings.join(" "), /미관측으로 처리/);
  assert.equal(member.engravings.length, 12);
  assert.equal(member.engravings[0].name, "필살");
  assert.equal(member.equipmentSourceType, "sheet+broadcast");
  assert.equal(member.equipmentSourceCount, 2);
  assert.equal(member.powerCoverage, 100);
  assert.equal(member.powerStatus, "confirmed");
  assert.equal(member.powerRankable, true);
  assert.equal(member.powerSourcesVerified, true);
  assert.deepEqual(member.powerPopulation, {
    sample: 1,
    required: 1,
    coverage: 100,
    ready: true,
    fieldSamples: { level: 1, strength: 1, agility: 1, vitality: 1, intelligence: 1 },
  });
  assert.equal(member.powerVerified, true);
  assert.equal(member.powerComponents.engravings.filledSlots, 3);
  assert.deepEqual(member.powerRange, { lower: member.powerIndex, upper: member.powerIndex });
});

test("수치가 완비돼도 단일 출처면 확정 대신 잠정 파워로 표시한다", async () => {
  const csv = sheetCsv();
  csv.장비현황 = makeCsv(EQUIPMENT_HEADERS, [[
    "테스트", "test_bj",
    "필살 13.5%", "없음", "없음",
    "없음", "없음", "없음",
    "강건", "없음", "없음",
    "난격 3.4", "없음", "없음",
    "2026-08-02 22:00:00", "방송 01:07:54", "시트", "1",
  ]]);
  const payload = await createSamgukSheetService({
    fetchImpl: googleFetch(csv),
    expectedMemberCount: 1,
    expectedTerritoryCount: 1,
  }).load();
  const member = payload.members[0];

  assert.equal(member.powerCoverage, 100);
  assert.equal(member.powerRankable, true);
  assert.equal(member.powerSourcesVerified, false);
  assert.equal(member.powerVerified, false);
  assert.equal(member.powerStatus, "provisional");
});

test("90명 로스터는 레벨·기량 비교표본 63명 전까지 확정하지 않는다", () => {
  const members = Array.from({ length: 90 }, (_, index) => {
    const comparable = index < 62;
    return {
      name: `참가자${index}`,
      soopId: `sample_${index}`,
      job: "천강",
      level: comparable ? 10 : null,
      strength: comparable ? 10 : null,
      agility: comparable ? 10 : null,
      vitality: comparable ? 10 : null,
      intelligence: comparable ? 10 : null,
      weapon: 0,
      helmet: null,
      armor: 0,
      shoes: 0,
      horseLevel: 0,
      engravings: Array.from({ length: 9 }, () => ({ state: "empty" })),
      sourceCount: 2,
      sourceType: "sheet+broadcast",
      verificationStatus: "cross-verified",
      observedAt: "2026-08-02T13:00:00.000Z",
      equipmentSourceCount: 2,
      equipmentSourceType: "sheet+broadcast",
      equipmentObservedAt: "2026-08-02T13:00:00.000Z",
    };
  });
  const powered = enrichMembersWithPowerIndex(members);

  assert.deepEqual(powered[0].powerPopulation, {
    sample: 62,
    required: 63,
    coverage: 68.8889,
    ready: false,
    fieldSamples: { level: 62, strength: 62, agility: 62, vitality: 62, intelligence: 62 },
  });
  assert.equal(powered[0].powerCoverage, 100);
  assert.equal(powered[0].powerSourcesVerified, true);
  assert.equal(powered[0].powerVerified, false);
  assert.equal(powered[0].powerStatus, "provisional");
});

test("갱신 오류에는 마지막 정상값을 유지하고 cold 오류에는 기준값 seed를 쓴다", async () => {
  const state = {};
  const service = createSamgukSheetService({
    fetchImpl: googleFetch(sheetCsv(), state),
    expectedMemberCount: 1,
    expectedTerritoryCount: 1,
  });
  const fresh = await service.load();
  state.fail = true;
  const stale = await service.load();
  assert.equal(stale.source, "google-sheet-last-good");
  assert.equal(stale.stale, true);
  assert.deepEqual(stale.members, fresh.members);
  assert.match(stale.warnings.join(" "), /마지막 정상 자료/);

  const cold = createSamgukSheetService({
    fetchImpl: async () => new Response("private", { status: 401 }),
  });
  const fallback = await cold.load();
  assert.deepEqual(Object.keys(fallback).sort(), PAYLOAD_KEYS);
  assert.equal(fallback.source, "fallback-seed");
  assert.equal(fallback.stale, true);
  assert.equal(fallback.members.length, 90);
  assert.equal(fallback.territories.length, 60);
  assert.ok(fallback.members.every(member => member.powerScore === null));
  assert.ok(fallback.members.every(member => member.sourceType === "sheet"));
  assert.ok(fallback.members.every(member => member.sourceCount === 1));
  assert.ok(fallback.members.every(member => member.verificationStatus === "baseline"));
  assert.ok(fallback.members.every(member => member.reviewStatus === "기준값"));
  assert.ok(fallback.territories.every(territory => territory.reviewStatus === "기준값"));
  assert.doesNotMatch(JSON.stringify(fallback), /검수대기/);
  assert.match(fallback.warnings.join(" "), /0 sentinel은 미입력 여부/);
  assert.equal(fallback.members.some(member => [
    member.horseLevel, member.weapon, member.helmet, member.armor, member.shoes,
    member.strength, member.agility, member.vitality, member.intelligence,
  ].includes(0)), false);
  assert.equal(fallback.members.find(member => member.name === "김병살").job, "운책");
});

test("fallback 최신 스냅샷은 기량 랭킹 품질 기준을 만족한다", () => {
  const snapshot = JSON.parse(fs.readFileSync(
    path.join(__dirname, "../data/samguk-fallback.json"),
    "utf8",
  ));
  const numericFields = [
    "level", "horseLevel", "weapon", "helmet", "armor", "shoes",
    "strength", "agility", "vitality", "intelligence",
  ];
  const growthFields = ["strength", "agility", "vitality", "intelligence"];
  const growthScore = member => growthFields.reduce(
    (sum, field) => sum + (Number.isFinite(member[field]) && member[field] > 0 ? member[field] : 0),
    0,
  );

  assert.equal(snapshot.members.length, 90);
  assert.ok(snapshot.members.every(member => Object.hasOwn(member, "powerScore")));
  assert.ok(snapshot.members.every(member => Object.hasOwn(member, "sourceType")));
  assert.ok(snapshot.members.every(member => Object.hasOwn(member, "sourceCount")));
  assert.ok(snapshot.members.every(member => Object.hasOwn(member, "verificationStatus")));
  assert.equal(snapshot.members.some(member => numericFields.some(field => member[field] === 0)), false);
  assert.equal(snapshot.members.filter(member => member.strength > 0).length, 24);
  assert.equal(snapshot.members.filter(member => growthScore(member) > 0).length, 30);
  assert.equal(snapshot.members.reduce((sum, member) => sum + growthScore(member), 0), 373);
  assert.equal(growthScore(snapshot.members.find(member => member.name === "조경훈")), 86);
  assert.equal(growthScore(snapshot.members.find(member => member.name === "감스트")), 50);
});

test("삼국지 카드의 기량합계는 네 기량이 모두 있을 때만 사용한다", () => {
  const html = fs.readFileSync(path.join(__dirname, "../../public/index.html"), "utf8");

  assert.match(
    html,
    /function samgukGrowthScore\(member\) \{\s*return samgukCompleteTotal\(member, \['strength', 'agility', 'vitality', 'intelligence'\]\);\s*\}/,
  );
  assert.doesNotMatch(html, /function samgukGrowthScore\(member\)[\s\S]{0,200}powerScore/);
  assert.match(html, /기량 4종 완비/);
});

test("파워랭킹은 우리 시트의 관측 하한점수와 전투 관측을 표시하고 무력 fallback을 만들지 않는다", () => {
  const html = fs.readFileSync(path.join(__dirname, "../../public/index.html"), "utf8");

  assert.match(html, /data-samguktab="ranking"[^>]*>파워랭킹</);
  assert.match(html, /레벨·기량 30%/);
  assert.match(html, /장비 강화 35%/);
  assert.match(html, /각인 20%/);
  assert.match(html, /말 강화 15%/);
  assert.match(html, /member\.powerRankable/);
  assert.match(html, /member\.powerStatus === 'confirmed'/);
  assert.match(html, /member\.powerStatus === 'provisional'/);
  assert.match(html, /member\.powerIndex/);
  assert.match(html, /member\.powerRankScore/);
  assert.match(html, /const POWER_DISPLAY_MULTIPLIER = 125/);
  assert.match(html, /Math\.round\(number \* POWER_DISPLAY_MULTIPLIER\)/);
  assert.match(html, /현재 관측 파워랭킹/);
  assert.match(html, /확인된 구성요소의 하한점수/);
  assert.doesNotMatch(html, /coverage 85% 미만은 순위에서 제외/);
  assert.match(html, /빈칸은 관측된 0으로 바꾸거나/);
  assert.match(html, /주문서 재고는 아직 사용하지 않은 자원이므로 제외/);
  assert.match(html, /최대 HP/);
  assert.match(html, /평타/);
  assert.match(html, /파워 v1 미반영/);
  assert.match(html, /function samgukTextValue\(value, suffix\)/);
  const componentFunction = html.match(/function componentCell\(member, key\) \{[\s\S]*?\n  \}/)?.[0] || "";
  assert.match(componentFunction, /samgukTextValue/);
  assert.doesNotMatch(componentFunction, /samgukValue\(/);
  const rankingFunction = html.match(/function renderSamgukPowerRanking\(\) \{[\s\S]*?\n\}/)?.[0] || "";
  assert.doesNotMatch(rankingFunction, /member\.powerScore/);
  assert.doesNotMatch(rankingFunction, /scoreField.*strength/);
});

test("현황판과 파워랭킹은 같은 시트 payload를 쓰고 화면 복귀 시 즉시 갱신한다", () => {
  const client = fs.readFileSync(path.join(__dirname, "../../public/samguk.js"), "utf8");
  const html = fs.readFileSync(path.join(__dirname, "../../public/index.html"), "utf8");

  assert.match(client, /const REFRESH_INTERVAL_MS = 60 \* 1000/);
  assert.match(client, /function applyPayload\(data, mode\) \{[\s\S]*?mergeMembers\(data\.members\)/);
  assert.match(client, /currentSamgukTab === 'ranking'\) renderSamgukPowerRanking\(\)/);
  assert.match(client, /else renderSamguk\(\)/);
  assert.match(client, /setInterval\(function \(\) \{[\s\S]*?loadSamgukData\(true\)[\s\S]*?REFRESH_INTERVAL_MS/);
  assert.match(client, /document\.addEventListener\('visibilitychange',[\s\S]*?loadSamgukData\(true\)/);
  assert.match(html, /currentTab === 'samguk' && window\.loadSamgukData/);
  assert.match(html, /async function communityRefreshCurrentView\(\) \{\s*if \(currentTab === 'samguk'\)/);
  assert.match(html, /await window\.loadSamgukData\(true\)/);
});

test("참가자나 영토가 일부만 계산되면 정상 시트로 채택하지 않는다", async () => {
  const service = createSamgukSheetService({
    fetchImpl: googleFetch(sheetCsv()),
  });
  const payload = await service.load();
  assert.equal(payload.source, "fallback-seed");
  assert.equal(payload.stale, true);
  assert.equal(payload.members.length, 90);
  assert.equal(payload.territories.length, 60);
  assert.match(payload.warnings.join(" "), /1\/90명/);
});

test("/api/samguk은 encoded 응답을 60초 공유하고 ETag를 지원한다", async (t) => {
  let loads = 0;
  const payload = {
    source: "test",
    updatedAt: "2026-08-01T18:00:00.000Z",
    stale: false,
    sheetUrl: "https://docs.google.com/spreadsheets/d/test/edit",
    members: [],
    territories: [],
    rules: [],
    warnings: [],
  };
  const app = express();
  app.use("/api/samguk", createRouter({
    service: { load: async () => { loads += 1; return payload; } },
    ttlMs: 60_000,
  }));
  const server = await new Promise(resolve => {
    const instance = app.listen(0, () => resolve(instance));
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/samguk`;

  const first = await fetch(url, { headers: { "Accept-Encoding": "identity" } });
  assert.equal(first.status, 200);
  assert.match(first.headers.get("cache-control"), /s-maxage=60/);
  assert.match(first.headers.get("cdn-cache-control"), /stale-while-revalidate=300/);
  const etag = first.headers.get("etag");
  assert.deepEqual(Object.keys(await first.json()).sort(), PAYLOAD_KEYS);

  const second = await fetch(url, {
    headers: { "Accept-Encoding": "identity", "If-None-Match": etag },
  });
  assert.equal(second.status, 304);
  assert.equal(loads, 1);
});
