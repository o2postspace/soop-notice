"use strict";

const crypto = require("node:crypto");
const {
  EXPECTED_HEADERS: OBSERVATION_HEADERS,
  GOOGLE_SHEETS_SCOPE,
  GOOGLE_TOKEN_URI,
  readPrivateTokenFile,
} = require("./samguk-google-sheet-writer");

const SHEETS_API_ROOT = "https://sheets.googleapis.com/v4/spreadsheets";
const SEASON_ID = "hugukji-2026-08-04";
const DEFAULT_CUTOVER_AT = "2026-08-04T19:36:40+09:00";
const ROSTER_SOURCE_URL = "https://docs.google.com/spreadsheets/d/1zwIJjl2UTkPREkI37in9e0PAwX9xwFtEU3-ECAYYaeU/edit?gid=74847276#gid=74847276";
const BACKUP_MAX_ROWS_PER_SHEET = 100_000;
const BACKUP_MAX_COLUMNS_PER_SHEET = 512;
const BACKUP_MAX_CELLS_PER_SHEET = 2_000_000;
const BACKUP_MAX_TOTAL_CELLS = 8_000_000;

const VERIFIED_GAMCOM_MEMBER_SEED = Object.freeze({
  kind: "member",
  label: "Gamcom roster",
  rowCount: 90,
  identityKey: "nickname",
  sourceUrl: "https://gamcom-3kingdom.vercel.app/factions?season=2",
  collectedAt: "2026-08-04T11:54:47.294Z",
  contentSha256: "4d10865b43421480207c1b30b8a3539864e02a583bdbf6cbf576ddd76108b64f",
  canonicalSha256: "ac13445d4f0771dc2914e06c49535e23f66e83712d0d2912822a436845bd29d3",
  rowKeys: Object.freeze([
    "nation", "crew_name", "nickname", "job", "horse", "horse_level", "weapon", "helmet",
    "armor", "shoes", "stat_strength", "stat_agility", "stat_vitality", "stat_intelligence",
  ]),
});

const VERIFIED_GAMCOM_TERRITORY_SEED = Object.freeze({
  kind: "territory",
  label: "Gamcom territory",
  rowCount: 60,
  identityKey: "castleKey",
  sourceUrl: "https://gamcom-3kingdom.vercel.app/api/castles?fresh=1&season=2",
  collectedAt: "2026-08-04T11:54:47.294Z",
  contentSha256: "8534e87f86c97a6881b4704b7b9577c9b4e814fb9abbb93329b8c4f2bc91cb1b",
  canonicalSha256: "4fc3923d4f7927c28411a0a265a26c3f27fbce1b62a2d56a9d1edd1d52309195",
  rowKeys: Object.freeze([
    "castleKey", "name", "level", "owner", "isCapital", "isCheonrimun", "facilityType", "x", "y",
  ]),
});

const VERIFIED_GAMCOM_SEEDS = Object.freeze({
  member: VERIFIED_GAMCOM_MEMBER_SEED,
  territory: VERIFIED_GAMCOM_TERRITORY_SEED,
});
const EXPECTED_MASTER_SHEETS = Object.freeze([
  "사용법", "게임정보", "기준정보", "참가자", "방송모니터링", "관측입력",
  "현재현황", "장비현황", "무력랭킹", "외부참고", "영토입력", "영토현황", "OCR설정", "변경로그",
]);
const EXPECTED_PUBLIC_SHEETS = Object.freeze([
  "안내", "파워랭킹", "스탯·장비", "수정제안", "변경이력", "승인원장", "코드표",
]);

const HUGUKJI_ROSTER_BY_NATION = Object.freeze({
  위: Object.freeze([
    "조경훈", "박재박", "로기다", "표우", "공태연", "은초롱", "해솔", "다시바", "리피피", "윤이샘",
    "루루시", "시오", "비숑", "설채이", "푸마고치", "송소미", "슈니", "쥬멩이", "제리츄", "예요예요",
    "온유일", "뀨복", "쩜냥이", "찐랑", "김쁘피", "초금비", "아르르", "비쥬", "큐티섹시", "한비",
  ]),
  촉: Object.freeze([
    "감스트", "꾸티뉴", "엔쥬", "킴나니", "서라0", "난워니", "설이", "바먀", "야무지", "바밍",
    "단츄", "모야", "해리", "킹냥이", "다뮤", "앙또", "부르", "냥쏘", "니니", "유설아",
    "임민트", "망구랑", "앨리스얌", "김옥독", "유연서", "윤타미", "리카", "달묘", "란다", "딴딴2당",
  ]),
  오: Object.freeze([
    "지피티", "황원태", "홍타쿠", "김병살", "단수아", "따스히", "김쿼카", "딩굴", "현단아", "라무",
    "야뿌", "보리담", "린코", "연보라", "머라냥", "메루", "연치민", "모아", "모나양", "희꾸미",
    "고채린", "목츄리", "감초", "힙비", "싱유", "아린", "연우얌", "한아련", "채하", "류버들",
  ]),
});

const CURRENT_HEADERS = Object.freeze([
  "player_id", "국가", "세력/길드", "닉네임", "SOOP_ID", "장수/직업", "레벨", "말",
  "말강화", "무기강화", "두갑강화", "흉갑강화", "각갑강화", "장비총강화",
  "무력", "기민", "기력", "지모", "무력점수", "최종확인", "최근근거", "출처종류",
  "교차검증수", "검증상태", "신선도", "기량합계", "랭킹점수", "공동순위",
  "정렬순번", "선택원본행", "최대체력", "평타피해대표값", "평타표본수",
  "평타대상", "전투조건", "공격력", "체력", "현재장수", "방어력",
  "공격력증가(%)", "피해감소(%)", "치명타확률(%)", "치명타피해(%)",
  "스킬쿨타임감소(%)", "스킬피해증가(%)", "이동속도증가(%)", "말최대체력",
  "무력보너스", "기민보너스", "기력보너스", "지모보너스",
  "공격력증가량", "이동속도증가량", "체력증가량", "절기가속증가량", "절기배분",
]);

const PUBLIC_RANKING_HEADERS = Object.freeze([
  "순위", "player_id", "국가", "닉네임", "세력/길드", "장수/직업", "파워점수",
  "수집률", "상태", "레벨", "무력", "기민", "기력", "지모", "무기강화",
  "두갑강화", "흉갑강화", "각갑강화", "말", "말강화", "최대체력", "공격력",
  "최종확인", "SOOP 방송", "체력", "현재장수", "방어력", "공격력증가(%)",
  "피해감소(%)", "치명타확률(%)", "치명타피해(%)", "스킬쿨타임감소(%)",
  "스킬피해증가(%)", "이동속도증가(%)", "말최대체력", "무력보너스",
  "기민보너스", "기력보너스", "지모보너스", "공격력증가량", "이동속도증가량",
  "체력증가량", "절기가속증가량", "절기배분",
]);

const PUBLIC_DETAIL_HEADERS = Object.freeze([
  "player_id", "국가", "닉네임", "SOOP_ID", "세력/길드", "장수/직업", "레벨",
  "말", "말강화", "무기강화", "두갑강화", "흉갑강화", "각갑강화", "무력",
  "기민", "기력", "지모", "최대체력", "공격력", "평타피해", "파워점수",
  "수집률", "출처", "출처수", "검증상태", "최종확인", "근거", "체력",
  "현재장수", "방어력", "공격력증가(%)", "피해감소(%)", "치명타확률(%)",
  "치명타피해(%)", "스킬쿨타임감소(%)", "스킬피해증가(%)", "이동속도증가(%)",
  "말최대체력", "무력보너스", "기민보너스", "기력보너스", "지모보너스",
  "공격력증가량", "이동속도증가량", "체력증가량", "절기가속증가량", "절기배분",
]);

const MASTER_READ_RANGES = Object.freeze([
  "'게임정보'!A1:F30",
  "'참가자'!A1:J91",
  "'방송모니터링'!A1:P91",
  "'관측입력'!A1:AY5001",
  "'장비현황'!A1:R91",
  "'외부참고'!A1:X91",
  "'영토입력'!A1:T5001",
  "'영토현황'!A1:R61",
  "'변경로그'!A1:K501",
  "'현재현황'!A1:BD1",
]);

const MASTER_CLEAR_RANGES = Object.freeze([
  "참가자 A2:J → 실제 grid 마지막행",
  "방송모니터링 A2:P → 실제 grid 마지막행",
  "관측입력 A2:AY → 실제 grid 마지막행",
  "장비현황 C2:R → 실제 grid 마지막행",
  "외부참고 A2:X → 실제 grid 마지막행",
  "영토입력 A2:T → 실제 grid 마지막행",
  "영토현황 A2:R → 실제 grid 마지막행",
  "변경로그 A2:K → 실제 grid 마지막행",
  "현재현황 A2:BD → 실제 grid 마지막행",
]);

const PUBLIC_STATIC_HEADERS = Object.freeze({
  수정제안: Object.freeze([
    "proposal_id", "제출시각", "player_id", "닉네임", "field_key", "현재값", "제안값",
    "관측시각", "출처유형", "근거URL", "설명", "처리상태", "검수메모", "검수자",
    "검수시각", "master_observation_id", "master_row",
  ]),
  변경이력: Object.freeze([
    "처리시각", "proposal_id", "player_id", "닉네임", "field_key", "이전값", "제안값",
    "처리", "근거URL", "master_observation_id", "메모",
  ]),
  승인원장: Object.freeze([
    "record_id", "proposal_id", "player_id", "field_key", "value", "source_type",
    "evidence_url", "observed_at", "approved_at", "status", "master_observation_id",
    "master_row", "revoked_at", "revoke_reason", "schema_version",
  ]),
});

class SamgukSeasonResetError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "SamgukSeasonResetError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function fail(code, message) {
  throw new SamgukSeasonResetError(code, message);
}

