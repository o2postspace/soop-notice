const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const express = require("express");
const {
  DEFAULT_MAX_BYTES,
  createSamgukSheetService,
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
const MEMBER_KEYS = [
  "agility", "armor", "crew", "evidence", "helmet", "horse", "horseLevel", "intelligence", "job", "level",
  "name", "nation", "observedAt", "powerScore", "reviewStatus", "shoes", "soopId", "sourceCount",
  "sourceType", "strength", "verificationStatus", "vitality", "weapon",
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
  assert.deepEqual(Object.keys(result.members[0]).sort(), MEMBER_KEYS);
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

test("Google Sheet 세 탭을 읽어 정규 payload 계약으로 반환한다", async () => {
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
  assert.deepEqual(Object.keys(payload.members[0]).sort(), MEMBER_KEYS);
  assert.deepEqual(Object.keys(payload.territories[0]).sort(), TERRITORY_KEYS);
  assert.deepEqual(Object.keys(payload.rules[0]).sort(), RULE_KEYS);
  assert.equal(payload.territories[0].owner, "위");
  assert.equal(payload.territories[0].capital, true);
  assert.equal(payload.rules[0].title, "영토 수");
  assert.equal(state.urls.length, 3);
  assert.ok(state.urls.every(url => new URL(url).hostname === "docs.google.com"));
  assert.ok(state.urls.every(url => !url.includes("vercel.app")));
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

test("삼국지 카드의 기량합계는 네 기량만 사용한다", () => {
  const html = fs.readFileSync(path.join(__dirname, "../../public/index.html"), "utf8");

  assert.match(
    html,
    /function samgukGrowthScore\(member\) \{\s*return samgukPositiveTotal\(member, \['strength', 'agility', 'vitality', 'intelligence'\]\);\s*\}/,
  );
  assert.doesNotMatch(html, /function samgukGrowthScore\(member\)[\s\S]{0,200}powerScore/);
});

test("무력랭킹은 전체 데이터셋에서 무력점수와 무력 스탯 스케일을 섞지 않는다", () => {
  const html = fs.readFileSync(path.join(__dirname, "../../public/index.html"), "utf8");

  assert.match(html, /const scoreField = hasPowerScore \? 'powerScore' : 'strength';/);
  assert.match(html, /const scoreLabel = hasPowerScore \? '무력점수' : '무력 스탯';/);
  assert.match(html, /samgukNumber\(member\[scoreField\]\)/);
  assert.match(html, /무력 스탯과 점수 스케일은 섞지 않습니다/);
  assert.match(html, /별도 무력점수가 입력되기 전까지[^\n]+무력 스탯/);
  assert.doesNotMatch(html, /member\.powerScore\s*(?:\|\||\?\?)\s*member\.strength/);
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