function columnLetter(column) {
  if (!Number.isSafeInteger(column) || column < 1) throw new TypeError("column must be a positive integer");
  let value = column;
  let result = "";
  while (value > 0) {
    value -= 1;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result;
}

function sha256(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function sameKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function compareText(left, right) {
  const a = String(left ?? "");
  const b = String(right ?? "");
  return a < b ? -1 : a > b ? 1 : 0;
}

function canonicalSeedPayload(payload, contract) {
  const rows = [...payload.rows]
    .sort((left, right) => compareText(left?.[contract.identityKey], right?.[contract.identityKey]))
    .map(row => contract.rowKeys.map(key => row?.[key]));
  return {
    version: payload.version,
    seasonId: payload.seasonId,
    sourceUrl: payload.sourceUrl,
    collectedAt: payload.collectedAt,
    contentSha256: payload.contentSha256,
    rows,
  };
}

function canonicalValueMatrix(valueRangeOrRows) {
  const source = Array.isArray(valueRangeOrRows)
    ? valueRangeOrRows
    : normalizedRows(valueRangeOrRows);
  const rows = source.map(rawRow => {
    const row = Array.isArray(rawRow)
      ? rawRow.map(value => value === null || value === undefined ? "" : value)
      : [];
    while (row.length && row[row.length - 1] === "") row.pop();
    return row;
  });
  while (rows.length && rows[rows.length - 1].length === 0) rows.pop();
  return rows;
}

function assertExactValueMatrix(actual, expected, label) {
  const actualCanonical = canonicalValueMatrix(actual);
  const expectedCanonical = canonicalValueMatrix(expected);
  if (sha256(actualCanonical) !== sha256(expectedCanonical)) {
    fail("verification_failed", `${label} 전체 범위 read-back이 계획값과 다릅니다.`);
  }
}

function quoteSheetTitle(title) {
  return `'${String(title).replace(/'/g, "''")}'`;
}

function normalizedCell(row, index) {
  return String(row?.[index] ?? "").trim();
}

function safePreservedText(value, maximum, label) {
  const normalized = String(value ?? "").normalize("NFKC").trim();
  if (normalized.length > maximum || /[\u0000-\u001F\u007F]/.test(normalized)) {
    fail("invalid_sheet", `${label} 값이 올바르지 않습니다.`);
  }
  return /^[=+\-@]/.test(normalized) ? `'${normalized}` : normalized;
}

function validateSoopUrl(value, soopId, label) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    fail("invalid_roster", `${label} URL이 올바르지 않습니다.`);
  }
  const host = parsed.hostname.toLowerCase();
  let segments;
  try {
    segments = decodeURIComponent(parsed.pathname).split("/").filter(Boolean);
  } catch {
    fail("invalid_roster", `${label} URL path가 올바르지 않습니다.`);
  }
  const allowedHosts = new Set([
    "sooplive.com", "www.sooplive.com", "play.sooplive.com", "ch.sooplive.com",
    "sooplive.co.kr", "www.sooplive.co.kr", "play.sooplive.co.kr", "ch.sooplive.co.kr",
  ]);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || !allowedHosts.has(host)
      || !segments.some(segment => segment.toLowerCase() === soopId.toLowerCase())) {
    fail("invalid_roster", `${label} URL이 SOOP_ID와 다릅니다.`);
  }
  return parsed.toString();
}

function normalizedRows(valueRange) {
  return Array.isArray(valueRange?.values) ? valueRange.values : [];
}

function validateSheetId(value, label) {
  const normalized = String(value || "").trim();
  if (!/^[A-Za-z0-9_-]{20,128}$/.test(normalized)) fail("invalid_config", `${label} ID가 올바르지 않습니다.`);
  return normalized;
}

function validateCutoverAt(value) {
  const normalized = String(value || "").trim();
  const timestamp = Date.parse(normalized);
  if (!/^2026-08-0[4-9]T/.test(normalized) || !Number.isFinite(timestamp)) {
    fail("invalid_cutover", "후국지 cutover 시각은 2026-08-04 이후 ISO 8601 형식이어야 합니다.");
  }
  return normalized;
}

function sheetSerial(value) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) fail("invalid_cutover", "cutover 시각을 Google Sheet 날짜로 변환할 수 없습니다.");
  return timestamp / 86_400_000 + 25_569 + 9 / 24;
}

function sheetMap(metadata, expected, label) {
  if (!metadata || !Array.isArray(metadata.sheets)) fail("invalid_sheet", `${label} 메타데이터가 올바르지 않습니다.`);
  const byTitle = new Map();
  for (const sheet of metadata.sheets) {
    const properties = sheet?.properties;
    const title = String(properties?.title || "");
    if (!title || !Number.isSafeInteger(properties?.sheetId) || byTitle.has(title)) {
      fail("invalid_sheet", `${label} 탭 구조가 올바르지 않습니다.`);
    }
    byTitle.set(title, properties);
  }
  const missing = expected.filter(title => !byTitle.has(title));
  if (missing.length) fail("invalid_sheet", `${label} 필수 탭이 없습니다: ${missing.join(", ")}`);
  if (metadata.properties?.timeZone !== "Asia/Seoul") {
    fail("invalid_sheet", `${label} timezone은 Asia/Seoul이어야 합니다.`);
  }
  return byTitle;
}

function checkedGridBounds(properties, label, { minimumRows = 1, minimumColumns = 1 } = {}) {
  const rows = properties?.gridProperties?.rowCount;
  const columns = properties?.gridProperties?.columnCount;
  if (!Number.isSafeInteger(rows) || rows < minimumRows || rows > BACKUP_MAX_ROWS_PER_SHEET
      || !Number.isSafeInteger(columns) || columns < minimumColumns || columns > BACKUP_MAX_COLUMNS_PER_SHEET
      || rows * columns > BACKUP_MAX_CELLS_PER_SHEET) {
    fail("invalid_sheet", `${label} grid 크기가 안전 범위를 벗어났습니다.`);
  }
  return Object.freeze({ rows, columns });
}

function fullDataRange(sheets, title, lastColumn, { startRow = 2, minimumRows = 2 } = {}) {
  const properties = sheets.get(title);
  const bounds = checkedGridBounds(properties, title, { minimumRows, minimumColumns: 1 });
  return `${quoteSheetTitle(title)}!A${startRow}:${lastColumn}${bounds.rows}`;
}

function partialDataRange(sheets, title, firstColumn, lastColumn, { startRow = 2, minimumRows = 2 } = {}) {
  const properties = sheets.get(title);
  const bounds = checkedGridBounds(properties, title, { minimumRows, minimumColumns: 1 });
  return `${quoteSheetTitle(title)}!${firstColumn}${startRow}:${lastColumn}${bounds.rows}`;
}

function boundedReadRange(sheets, title, desiredColumns, { startRow = 1, minimumRows = 1 } = {}) {
  const properties = sheets.get(title);
  const bounds = checkedGridBounds(properties, title, { minimumRows, minimumColumns: 1 });
  return `${quoteSheetTitle(title)}!A${startRow}:${columnLetter(Math.min(desiredColumns, bounds.columns))}${bounds.rows}`;
}

function masterReadRanges(metadata) {
  const sheets = sheetMap(metadata, EXPECTED_MASTER_SHEETS, "운영원장");
  return [
    boundedReadRange(sheets, "게임정보", 6),
    boundedReadRange(sheets, "참가자", 10, { minimumRows: 91 }),
    boundedReadRange(sheets, "방송모니터링", 16, { minimumRows: 91 }),
    boundedReadRange(sheets, "관측입력", 51, { minimumRows: 92 }),
    boundedReadRange(sheets, "장비현황", 18, { minimumRows: 91 }),
    boundedReadRange(sheets, "외부참고", 24, { minimumRows: 91 }),
    boundedReadRange(sheets, "영토입력", 20, { minimumRows: 62 }),
    boundedReadRange(sheets, "영토현황", 18, { minimumRows: 61 }),
    boundedReadRange(sheets, "변경로그", 11),
    boundedReadRange(sheets, "현재현황", 56, { minimumRows: 91 }),
  ];
}

function validateHeader(row, expected, label, { allowMissingLast = false } = {}) {
  const actual = Array.isArray(row) ? row.map(value => String(value ?? "").trim()) : [];
  const minimum = allowMissingLast ? expected.length - 1 : expected.length;
  if (actual.length < minimum || actual.length > expected.length) fail("invalid_sheet", `${label} 헤더 폭이 다릅니다.`);
  for (let index = 0; index < actual.length; index += 1) {
    if (actual[index] !== expected[index]) fail("invalid_sheet", `${label} ${index + 1}번째 헤더가 다릅니다.`);
  }
}

function buildCanonicalRosterMap() {
  const result = new Map();
  for (const [nation, names] of Object.entries(HUGUKJI_ROSTER_BY_NATION)) {
    if (names.length !== 30) fail("invalid_roster_contract", `${nation} 후국지 명단은 30명이어야 합니다.`);
    for (const name of names) {
      if (result.has(name)) fail("invalid_roster_contract", `후국지 명단에 중복 닉네임이 있습니다: ${name}`);
      result.set(name, nation);
    }
  }
  if (result.size !== 90) fail("invalid_roster_contract", "후국지 명단은 정확히 90명이어야 합니다.");
  return result;
}

function prepareParticipants(valueRange) {
  const rows = normalizedRows(valueRange);
  validateHeader(rows[0] || [], [
    "player_id", "국가", "세력/길드", "닉네임", "SOOP_ID", "장수/직업",
    "활동상태", "프로필URL", "방송URL", "메모",
  ], "참가자");
  const data = rows.slice(1).filter(row => normalizedCell(row, 0));
  if (data.length !== 90) fail("invalid_roster", `참가자는 90명이어야 합니다 (현재 ${data.length}명).`);
  const canonical = buildCanonicalRosterMap();
  const seenIds = new Set();
  const seenNames = new Set();
  const seenSoopIds = new Set();
  const output = data.map((row, index) => {
    const playerId = normalizedCell(row, 0);
    const nation = normalizedCell(row, 1);
    const name = normalizedCell(row, 3);
    const soopId = normalizedCell(row, 4);
    if (!/^P\d{3}$/.test(playerId) || seenIds.has(playerId)) fail("invalid_roster", `player_id를 확인하세요: ${playerId}`);
    if (canonical.get(name) !== nation || seenNames.has(name)) fail("roster_mismatch", `후국지 명단/국가와 다릅니다: ${name}`);
    if (!/^[A-Za-z0-9_]{1,30}$/.test(soopId) || seenSoopIds.has(soopId.toLowerCase())) {
      fail("invalid_roster", `SOOP_ID를 확인하세요: ${name}`);
    }
    seenIds.add(playerId);
    seenNames.add(name);
    seenSoopIds.add(soopId.toLowerCase());
    const profileUrl = validateSoopUrl(normalizedCell(row, 7), soopId, `${name} 프로필`)
      || `https://www.sooplive.com/${soopId}`;
    const broadcastUrl = validateSoopUrl(normalizedCell(row, 8), soopId, `${name} 방송`)
      || `https://play.sooplive.com/${soopId}`;
    return [
      playerId,
      nation,
      "",
      name,
      soopId,
      "",
      "활동",
      profileUrl,
      broadcastUrl,
      `후국지 명단 확인 · 2026-08-04 · ${ROSTER_SOURCE_URL}`,
    ];
  });
  if (seenNames.size !== canonical.size || [...canonical.keys()].some(name => !seenNames.has(name))) {
    fail("roster_mismatch", "후국지 90명 명단과 참가자 집합이 다릅니다.");
  }
  const expectedIds = Array.from({ length: 90 }, (_, index) => `P${String(index + 1).padStart(3, "0")}`);
  if (expectedIds.some(playerId => !seenIds.has(playerId))) {
    fail("invalid_roster", "player_id는 P001~P090 exact-set이어야 합니다.");
  }
  return output;
}

function normalizeGamcomNation(value) {
  const normalized = String(value || "").trim();
  if (["위", "위나라"].includes(normalized)) return "위";
  if (["촉", "촉나라"].includes(normalized)) return "촉";
  if (["오", "오나라"].includes(normalized)) return "오";
  return null;
}

function validateGamcomEnvelope(payload, contract, cutoverAt) {
  const envelopeKeys = ["version", "seasonId", "sourceUrl", "collectedAt", "contentSha256", "rows"];
  if (!sameKeys(payload, envelopeKeys) || payload.version !== 1 || payload.seasonId !== SEASON_ID
      || !Array.isArray(payload.rows) || payload.rows.length !== contract.rowCount
      || payload.sourceUrl !== contract.sourceUrl || payload.collectedAt !== contract.collectedAt
      || payload.contentSha256 !== contract.contentSha256) {
    fail("invalid_seed", `${contract.label} seed envelope가 검증된 season=2 스냅샷과 다릅니다.`);
  }
  let source;
  try {
    source = new URL(payload.sourceUrl);
  } catch {
    fail("invalid_seed", `${contract.label} sourceUrl이 올바르지 않습니다.`);
  }
  if (source.protocol !== "https:" || source.username || source.password
      || source.hostname !== "gamcom-3kingdom.vercel.app"
      || source.searchParams.get("season") !== "2") {
    fail("invalid_seed", `${contract.label} sourceUrl은 Gamcom season=2여야 합니다.`);
  }
  const collectedAt = Date.parse(payload.collectedAt);
  if (!Number.isFinite(collectedAt) || collectedAt < Date.parse(cutoverAt) || collectedAt > Date.now() + 5 * 60_000) {
    fail("invalid_seed", `${contract.label} collectedAt은 cutover 이후여야 합니다.`);
  }
  if (sha256(canonicalSeedPayload(payload, contract)) !== contract.canonicalSha256) {
    fail("invalid_seed", `${contract.label} envelope/rows 결정적 hash가 검증값과 다릅니다.`);
  }
  return Object.freeze({
    sourceUrl: source.toString(),
    collectedAt: payload.collectedAt,
    canonicalSha256: contract.canonicalSha256,
  });
}

function validateVerifiedGamcomSeed(payload, kind, cutoverAt = DEFAULT_CUTOVER_AT) {
  const contract = VERIFIED_GAMCOM_SEEDS[kind];
  if (!contract) fail("invalid_seed", "알 수 없는 Gamcom seed 종류입니다.");
  return validateGamcomEnvelope(payload, contract, validateCutoverAt(cutoverAt));
}

function nullableSeedInteger(value, maximum, label) {
  if (value === null || value === undefined || value === "") return "";
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) fail("invalid_seed", `${label} 값이 올바르지 않습니다.`);
  return value;
}

function safeSeedText(value, maximum, label, { nullable = false } = {}) {
  if (nullable && (value === null || value === undefined || value === "")) return "";
  const normalized = String(value || "").normalize("NFKC").trim();
  if (!normalized || normalized.length > maximum || /[\u0000-\u001F\u007F]/.test(normalized)) {
    fail("invalid_seed", `${label} 값이 올바르지 않습니다.`);
  }
  return /^[=+\-@]/.test(normalized) ? `'${normalized}` : normalized;
}

function prepareGamcomMemberSeed(payload, participants, cutoverAt) {
  if (!payload) return Object.freeze({ participants, observations: [], externalReferences: [] });
  const envelope = validateGamcomEnvelope(payload, VERIFIED_GAMCOM_MEMBER_SEED, cutoverAt);
  const byName = new Map(participants.map(row => [row[3], row]));
  const seen = new Set();
  const collectedSerial = sheetSerial(envelope.collectedAt);
  const observations = [];
  const externalReferences = [];
  const overrides = new Map();
  for (const raw of payload.rows) {
    if (!sameKeys(raw, VERIFIED_GAMCOM_MEMBER_SEED.rowKeys)) {
      fail("invalid_seed", "Gamcom roster row schema가 올바르지 않습니다.");
    }
    const name = safeSeedText(raw.nickname, 80, "nickname");
    const member = byName.get(name);
    const nation = normalizeGamcomNation(raw.nation);
    if (!member || member[1] !== nation || seen.has(name)) fail("invalid_seed", `Gamcom roster identity가 다릅니다: ${name}`);
    seen.add(name);
    const crew = safeSeedText(raw.crew_name, 120, `${name} crew_name`);
    const job = safeSeedText(raw.job, 80, `${name} job`);
    const horse = safeSeedText(raw.horse, 80, `${name} horse`, { nullable: true });
    const horseLevel = nullableSeedInteger(raw.horse_level, 80, `${name} horse_level`);
    const weapon = nullableSeedInteger(raw.weapon, 15, `${name} weapon`);
    const helmet = nullableSeedInteger(raw.helmet, 15, `${name} helmet`);
    const armor = nullableSeedInteger(raw.armor, 15, `${name} armor`);
    const shoes = nullableSeedInteger(raw.shoes, 15, `${name} shoes`);
    const strength = nullableSeedInteger(raw.stat_strength, 1_000_000, `${name} stat_strength`);
    const agility = nullableSeedInteger(raw.stat_agility, 1_000_000, `${name} stat_agility`);
    const vitality = nullableSeedInteger(raw.stat_vitality, 1_000_000, `${name} stat_vitality`);
    const intelligence = nullableSeedInteger(raw.stat_intelligence, 1_000_000, `${name} stat_intelligence`);
    overrides.set(name, { crew, job });
    const sequence = String(observations.length + 1).padStart(3, "0");
    const observation = new Array(OBSERVATION_HEADERS.length).fill("");
    observation[0] = `INIT-HUGUKJI-GAMCOM-${sequence}`;
    observation[1] = member[0];
    observation[2] = collectedSerial;
    observation[3] = "Gamcom";
    observation[4] = envelope.sourceUrl;
    observation[6] = horse;
    observation[7] = horseLevel;
    observation[8] = weapon;
    observation[9] = helmet;
    observation[10] = armor;
    observation[11] = shoes;
    observation[12] = strength;
    observation[13] = agility;
    observation[14] = vitality;
    observation[15] = intelligence;
    observation[17] = 1;
    observation[18] = "기준값";
    observation[19] = payload.contentSha256;
    observation[20] = "INIT-HUGUKJI-GAMCOM";
    observation[21] = "후국지 전환기";
    observation[23] = "Gamcom season=2 초기 기준 스냅샷";
    observation[29] = collectedSerial;
    observations.push(observation);
    externalReferences.push([
      member[0], member[4], nation, crew, name, job, horse, horseLevel,
      weapon, helmet, armor, shoes, strength, agility, vitality, intelligence,
      "말,말강화,장비강화,기량", "N", collectedSerial, collectedSerial, collectedSerial,
      envelope.sourceUrl, "후국지 season=2 초기 기준", "검증된 90명 exact-set seed",
    ]);
  }
  if (seen.size !== 90 || [...byName.keys()].some(name => !seen.has(name))) {
    fail("invalid_seed", "Gamcom roster는 후국지 90명 exact-set이어야 합니다.");
  }
  const enriched = participants.map(row => {
    const override = overrides.get(row[3]);
    const copy = [...row];
    copy[2] = override.crew;
    copy[5] = override.job;
    copy[9] = `후국지 Gamcom season=2 확인 · ${envelope.collectedAt}`;
    return copy;
  });
  return Object.freeze({ participants: enriched, observations, externalReferences });
}

function prepareMonitoring(valueRange, participants) {
  const rows = normalizedRows(valueRange);
  validateHeader(rows[0] || [], [
    "player_id", "국가", "세력/길드", "닉네임", "SOOP_ID", "방송링크",
    "방송상태", "방송제목", "시청자", "모니터링상태", "화면/창번호",
    "해상도", "OCR프로필", "상태확인시각", "담당자", "메모",
  ], "방송모니터링");
  const data = rows.slice(1);
  const byId = new Map(data.filter(row => normalizedCell(row, 0)).map(row => [normalizedCell(row, 0), row]));
  if (byId.size !== 90) fail("invalid_monitoring", "방송모니터링 identity는 정확히 90명이어야 합니다.");
  return participants.map(member => {
    const previous = byId.get(member[0]);
    if (!previous || normalizedCell(previous, 3) !== member[3] || normalizedCell(previous, 4) !== member[4]) {
      fail("invalid_monitoring", `방송모니터링 identity가 참가자와 다릅니다: ${member[0]}`);
    }
    return [
      member[0], member[1], member[2], member[3], member[4],
      member[8],
      "확인필요", "", "", "대기", "", "",
      safePreservedText(normalizedCell(previous, 12), 80, `${member[3]} OCR프로필`) || "default",
      "", safePreservedText(normalizedCell(previous, 14), 120, `${member[3]} 담당자`), "후국지 전환 초기화",
    ];
  });
}

function prepareTerritoryBaseline(valueRange, cutoverAt, gamcomPayload = null) {
  const rows = normalizedRows(valueRange);
  validateHeader(rows[0] || [], [
    "territory_observation_id", "영토ID", "확인시각", "근거종류", "근거(URL/타임코드)",
    "번호", "X", "Y", "소유국", "수도", "시설", "레벨", "특수지", "점령상태",
    "점령률", "검증상태", "교차검증수", "증거해시", "메모", "입력시각",
  ], "영토입력");
  const initialById = new Map();
  for (const row of rows.slice(1)) {
    const observationId = normalizedCell(row, 0);
    const territoryId = normalizedCell(row, 1);
    if (!observationId.startsWith("TINIT-") || !territoryId || initialById.has(territoryId)) continue;
    const number = Number(row[5]);
    const x = Number(row[6]);
    const y = Number(row[7]);
    const capital = normalizedCell(row, 9);
    const facility = normalizedCell(row, 10);
    const level = Number(row[11]);
    const special = normalizedCell(row, 12);
    if (!Number.isSafeInteger(number) || number < 1 || number > 60
        || !Number.isFinite(x) || x < 0 || !Number.isFinite(y) || y < 0
        || !["Y", "N"].includes(capital) || !facility
        || !Number.isFinite(level) || level < 0 || !["Y", "N"].includes(special)) {
      fail("invalid_territory", `영토 static topology를 확인하세요: ${territoryId}`);
    }
    initialById.set(territoryId, { territoryId, number, x, y, capital, facility, level, special });
  }
  if (initialById.size !== 60) fail("invalid_territory", `TINIT static topology는 60개여야 합니다 (현재 ${initialById.size}개).`);
  const topology = [...initialById.values()].sort((left, right) => left.number - right.number);
  const numbers = new Set(topology.map(item => item.number));
  if (numbers.size !== 60 || topology.some((item, index) => item.number !== index + 1)) {
    fail("invalid_territory", "영토 번호는 1~60이 정확히 한 번씩 있어야 합니다.");
  }
  let seedById = null;
  let sourceUrl = ROSTER_SOURCE_URL;
  let observedAt = cutoverAt;
  if (gamcomPayload) {
    const envelope = validateGamcomEnvelope(gamcomPayload, VERIFIED_GAMCOM_TERRITORY_SEED, cutoverAt);
    seedById = new Map();
    for (const raw of gamcomPayload.rows) {
      if (!sameKeys(raw, VERIFIED_GAMCOM_TERRITORY_SEED.rowKeys)) {
        fail("invalid_seed", "Gamcom territory row schema가 올바르지 않습니다.");
      }
      const territoryId = safeSeedText(raw.castleKey, 80, "castleKey");
      const number = Number(raw.name);
      const item = initialById.get(territoryId);
      const owner = normalizeGamcomNation(raw.owner) || (String(raw.owner).trim() === "미점령" ? "미점령" : null);
      const level = nullableSeedInteger(raw.level, 999, `${territoryId} level`);
      const facility = safeSeedText(raw.facilityType, 40, `${territoryId} facilityType`);
      if (!item || seedById.has(territoryId) || raw.name !== String(item.number)
          || !Number.isSafeInteger(number) || number !== item.number
          || raw.x !== item.x || raw.y !== item.y || level === "" || !owner
          || typeof raw.isCapital !== "boolean" || typeof raw.isCheonrimun !== "boolean") {
        fail("invalid_seed", `Gamcom territory topology/owner가 다릅니다: ${territoryId}`);
      }
      seedById.set(territoryId, {
        owner,
        capital: raw.isCapital ? "Y" : "N",
        special: raw.isCheonrimun ? "Y" : "N",
        facility,
        level,
      });
    }
    if (seedById.size !== 60) fail("invalid_seed", "Gamcom territory는 60개 exact-set이어야 합니다.");
    const capitals = topology.filter(item => seedById.get(item.territoryId).capital === "Y");
    const owned = topology.filter(item => seedById.get(item.territoryId).owner !== "미점령");
    const special = topology.filter(item => seedById.get(item.territoryId).special === "Y");
    const expectedCapitalOwners = new Map([[8, "위"], [42, "촉"], [47, "오"]]);
    const expectedOwners = new Map([[8, "위"], [33, "촉"], [42, "촉"], [47, "오"]]);
    if (capitals.length !== 3 || owned.length !== 4 || special.length !== 0
        || topology.some(item => {
          const seed = seedById.get(item.territoryId);
          const expectedOwner = expectedOwners.get(item.number) || "미점령";
          return seed.capital !== (expectedCapitalOwners.has(item.number) ? "Y" : "N")
            || seed.owner !== expectedOwner;
        })) {
      fail("invalid_seed", "Gamcom 영토는 8/33/42/47 소유, 각 국가 수도 3개, 특수지 0개여야 합니다.");
    }
    sourceUrl = envelope.sourceUrl;
    observedAt = envelope.collectedAt;
  }
  const observedSerial = sheetSerial(observedAt);
  return topology.map(item => [
    `TINIT-HUGUKJI-20260804-${String(item.number).padStart(3, "0")}`,
    item.territoryId,
    observedSerial,
    seedById ? "Gamcom" : "시트",
    sourceUrl,
    item.number,
    item.x,
    item.y,
    seedById ? seedById.get(item.territoryId).owner : "미점령",
    seedById ? seedById.get(item.territoryId).capital : item.capital,
    seedById ? seedById.get(item.territoryId).facility : item.facility,
    seedById ? seedById.get(item.territoryId).level : item.level,
    seedById ? seedById.get(item.territoryId).special : item.special,
    seedById && seedById.get(item.territoryId).owner !== "미점령" ? "점령" : "미점령",
    "",
    "기준값",
    1,
    "",
    seedById ? "후국지 Gamcom season=2 초기 영토 baseline" : "후국지 시즌 시작 baseline · 소유/점령 초기화",
    observedSerial,
  ]);
}

function latestSnapshotRowFormula(sheetName, keyColumn, statusColumn, timestampColumn, row) {
  const sheet = quoteSheetTitle(sheetName);
  const keyRange = `${sheet}!$${keyColumn}$2:$${keyColumn}$5001`;
  const statusRange = `${sheet}!$${statusColumn}$2:$${statusColumn}$5001`;
  const timestampRange = `${sheet}!$${timestampColumn}$2:$${timestampColumn}$5001`;
  const rowRange = `ROW(${keyRange})`;
  const accepted = `((${statusRange}="기준값")+(${statusRange}="교차검증")+(${statusRange}="방송교차검증"))>0`;
  const maximum = `MAX(FILTER(${timestampRange},${keyRange}=$A${row},${accepted}))`;
  const filtered = `FILTER(${rowRange},${keyRange}=$A${row},${accepted},${timestampRange}=${maximum})`;
  return `=IFERROR(INDEX(${filtered},ROWS(${filtered})),"")`;
}

function snapshotValueFormula(row, selectedColumn, sourceColumn) {
  const selected = `$${selectedColumn}${row}`;
  const value = `INDEX('관측입력'!$${sourceColumn}:$${sourceColumn},${selected})`;
  return `=IF(${selected}="","",IF(${value}="","",${value}))`;
}

function maxAcceptedValueFormula(row, sourceColumn) {
  const keyRange = "'관측입력'!$B$2:$B$5001";
  const statusRange = "'관측입력'!$S$2:$S$5001";
  const valueRange = `'관측입력'!$${sourceColumn}$2:$${sourceColumn}$5001`;
  const accepted = `((${statusRange}="기준값")+(${statusRange}="교차검증")+(${statusRange}="방송교차검증"))>0`;
  return `=IFERROR(MAX(FILTER(${valueRange},${keyRange}=$A${row},${accepted},${valueRange}<>"")),"")`;
}

function latestAcceptedNonBlankFormula(row, sourceColumn) {
  const keyRange = "'관측입력'!$B$2:$B$5001";
  const statusRange = "'관측입력'!$S$2:$S$5001";
  const timestampRange = "'관측입력'!$C$2:$C$5001";
  const valueRange = `'관측입력'!$${sourceColumn}$2:$${sourceColumn}$5001`;
  const rowRange = `ROW(${keyRange})`;
  const accepted = `((${statusRange}="기준값")+(${statusRange}="교차검증")+(${statusRange}="방송교차검증"))>0`;
  const maximum = `MAX(FILTER(${timestampRange},${keyRange}=$A${row},${accepted},${valueRange}<>""))`;
  const filtered = `FILTER(${rowRange},${keyRange}=$A${row},${accepted},${timestampRange}=${maximum},${valueRange}<>"")`;
  return `=IFERROR(INDEX('관측입력'!$${sourceColumn}:$${sourceColumn},INDEX(${filtered},ROWS(${filtered}))),"")`;
}

function buildCurrentRows() {
  const sourceColumns = {
    7: "F", 8: "G", 9: "H", 10: "I", 11: "J", 12: "K", 13: "L",
    15: "M", 16: "N", 17: "O", 18: "P", 19: "Q", 20: "C", 21: "E",
    22: "D", 23: "R", 24: "S", 31: "Y", 32: "Z", 33: "AA", 34: "AB", 35: "AC",
    36: "AE", 37: "AF", 38: "AG", 39: "AH", 40: "AI", 41: "AJ",
    42: "AK", 43: "AL", 44: "AM", 45: "AN", 46: "AO", 47: "AP",
    48: "AQ", 49: "AR", 50: "AS", 51: "AT", 52: "AU", 53: "AV",
    54: "AW", 55: "AX", 56: "AY",
  };
  const monotonicColumns = new Map(Object.entries({
    7: "F", 9: "H", 10: "I", 11: "J", 12: "K", 13: "L",
    15: "M", 16: "N", 17: "O", 18: "P", 19: "Q", 31: "Y", 32: "Z",
    33: "AA", 36: "AE",
  }).map(([key, value]) => [Number(key), value]));
  const rows = [];
  for (let row = 2; row <= 91; row += 1) {
    const values = new Array(56).fill("");
    values[0] = `=IF('참가자'!A${row}="","",'참가자'!A${row})`;
    for (let column = 2; column <= 6; column += 1) {
      const letter = columnLetter(column);
      values[column - 1] = `=IF('참가자'!${letter}${row}="","",'참가자'!${letter}${row})`;
    }
    values[29] = latestSnapshotRowFormula("관측입력", "B", "S", "C", row);
    for (const [columnText, sourceColumn] of Object.entries(sourceColumns)) {
      const targetColumn = Number(columnText);
      values[targetColumn - 1] = targetColumn === 56
        ? latestAcceptedNonBlankFormula(row, sourceColumn)
        : monotonicColumns.has(targetColumn)
          ? maxAcceptedValueFormula(row, monotonicColumns.get(targetColumn))
          : snapshotValueFormula(row, "AD", sourceColumn);
    }
    values[13] = `=IF(COUNT(J${row}:M${row})=0,"",SUM(J${row}:M${row}))`;
    values[24] = `=IF(T${row}="","미확인",IF(NOW()-T${row}<=1/24,"최신",IF(NOW()-T${row}<=6/24,"확인 필요","오래됨")))`;
    values[25] = `=IF(COUNT(O${row}:R${row})=0,"",SUM(O${row}:R${row}))`;
    values[26] = `=IF(S${row}<>"",S${row},O${row})`;
    values[27] = `=IF(OR(AA${row}="",AA${row}<=0),"",RANK.EQ(AA${row},$AA$2:$AA$91,0))`;
    values[28] = `=IF(OR(AA${row}="",AA${row}<=0),"",RANK.EQ(AA${row},$AA$2:$AA$91,0)+COUNTIF($AA$2:AA${row},AA${row})-1)`;
    rows.push(values);
  }
  return rows;
}

function buildTerritoryCurrentRows(territories) {
  if (!Array.isArray(territories) || territories.length !== 60) {
    fail("invalid_territory", "영토현황 수식에는 정확히 60개 영토가 필요합니다.");
  }
  const sourceColumns = {
    2: "F", 3: "G", 4: "H", 5: "I", 6: "J", 7: "K", 8: "L", 9: "M",
    10: "N", 11: "O", 12: "C", 13: "E", 14: "D", 15: "Q", 16: "P", 17: "S",
  };
  return territories.map((territory, index) => {
    const row = index + 2;
    const values = new Array(18).fill("");
    values[0] = territory[1];
    values[17] = latestSnapshotRowFormula("영토입력", "B", "P", "C", row);
    for (const [columnText, sourceColumn] of Object.entries(sourceColumns)) {
      values[Number(columnText) - 1] = snapshotValueFormula(row, "R", sourceColumn)
        .replaceAll("'관측입력'!", "'영토입력'!");
    }
    return values;
  });
}

function findGameInfoRow(valueRange) {
  const rows = normalizedRows(valueRange);
  validateHeader(rows[0] || [], ["분류", "항목", "내용", "출처URL", "기준일", "검수상태"], "게임정보");
  const matches = [];
  for (let index = 1; index < rows.length; index += 1) {
    if (normalizedCell(rows[index], 0) === "서버 개요") matches.push(index + 1);
  }
  if (matches.length !== 1) fail("invalid_rules", "게임정보의 서버 개요 행은 정확히 하나여야 합니다.");
  return matches[0];
}

function findLegacySpecialRuleRow(valueRange) {
  const rows = normalizedRows(valueRange);
  const matches = [];
  for (let index = 1; index < rows.length; index += 1) {
    const text = rows[index].map(value => String(value ?? "")).join(" ");
    if (/27번|특수\s*영토/.test(text)) matches.push(index + 1);
  }
  if (matches.length > 1) fail("invalid_rules", "게임정보의 legacy 특수 영토 행이 둘 이상입니다.");
  return matches[0] || null;
}

function findSeasonMarkerRow(valueRange, maximumRow) {
  const rows = normalizedRows(valueRange);
  const matches = [];
  for (let index = 1; index < maximumRow; index += 1) {
    if (normalizedCell(rows[index], 1) === "season_id") matches.push(index + 1);
  }
  if (matches.length > 1) fail("invalid_rules", "게임정보 season_id 행은 하나 이하여야 합니다.");
  if (matches.length === 1) return matches[0];
  for (let index = 1; index < maximumRow; index += 1) {
    const row = rows[index] || [];
    if (![0, 1, 2, 3, 4, 5].some(column => normalizedCell(row, column))) return index + 1;
  }
  fail("invalid_rules", "게임정보에 season_id marker를 기록할 빈 행이 없습니다.");
}

function prepareMasterState(metadata, valueRanges, cutoverAt, seeds = {}) {
  const sheets = sheetMap(metadata, EXPECTED_MASTER_SHEETS, "운영원장");
  if (!Array.isArray(valueRanges) || valueRanges.length !== MASTER_READ_RANGES.length) {
    fail("invalid_sheet", "운영원장 preflight 범위 응답이 올바르지 않습니다.");
  }
  const baseParticipants = prepareParticipants(valueRanges[1]);
  const gamcom = prepareGamcomMemberSeed(seeds.gamcomMemberSeed, baseParticipants, cutoverAt);
  const participants = gamcom.participants;
  const monitoring = prepareMonitoring(valueRanges[2], participants);
  validateHeader(normalizedRows(valueRanges[3])[0] || [], OBSERVATION_HEADERS, "관측입력", { allowMissingLast: true });
  validateHeader(normalizedRows(valueRanges[4])[0] || [], [
    "닉네임", "SOOP_ID", "무기각인1", "무기각인2", "무기각인3",
    "두갑각인1", "두갑각인2", "두갑각인3", "흉갑각인1", "흉갑각인2", "흉갑각인3",
    "각갑각인1", "각갑각인2", "각갑각인3", "최종확인", "최근근거", "출처종류", "교차검증수",
  ], "장비현황");
  validateHeader(normalizedRows(valueRanges[5])[0] || [], [
    "player_id", "SOOP_ID", "국가", "세력/길드", "닉네임", "장수/직업",
    "말", "말강화", "무기강화", "두갑강화", "흉갑강화", "각갑강화",
    "무력", "기민", "기력", "지모", "채택필드", "우리값유지",
    "우리기준확인", "외부수집시각", "외부갱신시각", "출처URL", "적용정책", "주의",
  ], "외부참고");
  const territories = prepareTerritoryBaseline(valueRanges[6], cutoverAt, seeds.gamcomTerritorySeed);
  validateHeader(normalizedRows(valueRanges[7])[0] || [], [
    "영토ID", "번호", "X", "Y", "소유국", "수도", "시설", "레벨", "특수지",
    "점령상태", "점령률", "최종확인", "근거", "출처종류", "교차검증수",
    "검증상태", "메모", "선택원본행",
  ], "영토현황");
  validateHeader(normalizedRows(valueRanges[8])[0] || [], [
    "change_id", "승격시각", "확인시각", "player_id", "항목", "이전값", "새값",
    "근거", "출처", "교차검증수", "observation_id",
  ], "변경로그");
  validateHeader(normalizedRows(valueRanges[9])[0] || [], CURRENT_HEADERS, "현재현황", { allowMissingLast: true });
  const gameInfoRow = findGameInfoRow(valueRanges[0]);
  const gameInfoSpecialRow = findLegacySpecialRuleRow(valueRanges[0]);
  const gameInfoSeasonRow = findSeasonMarkerRow(
    valueRanges[0],
    checkedGridBounds(sheets.get("게임정보"), "게임정보", { minimumRows: 2 }).rows,
  );
  return Object.freeze({
    sheets,
    participants,
    monitoring,
    territories,
    gameInfoRow,
    gameInfoSpecialRow,
    gameInfoSeasonRow,
    observations: gamcom.observations,
    externalReferences: gamcom.externalReferences,
    seededFromGamcom: Boolean(seeds.gamcomMemberSeed),
    territorySeededFromGamcom: Boolean(seeds.gamcomTerritorySeed),
  });
}

function publicReadRanges(metadata) {
  const sheets = sheetMap(metadata, EXPECTED_PUBLIC_SHEETS, "공개시트");
  const ranges = ["'안내'!A1:B16"];
  for (const [title, width] of [
    ["파워랭킹", PUBLIC_RANKING_HEADERS.length],
    ["스탯·장비", PUBLIC_DETAIL_HEADERS.length],
    ["수정제안", PUBLIC_STATIC_HEADERS.수정제안.length],
    ["변경이력", PUBLIC_STATIC_HEADERS.변경이력.length],
    ["승인원장", PUBLIC_STATIC_HEADERS.승인원장.length],
    ["코드표", 9],
  ]) {
    const rowCount = sheets.get(title).gridProperties?.rowCount;
    if (!Number.isSafeInteger(rowCount) || rowCount < 2 || rowCount > 100_000) {
      fail("invalid_sheet", `공개시트 ${title} 행 크기를 확인하세요.`);
    }
    ranges.push(`'${title}'!A1:${columnLetter(width)}${rowCount}`);
  }
  return { sheets, ranges };
}

function preparePublicState(metadata, valueRanges) {
  const { sheets, ranges } = publicReadRanges(metadata);
  if (!Array.isArray(valueRanges) || valueRanges.length !== ranges.length) {
    fail("invalid_sheet", "공개시트 preflight 범위 응답이 올바르지 않습니다.");
  }
  if (!/^SOOPNOTICE (?:삼국지|후국지) 공개 현황$/.test(normalizedCell(normalizedRows(valueRanges[0])[0], 0))) {
    fail("invalid_sheet", "공개 안내 header가 다릅니다.");
  }
  validateHeader(normalizedRows(valueRanges[1])[0] || [], PUBLIC_RANKING_HEADERS, "공개 파워랭킹", { allowMissingLast: true });
  validateHeader(normalizedRows(valueRanges[2])[0] || [], PUBLIC_DETAIL_HEADERS, "공개 스탯·장비", { allowMissingLast: true });
  validateHeader(normalizedRows(valueRanges[3])[0] || [], PUBLIC_STATIC_HEADERS.수정제안, "공개 수정제안");
  validateHeader(normalizedRows(valueRanges[4])[0] || [], PUBLIC_STATIC_HEADERS.변경이력, "공개 변경이력");
  validateHeader(normalizedRows(valueRanges[5])[0] || [], PUBLIC_STATIC_HEADERS.승인원장, "공개 승인원장");
  validateHeader(normalizedRows(valueRanges[6])[0] || [], [
    "player_id", "닉네임", "SOOP_ID", "국가", "", "field_key", "표시명", "상한", "정수",
  ], "공개 코드표");
  const guideRows = Array.from({ length: 16 }, (_, index) => {
    const row = normalizedRows(valueRanges[0])[index] || [];
    return [0, 1].map(column => {
      const value = row[column] ?? "";
      return typeof value === "string" ? value.replaceAll("삼국지", "후국지") : value;
    });
  });
  guideRows[0][0] = "SOOPNOTICE 후국지 공개 현황";
  guideRows[15][0] = "최근 정상 동기화";
  guideRows[15][1] = "";
  return Object.freeze({ sheets, ranges, guideRows });
}

function metadataFingerprint(metadata) {
  return (metadata.sheets || []).map(sheet => ({
    sheetId: sheet.properties.sheetId,
    title: sheet.properties.title,
    rowCount: sheet.properties.gridProperties?.rowCount,
    columnCount: sheet.properties.gridProperties?.columnCount,
  }));
}

function stateFingerprint(metadata, valueRanges) {
  return sha256({ metadata: metadataFingerprint(metadata), valueRanges });
}

function buildStaticPlan(masterSheetId = "<SAMGUK_SHEET_ID>", publicSheetId = "<SAMGUK_PUBLIC_SHEET_ID>") {
  return Object.freeze({
    mode: "plan-only",
    networkAccess: false,
    seasonId: SEASON_ID,
    cutoverAt: DEFAULT_CUTOVER_AT,
    sources: { masterSheetId, publicSheetId, roster: ROSTER_SOURCE_URL },
    requiredBeforeExecute: [
      "backend Sheet writer, HLS writer, Gamcom/FMK import, public 5-minute sync를 모두 중지",
      "OAuth token은 Sheets 단일 scope, 소유자 0600 파일 및 0700 디렉터리로 준비",
      "--execute, --writers-paused, 정확한 --confirm 값, 별도 실행허용 환경변수를 모두 지정",
    ],
    backup: {
      order: "master와 public의 모든 탭을 각각 spreadsheets.create + sheets.copyTo로 복사하고 탭별 값/수식 fingerprint를 원본과 대조한 뒤에만 원본 변경",
      includesHiddenSheets: true,
      abortBeforeMutationOnBackupFailure: true,
    },
    master: {
      validate: ["후국지 90명/국가", "Pxxx/SOOP_ID 고유성", "TINIT 60개 static topology", "Asia/Seoul timezone"],
      preserveIdentityColumns: ["참가자 A(player_id)", "B(국가)", "D(닉네임)", "E(SOOP_ID)", "H(프로필URL)", "I(방송URL)"],
      clearDynamicRanges: [...MASTER_CLEAR_RANGES],
      reset: [
        "참가자 C(세력/길드), F(장수/직업)와 이전 메모를 후국지 기준으로 초기화",
        "방송모니터링 identity/link/OCR프로필/담당자는 보존하고 이전 상태·동적값 초기화",
        "관측입력 AY(절기배분), 현재현황 BD(절기배분) 헤더와 90행 수식 설치",
        "영토 60개 topology를 보존하고 필수 exact Gamcom seed로 새 TINIT baseline을 설치",
        "게임정보 서버 개요를 2026-08-04~2026-08-10 후국지 일정으로 교체",
        `게임정보에 시즌 marker(시즌/season_id/${SEASON_ID})를 정확히 1개 설치`,
      ],
    },
    public: {
      clear: ["파워랭킹", "스탯·장비", "수정제안", "변경이력", "승인원장", "코드표 A:D의 92행 이후 포함 전체 동적행"],
      reset: ["안내 A1:B16의 삼국지 문구를 후국지로 교체", "절기배분 헤더 설치", "코드표 A:D를 보존된 90명 identity로 갱신"],
    },
    safeguards: [
      "backup 완료 뒤 원본 preflight fingerprint가 바뀌면 mutation 전 중단",
      "원본 변경 실패 시 backup URL을 남기고 자동 재시도/rollback하지 않음",
      "완료 후 참가자·관측·외부참고·영토·현재현황·public 전체 grid 대상 범위를 계획값과 deep read-back 검증",
    ],
    requiredVerifiedSeeds: {
      gamcomMemberJson: "90명 exact-set/nation 및 season=2 envelope 검증 후 C/F, 관측입력, 외부참고 초기 seed",
      gamcomTerritoryJson: "60개 ID/번호/좌표와 8/33/42/47 소유·수도 3개·특수지 0개를 exact hash 검증한 뒤 season2 영토 TINIT seed",
    },
    executeRequiresBothExactSeeds: true,
  });
}

function backupTitle(kind, timestamp) {
  const compact = timestamp.replace(/[-:]/g, "").replace("T", "-").replace(/\..*$/, "").replace(/[+Z].*$/, "");
  return `SOOPNOTICE 후국지 전환 백업 · ${kind} · ${compact}`;
}

function backupSheetSpecifications(metadata, kind) {
  if (!metadata || !Array.isArray(metadata.sheets) || metadata.sheets.length === 0) {
    fail("backup_failed", `${kind} 백업 원본 메타데이터가 올바르지 않습니다.`);
  }
  let totalCells = 0;
  const seenTitles = new Set();
  const specifications = metadata.sheets.map(sheet => {
    const properties = sheet?.properties;
    const title = String(properties?.title || "");
    if (!title || seenTitles.has(title) || title === "백업정보") {
      fail("backup_failed", `${kind} 백업 탭 이름을 확인하세요.`);
    }
    seenTitles.add(title);
    const bounds = checkedGridBounds(properties, `${kind} ${title}`);
    totalCells += bounds.rows * bounds.columns;
    if (totalCells > BACKUP_MAX_TOTAL_CELLS) {
      fail("backup_failed", `${kind} 백업 검증 범위가 안전 한도를 넘었습니다.`);
    }
    return Object.freeze({
      title,
      sheetId: properties.sheetId,
      hidden: Boolean(properties.hidden),
      rowCount: bounds.rows,
      columnCount: bounds.columns,
      range: `${quoteSheetTitle(title)}!A1:${columnLetter(bounds.columns)}${bounds.rows}`,
    });
  });
  return Object.freeze(specifications);
}

async function verifyBackupValueFormulas(client, sourceId, destinationId, sourceMetadata, destinationMetadata, kind) {
  const specifications = backupSheetSpecifications(sourceMetadata, kind);
  const destinationByTitle = new Map((destinationMetadata.sheets || []).map(sheet => [
    String(sheet?.properties?.title || ""),
    sheet?.properties,
  ]));
  for (const specification of specifications) {
    const destination = destinationByTitle.get(specification.title);
    if (!destination || destination.gridProperties?.rowCount !== specification.rowCount
        || destination.gridProperties?.columnCount !== specification.columnCount
        || Boolean(destination.hidden) !== specification.hidden) {
      fail("backup_failed", `${kind} ${specification.title} backup grid가 원본과 다릅니다.`);
    }
  }
  const ranges = specifications.map(item => item.range);
  const sourceValues = await client.batchGetValues(sourceId, ranges, { valueRenderOption: "FORMULA" });
  const destinationValues = await client.batchGetValues(destinationId, ranges, { valueRenderOption: "FORMULA" });
  const sheetFingerprints = specifications.map((item, index) => {
    const sourceFingerprint = sha256(canonicalValueMatrix(sourceValues[index]));
    const destinationFingerprint = sha256(canonicalValueMatrix(destinationValues[index]));
    if (sourceFingerprint !== destinationFingerprint) {
      fail("backup_failed", `${kind} ${item.title} backup 값/수식 fingerprint가 원본과 다릅니다.`);
    }
    return Object.freeze({ title: item.title, sha256: sourceFingerprint });
  });
  return Object.freeze({
    sheetCount: sheetFingerprints.length,
    contentSha256: sha256(sheetFingerprints),
  });
}

async function backupSpreadsheet(client, sourceId, metadata, kind, timestamp) {
  const specifications = backupSheetSpecifications(metadata, kind);
  const sourceSheets = metadata.sheets.map(sheet => sheet.properties);
  const created = await client.createSpreadsheet({
    properties: { title: backupTitle(kind, timestamp), locale: "ko_KR", timeZone: "Asia/Seoul" },
    sheets: [{ properties: { title: "백업정보", gridProperties: { rowCount: 20, columnCount: 4 } } }],
  });
  const destinationId = validateSheetId(created?.spreadsheetId, `${kind} backup`);
  const backupReference = Object.freeze({
    spreadsheetId: destinationId,
    url: `https://docs.google.com/spreadsheets/d/${destinationId}/edit`,
  });
  try {
    const copied = [];
    for (const source of sourceSheets) {
      const result = await client.copySheet(sourceId, source.sheetId, destinationId);
      if (!Number.isSafeInteger(result?.sheetId)) fail("backup_failed", `${kind} ${source.title} copyTo 응답이 올바르지 않습니다.`);
      copied.push({ source, destinationSheetId: result.sheetId });
    }
    await client.batchUpdateSpreadsheet(destinationId, copied.map(item => ({
      updateSheetProperties: {
        properties: { sheetId: item.destinationSheetId, title: item.source.title, index: item.source.index + 1 },
        fields: "title,index",
      },
    })));
    await client.batchUpdateValues(destinationId, "RAW", [{
      range: "'백업정보'!A1:B7",
      values: [
        ["구분", kind],
        ["원본 spreadsheet_id", sourceId],
        ["백업시각", timestamp],
        ["시즌", SEASON_ID],
        ["원본 탭 수", sourceSheets.length],
        ["방식", "spreadsheets.create + sheets.copyTo"],
        ["주의", "후국지 전환 직전 원본 보존본"],
      ],
    }]);
    const verified = await client.getSpreadsheet(destinationId);
    const titles = new Set((verified.sheets || []).map(sheet => sheet.properties?.title));
    if (!titles.has("백업정보") || sourceSheets.some(sheet => !titles.has(sheet.title))
        || titles.size !== sourceSheets.length + 1) {
      fail("backup_failed", `${kind} 백업 탭 검증에 실패했습니다.`);
    }
    const verification = await verifyBackupValueFormulas(
      client,
      sourceId,
      destinationId,
      metadata,
      verified,
      kind,
    );
    return Object.freeze({
      ...backupReference,
      verifiedSheetCount: verification.sheetCount,
      valueFormulaSha256: verification.contentSha256,
    });
  } catch (error) {
    if (error && typeof error === "object" && error.details === undefined) {
      error.details = { partialBackup: backupReference };
    }
    throw error;
  }
}

function ensureColumnRequests(sheetMapValue, specifications) {
  const requests = [];
  for (const [title, minimum] of specifications) {
    const properties = sheetMapValue.get(title);
    if ((properties.gridProperties?.columnCount || 0) < minimum) {
      requests.push({
        updateSheetProperties: {
          properties: { sheetId: properties.sheetId, gridProperties: { columnCount: minimum } },
          fields: "gridProperties.columnCount",
        },
      });
    }
  }
  return requests;
}

function publicClearRanges(preparedPublic) {
  const widths = {
    파워랭킹: PUBLIC_RANKING_HEADERS.length,
    "스탯·장비": PUBLIC_DETAIL_HEADERS.length,
    수정제안: PUBLIC_STATIC_HEADERS.수정제안.length,
    변경이력: PUBLIC_STATIC_HEADERS.변경이력.length,
    승인원장: PUBLIC_STATIC_HEADERS.승인원장.length,
  };
  const ranges = [];
  for (const [title, width] of Object.entries(widths)) {
    const rowCount = preparedPublic.sheets.get(title).gridProperties.rowCount;
    if (rowCount < 92) fail("invalid_sheet", `공개시트 ${title}는 최소 92행이어야 합니다.`);
    ranges.push(`'${title}'!A2:${columnLetter(width)}${rowCount}`);
  }
  ranges.push(fullDataRange(preparedPublic.sheets, "코드표", "D", { minimumRows: 92 }));
  return ranges;
}

function masterClearRanges(prepared) {
  return [
    fullDataRange(prepared.sheets, "참가자", "J", { minimumRows: 91 }),
    fullDataRange(prepared.sheets, "방송모니터링", "P", { minimumRows: 91 }),
    fullDataRange(prepared.sheets, "관측입력", "AY", { minimumRows: 92 }),
    partialDataRange(prepared.sheets, "장비현황", "C", "R", { minimumRows: 91 }),
    fullDataRange(prepared.sheets, "외부참고", "X", { minimumRows: 91 }),
    fullDataRange(prepared.sheets, "영토입력", "T", { minimumRows: 62 }),
    fullDataRange(prepared.sheets, "영토현황", "R", { minimumRows: 61 }),
    fullDataRange(prepared.sheets, "변경로그", "K"),
    fullDataRange(prepared.sheets, "현재현황", "BD", { minimumRows: 91 }),
  ];
}

async function applyMasterReset(client, spreadsheetId, prepared, cutoverAt) {
  await client.batchClearValues(spreadsheetId, masterClearRanges(prepared));
  const currentRows = buildCurrentRows();
  const territoryCurrentRows = buildTerritoryCurrentRows(prepared.territories);
  const gameRow = [
    "서버 개요",
    "후국지 서버 운영기간",
    "후국지 서버는 2026년 8월 4일(화)부터 8월 10일(월)까지 진행됩니다.",
    ROSTER_SOURCE_URL,
    "2026-08-04",
    "확인",
  ];
  const territoryRuleRow = [
    "영토",
    "수도 · 시설 · 특수 영토",
    prepared.territorySeededFromGamcom
      ? "후국지 수도는 위 8번, 촉 42번, 오 47번이며 현재 33번도 촉이 소유합니다. 시설과 특수지 표시는 Gamcom season=2 영토 원본을 기준으로 수집합니다."
      : "수도·시설·특수지 위치는 후국지 영토 원본 재수집값을 기준으로 갱신합니다.",
    prepared.territorySeededFromGamcom ? prepared.territories[0][4] : ROSTER_SOURCE_URL,
    "2026-08-04",
    prepared.territorySeededFromGamcom ? "확인" : "검수대기",
  ];
  const seasonMarkerRow = [
    "시즌",
    "season_id",
    SEASON_ID,
    ROSTER_SOURCE_URL,
    "2026-08-04",
    "확인",
  ];
  const rawUpdates = [
    { range: "'참가자'!A2:J91", values: prepared.participants },
    { range: "'방송모니터링'!A2:P91", values: prepared.monitoring },
  ];
  const updates = [
    { range: "'관측입력'!A1:AY1", values: [[...OBSERVATION_HEADERS]] },
    { range: "'현재현황'!A1:BD1", values: [[...CURRENT_HEADERS]] },
    { range: "'현재현황'!A2:BD91", values: currentRows },
    { range: "'영토입력'!A2:T61", values: prepared.territories },
    { range: "'영토현황'!A2:R61", values: territoryCurrentRows },
    { range: `'게임정보'!A${prepared.gameInfoRow}:F${prepared.gameInfoRow}`, values: [gameRow] },
    { range: `'게임정보'!A${prepared.gameInfoSeasonRow}:F${prepared.gameInfoSeasonRow}`, values: [seasonMarkerRow] },
  ];
  if (prepared.observations.length) {
    rawUpdates.push({ range: "'관측입력'!A2:AY91", values: prepared.observations });
    rawUpdates.push({ range: "'외부참고'!A2:X91", values: prepared.externalReferences });
  }
  if (prepared.gameInfoSpecialRow) {
    updates.push({
      range: `'게임정보'!A${prepared.gameInfoSpecialRow}:F${prepared.gameInfoSpecialRow}`,
      values: [territoryRuleRow],
    });
  }
  await client.batchUpdateValues(spreadsheetId, "RAW", rawUpdates);
  await client.batchUpdateValues(spreadsheetId, "USER_ENTERED", updates);
  void cutoverAt;
}

async function applyPublicReset(client, spreadsheetId, prepared, participants) {
  await client.batchClearValues(spreadsheetId, publicClearRanges(prepared));
  const codeRows = participants.map(row => [row[0], row[3], row[4], row[1]]);
  await client.batchUpdateValues(spreadsheetId, "USER_ENTERED", [
    { range: "'안내'!A1:B16", values: prepared.guideRows },
  ]);
  await client.batchUpdateValues(spreadsheetId, "RAW", [
    { range: "'파워랭킹'!A1:AR1", values: [[...PUBLIC_RANKING_HEADERS]] },
    { range: "'스탯·장비'!A1:AU1", values: [[...PUBLIC_DETAIL_HEADERS]] },
    { range: "'코드표'!A2:D91", values: codeRows },
  ]);
}

async function verifyReset(client, masterId, publicId, prepared, preparedPublic) {
  const currentRows = buildCurrentRows();
  const territoryCurrentRows = buildTerritoryCurrentRows(prepared.territories);
  const masterRanges = [
    fullDataRange(prepared.sheets, "참가자", "J", { minimumRows: 91 }),
    fullDataRange(prepared.sheets, "방송모니터링", "P", { minimumRows: 91 }),
    `${quoteSheetTitle("관측입력")}!A1:AY1`,
    fullDataRange(prepared.sheets, "관측입력", "AY", { minimumRows: 92 }),
    fullDataRange(prepared.sheets, "외부참고", "X", { minimumRows: 91 }),
    fullDataRange(prepared.sheets, "영토입력", "T", { minimumRows: 62 }),
    fullDataRange(prepared.sheets, "영토현황", "R", { minimumRows: 61 }),
    `${quoteSheetTitle("현재현황")}!A1:BD1`,
    fullDataRange(prepared.sheets, "현재현황", "BD", { minimumRows: 91 }),
    partialDataRange(prepared.sheets, "장비현황", "C", "R", { minimumRows: 91 }),
    fullDataRange(prepared.sheets, "변경로그", "K"),
    fullDataRange(prepared.sheets, "게임정보", "C", { startRow: 1 }),
  ];
  const master = await client.batchGetValues(masterId, masterRanges, { valueRenderOption: "FORMULA" });
  const expectedMaster = [
    prepared.participants,
    prepared.monitoring,
    [[...OBSERVATION_HEADERS]],
    prepared.observations,
    prepared.externalReferences,
    prepared.territories,
    territoryCurrentRows,
    [[...CURRENT_HEADERS]],
    currentRows,
    [],
    [],
  ];
  const labels = [
    "참가자", "방송모니터링", "관측입력 header", "관측입력", "외부참고",
    "영토입력", "영토현황", "현재현황 header", "현재현황", "장비현황 dynamic", "변경로그",
  ];
  expectedMaster.forEach((expected, index) => assertExactValueMatrix(master[index], expected, labels[index]));
  const seasonRows = canonicalValueMatrix(master[11]).filter(row => String(row[1] ?? "").trim() === "season_id");
  if (seasonRows.length !== 1 || String(seasonRows[0][0] ?? "").trim() !== "시즌"
      || String(seasonRows[0][2] ?? "").trim() !== SEASON_ID) {
    fail("verification_failed", "게임정보 season_id marker read-back이 정확히 하나가 아닙니다.");
  }

  const publicRanges = [
    `${quoteSheetTitle("안내")}!A1:B16`,
    fullDataRange(preparedPublic.sheets, "파워랭킹", "AR", { startRow: 1, minimumRows: 92 }),
    fullDataRange(preparedPublic.sheets, "스탯·장비", "AU", { startRow: 1, minimumRows: 92 }),
    fullDataRange(preparedPublic.sheets, "수정제안", "Q", { startRow: 1, minimumRows: 92 }),
    fullDataRange(preparedPublic.sheets, "변경이력", "K", { startRow: 1, minimumRows: 92 }),
    fullDataRange(preparedPublic.sheets, "승인원장", "O", { startRow: 1, minimumRows: 92 }),
    fullDataRange(preparedPublic.sheets, "코드표", "D", { minimumRows: 92 }),
  ];
  const publicValues = await client.batchGetValues(publicId, publicRanges, { valueRenderOption: "FORMULA" });
  const codeRows = prepared.participants.map(row => [row[0], row[3], row[4], row[1]]);
  const expectedPublic = [
    preparedPublic.guideRows,
    [[...PUBLIC_RANKING_HEADERS]],
    [[...PUBLIC_DETAIL_HEADERS]],
    [[...PUBLIC_STATIC_HEADERS.수정제안]],
    [[...PUBLIC_STATIC_HEADERS.변경이력]],
    [[...PUBLIC_STATIC_HEADERS.승인원장]],
    codeRows,
  ];
  const publicLabels = ["공개 안내", "공개 파워랭킹", "공개 스탯·장비", "공개 수정제안", "공개 변경이력", "공개 승인원장", "공개 코드표"];
  expectedPublic.forEach((expected, index) => assertExactValueMatrix(publicValues[index], expected, publicLabels[index]));
}

async function readState(client, spreadsheetId, ranges) {
  const metadata = await client.getSpreadsheet(spreadsheetId);
  const values = await client.batchGetValues(spreadsheetId, ranges, { valueRenderOption: "FORMULA" });
  return { metadata, values, fingerprint: stateFingerprint(metadata, values) };
}

async function readMasterState(client, spreadsheetId) {
  const metadata = await client.getSpreadsheet(spreadsheetId);
  const ranges = masterReadRanges(metadata);
  const values = await client.batchGetValues(spreadsheetId, ranges, { valueRenderOption: "FORMULA" });
  return { metadata, ranges, values, fingerprint: stateFingerprint(metadata, values) };
}

async function executeSeasonReset(options) {
  const client = options?.client;
  if (!client) fail("invalid_config", "Google Sheets client가 필요합니다.");
  const masterId = validateSheetId(options.masterSheetId, "master Sheet");
  const publicId = validateSheetId(options.publicSheetId, "public Sheet");
  if (masterId === publicId) fail("invalid_config", "master와 public Sheet는 달라야 합니다.");
  const cutoverAt = validateCutoverAt(options.cutoverAt || DEFAULT_CUTOVER_AT);
  const timestamp = new Date(options.now?.() ?? Date.now()).toISOString();
  if (!options.gamcomMemberSeed || !options.gamcomTerritorySeed) {
    fail("invalid_seed", "execute에는 검증된 Gamcom member/territory exact seed가 모두 필요합니다.");
  }
  validateGamcomEnvelope(options.gamcomMemberSeed, VERIFIED_GAMCOM_MEMBER_SEED, cutoverAt);
  validateGamcomEnvelope(options.gamcomTerritorySeed, VERIFIED_GAMCOM_TERRITORY_SEED, cutoverAt);

  const initialMaster = await readMasterState(client, masterId);
  const preparedMaster = prepareMasterState(initialMaster.metadata, initialMaster.values, cutoverAt, {
    gamcomMemberSeed: options.gamcomMemberSeed,
    gamcomTerritorySeed: options.gamcomTerritorySeed,
  });
  const initialPublicMetadata = await client.getSpreadsheet(publicId);
  const publicRanges = publicReadRanges(initialPublicMetadata).ranges;
  const initialPublicValues = await client.batchGetValues(publicId, publicRanges, { valueRenderOption: "FORMULA" });
  const initialPublic = {
    metadata: initialPublicMetadata,
    values: initialPublicValues,
    fingerprint: stateFingerprint(initialPublicMetadata, initialPublicValues),
  };
  const preparedPublic = preparePublicState(initialPublic.metadata, initialPublic.values);

  let masterBackup;
  let publicBackup;
  try {
    masterBackup = await backupSpreadsheet(client, masterId, initialMaster.metadata, "운영원장", timestamp);
    publicBackup = await backupSpreadsheet(client, publicId, initialPublic.metadata, "공개시트", timestamp);

    const checkMaster = await readMasterState(client, masterId);
    const checkPublicMetadata = await client.getSpreadsheet(publicId);
    const checkPublicRanges = publicReadRanges(checkPublicMetadata).ranges;
    const checkPublicValues = await client.batchGetValues(publicId, checkPublicRanges, { valueRenderOption: "FORMULA" });
    if (checkMaster.fingerprint !== initialMaster.fingerprint
        || stateFingerprint(checkPublicMetadata, checkPublicValues) !== initialPublic.fingerprint) {
      fail("source_changed", "백업 중 원본이 변경되어 원본 mutation 전에 중단했습니다. writer/trigger 중지 상태를 확인하세요.");
    }

    const masterRequests = ensureColumnRequests(preparedMaster.sheets, [
      ["관측입력", OBSERVATION_HEADERS.length],
      ["현재현황", CURRENT_HEADERS.length],
    ]);
    const publicRequests = ensureColumnRequests(preparedPublic.sheets, [
      ["파워랭킹", PUBLIC_RANKING_HEADERS.length],
      ["스탯·장비", PUBLIC_DETAIL_HEADERS.length],
    ]);
    if (masterRequests.length) await client.batchUpdateSpreadsheet(masterId, masterRequests);
    if (publicRequests.length) await client.batchUpdateSpreadsheet(publicId, publicRequests);
    await applyMasterReset(client, masterId, preparedMaster, cutoverAt);
    await applyPublicReset(client, publicId, preparedPublic, preparedMaster.participants);
    await verifyReset(client, masterId, publicId, preparedMaster, preparedPublic);
  } catch (error) {
    if (error && typeof error === "object") {
      error.details = {
        ...(error.details || {}),
        completedBackups: {
          ...(masterBackup ? { master: masterBackup } : {}),
          ...(publicBackup ? { public: publicBackup } : {}),
        },
      };
    }
    throw error;
  }

  return Object.freeze({
    ok: true,
    seasonId: SEASON_ID,
    cutoverAt,
    verifiedSeeds: {
      member: VERIFIED_GAMCOM_MEMBER_SEED.canonicalSha256,
      territory: VERIFIED_GAMCOM_TERRITORY_SEED.canonicalSha256,
    },
    backups: { master: masterBackup, public: publicBackup },
    rosterCount: preparedMaster.participants.length,
    territoryCount: preparedMaster.territories.length,
    seededFromGamcom: preparedMaster.seededFromGamcom,
    territorySeededFromGamcom: preparedMaster.territorySeededFromGamcom,
    deepReadBackVerified: true,
  });
}

function createSheetsApiClient(tokenPath, options = {}) {
  const credentials = readPrivateTokenFile(tokenPath);
  if (credentials.scope !== GOOGLE_SHEETS_SCOPE || credentials.token_uri !== GOOGLE_TOKEN_URI) {
    fail("invalid_config", "Google OAuth scope/token endpoint가 올바르지 않습니다.");
  }
  const fetchImpl = options.fetchImpl || ((...args) => fetch(...args));
  const timeoutMs = options.timeoutMs || 15_000;
  let accessToken = "";
  let expiresAt = 0;

  async function parseResponse(response) {
    const text = await response.text();
    if (text.length > 16 * 1024 * 1024) fail("upstream_error", "Google API 응답이 너무 큽니다.");
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      fail("upstream_error", "Google API 응답이 JSON이 아닙니다.");
    }
  }

  async function refreshToken() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(GOOGLE_TOKEN_URI, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: credentials.client_id,
          client_secret: credentials.client_secret,
          refresh_token: credentials.refresh_token,
          grant_type: "refresh_token",
        }).toString(),
        signal: controller.signal,
      });
      const body = await parseResponse(response);
      if (!response.ok || typeof body.access_token !== "string") fail("oauth_failed", "Google OAuth token 갱신에 실패했습니다.");
      accessToken = body.access_token;
      expiresAt = Date.now() + Math.max(60, Number(body.expires_in) || 3600) * 1000;
    } catch (error) {
      if (error?.name === "AbortError") fail("upstream_timeout", "Google OAuth 응답 시간이 초과되었습니다.");
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async function request(method, url, body) {
    if (!accessToken || expiresAt <= Date.now() + 60_000) await refreshToken();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(url, {
          method,
          headers: {
            Authorization: `Bearer ${accessToken}`,
            ...(body === undefined ? {} : { "Content-Type": "application/json; charset=utf-8" }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal,
        });
        const parsed = await parseResponse(response);
        if (response.status === 401 && attempt === 0) {
          await refreshToken();
          continue;
        }
        if ((response.status === 429 || response.status >= 500) && attempt < 2) continue;
        if (!response.ok) fail("upstream_error", `Google Sheets API 요청이 실패했습니다 (${response.status}).`);
        return parsed;
      } catch (error) {
        if (error?.name === "AbortError") fail("upstream_timeout", "Google Sheets API 응답 시간이 초과되었습니다.");
        throw error;
      } finally {
        clearTimeout(timer);
      }
    }
    fail("upstream_error", "Google Sheets API 요청이 실패했습니다.");
  }

  function spreadsheetUrl(spreadsheetId, suffix = "") {
    return `${SHEETS_API_ROOT}/${encodeURIComponent(spreadsheetId)}${suffix}`;
  }

  return Object.freeze({
    getSpreadsheet(spreadsheetId) {
      const fields = "spreadsheetId,properties(title,locale,timeZone),sheets(properties(sheetId,title,index,hidden,gridProperties(rowCount,columnCount)))";
      return request("GET", `${spreadsheetUrl(spreadsheetId)}?fields=${encodeURIComponent(fields)}`);
    },
    async batchGetValues(spreadsheetId, ranges, params = {}) {
      const query = new URLSearchParams({
        valueRenderOption: params.valueRenderOption || "FORMULA",
        dateTimeRenderOption: "SERIAL_NUMBER",
      });
      for (const range of ranges) query.append("ranges", range);
      const result = await request("GET", `${spreadsheetUrl(spreadsheetId, "/values:batchGet")}?${query}`);
      if (!Array.isArray(result.valueRanges) || result.valueRanges.length !== ranges.length) {
        fail("invalid_sheet", "Google Sheet values:batchGet 응답이 올바르지 않습니다.");
      }
      return result.valueRanges;
    },
    createSpreadsheet(payload) {
      return request("POST", SHEETS_API_ROOT, payload);
    },
    copySheet(sourceId, sheetId, destinationSpreadsheetId) {
      return request("POST", spreadsheetUrl(sourceId, `/sheets/${sheetId}:copyTo`), { destinationSpreadsheetId });
    },
    batchUpdateSpreadsheet(spreadsheetId, requests) {
      return request("POST", spreadsheetUrl(spreadsheetId, ":batchUpdate"), { requests });
    },
    batchClearValues(spreadsheetId, ranges) {
      return request("POST", spreadsheetUrl(spreadsheetId, "/values:batchClear"), { ranges });
    },
    batchUpdateValues(spreadsheetId, valueInputOption, data) {
      return request("POST", spreadsheetUrl(spreadsheetId, "/values:batchUpdate"), {
        valueInputOption,
        includeValuesInResponse: false,
        data: data.map(item => ({ range: item.range, majorDimension: "ROWS", values: item.values })),
      });
    },
  });
}

module.exports = {
  BACKUP_MAX_CELLS_PER_SHEET,
  BACKUP_MAX_COLUMNS_PER_SHEET,
  BACKUP_MAX_ROWS_PER_SHEET,
  CURRENT_HEADERS,
  DEFAULT_CUTOVER_AT,
  EXPECTED_MASTER_SHEETS,
  EXPECTED_PUBLIC_SHEETS,
  HUGUKJI_ROSTER_BY_NATION,
  MASTER_CLEAR_RANGES,
  MASTER_READ_RANGES,
  PUBLIC_DETAIL_HEADERS,
  PUBLIC_RANKING_HEADERS,
  ROSTER_SOURCE_URL,
  SEASON_ID,
  VERIFIED_GAMCOM_SEEDS,
  SamgukSeasonResetError,
  assertExactValueMatrix,
  backupSpreadsheet,
  buildCurrentRows,
  buildTerritoryCurrentRows,
  buildStaticPlan,
  columnLetter,
  createSheetsApiClient,
  executeSeasonReset,
  prepareParticipants,
  prepareGamcomMemberSeed,
  prepareMonitoring,
  prepareTerritoryBaseline,
  sheetSerial,
  stateFingerprint,
  validateCutoverAt,
  validateVerifiedGamcomSeed,
  verifyBackupValueFormulas,
  verifyReset,
};
