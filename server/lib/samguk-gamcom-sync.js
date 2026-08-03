"use strict";

const crypto = require("node:crypto");

const EXPECTED_FACTION_COUNT = 30;
const EXPECTED_ROSTER_COUNT = 90;
const EXPECTED_TERRITORY_COUNT = 60;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 512 * 1024;
const GAMCOM_HOST = "gamcom-3kingdom.vercel.app";
const GAMCOM_FACTION_URLS = Object.freeze({
  "위나라": `https://${GAMCOM_HOST}/factions/%EC%9C%84`,
  "촉나라": `https://${GAMCOM_HOST}/factions/%EC%B4%89`,
  "오나라": `https://${GAMCOM_HOST}/factions/%EC%98%A4`,
});
const GAMCOM_TERRITORY_URL = `https://${GAMCOM_HOST}/api/castles?fresh=1`;
const TERRITORY_GROUPS = Object.freeze({
  "위": Object.freeze({ start: 1, end: 20 }),
  "촉": Object.freeze({ start: 21, end: 40 }),
  "오": Object.freeze({ start: 41, end: 60 }),
});
const TERRITORY_OWNERS = new Set(["위", "촉", "오", "미점령"]);
const TERRITORY_FACILITIES = new Set(["없음", "병영", "성채", "장원"]);
const NUMERIC_FIELDS = Object.freeze([
  "horseLevel", "weapon", "helmet", "armor", "shoes",
  "strength", "agility", "vitality", "intelligence",
]);
const TEXT_FIELDS = Object.freeze(["crew", "job", "horse"]);
const RAW_NUMERIC_FIELDS = Object.freeze({
  horse_level: ["horseLevel", 80],
  weapon: ["weapon", 15],
  helmet: ["helmet", 15],
  armor: ["armor", 15],
  shoes: ["shoes", 15],
  stat_strength: ["strength", 1_000],
  stat_agility: ["agility", 1_000],
  stat_vitality: ["vitality", 1_000],
  stat_intelligence: ["intelligence", 1_000],
});
const SNAPSHOT_FIELDS = Object.freeze([
  "level", "horse", "horseLevel", "weapon", "helmet", "armor", "shoes",
  "strength", "agility", "vitality", "intelligence", "powerScore",
  "maxHealth", "attackPower", "basicAttackDamage", "basicAttackSampleCount",
  "basicAttackTarget", "combatConditions", "healthStat", "activeGeneral", "defense",
  "attackPowerBonusPct", "damageReductionPct", "criticalChancePct", "criticalDamagePct",
  "skillCooldownReductionPct", "skillDamageBonusPct", "moveSpeedBonusPct", "horseMaxHealth",
  "strengthBonus", "agilityBonus", "vitalityBonus", "intelligenceBonus",
  "attackPowerIncrease", "moveSpeedIncrease", "healthIncrease", "skillHasteIncrease",
]);
const REFERENCE_HEADERS = Object.freeze([
  "player_id", "SOOP_ID", "국가", "세력/길드", "닉네임", "장수/직업",
  "말", "말강화", "무기강화", "두갑강화", "흉갑강화", "각갑강화",
  "무력", "기민", "기력", "지모", "채택필드", "우리값유지",
  "우리기준확인", "외부수집시각", "외부갱신시각", "출처URL", "적용정책", "주의",
]);

class SamgukGamcomSyncError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SamgukGamcomSyncError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new SamgukGamcomSyncError(code, message);
}

function normalizeNation(value) {
  const raw = String(value || "").normalize("NFKC").trim();
  if (["위", "위나라", "魏"].includes(raw)) return "위나라";
  if (["촉", "촉나라", "蜀"].includes(raw)) return "촉나라";
  if (["오", "오나라", "吳"].includes(raw)) return "오나라";
  return null;
}

function safeText(value, { label, maximum = 120, nullable = false } = {}) {
  if (value === null || value === undefined || value === "") {
    if (nullable) return null;
    fail("invalid_payload", `${label || "문자열"} 값이 비어 있습니다.`);
  }
  if (typeof value !== "string" || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) {
    fail("invalid_payload", `${label || "문자열"} 형식이 올바르지 않습니다.`);
  }
  const normalized = value.normalize("NFKC").trim();
  if (!normalized && !nullable) fail("invalid_payload", `${label || "문자열"} 값이 비어 있습니다.`);
  return normalized || null;
}

function nullableInteger(value, maximum, label) {
  if (value === null || value === undefined || value === "") return null;
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    fail("invalid_payload", `${label} 값이 올바르지 않습니다.`);
  }
  return value;
}

function requiredInteger(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail("invalid_payload", `${label} 값이 올바르지 않습니다.`);
  }
  return value;
}

function normalizeTerritoryOwner(value) {
  const raw = String(value || "").normalize("NFKC").trim();
  if (["위", "위나라", "魏"].includes(raw)) return "위";
  if (["촉", "촉나라", "蜀"].includes(raw)) return "촉";
  if (["오", "오나라", "吳"].includes(raw)) return "오";
  if (["미점령", "없음"].includes(raw)) return "미점령";
  return null;
}

function normalizeCurrentTerritories(rows) {
  if (!Array.isArray(rows) || rows.length !== EXPECTED_TERRITORY_COUNT) {
    fail("invalid_territories", `우리 영토현황이 ${Array.isArray(rows) ? rows.length : 0}/60개입니다.`);
  }
  const normalized = [];
  const ids = new Set();
  const numbers = new Set();
  for (const [index, raw] of rows.entries()) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      fail("invalid_territories", `${index + 1}번째 우리 영토가 올바르지 않습니다.`);
    }
    const id = safeText(raw.id, { label: "영토ID", maximum: 24 });
    const number = requiredInteger(Number(raw.number), 1, 60, "영토번호");
    const x = requiredInteger(Number(raw.x), 0, 1180, "영토 X");
    const y = requiredInteger(Number(raw.y), 0, 720, "영토 Y");
    const owner = normalizeTerritoryOwner(raw.owner);
    const facility = String(raw.facility || "없음").normalize("NFKC").trim();
    if (!owner || !TERRITORY_FACILITIES.has(facility) || typeof raw.capital !== "boolean") {
      fail("invalid_territories", `${number}번 우리 영토 상태가 올바르지 않습니다.`);
    }
    const level = requiredInteger(Number(raw.level), 0, 999, "영토레벨");
    if (ids.has(id) || numbers.has(number)) fail("invalid_territories", "우리 영토 ID 또는 번호가 중복되었습니다.");
    ids.add(id);
    numbers.add(number);
    normalized.push(Object.freeze({ id, number, x, y, owner, capital: raw.capital, facility, level }));
  }
  return Object.freeze(normalized.sort((left, right) => left.number - right.number));
}

function parseGamcomTerritoryPayload(payload, { currentTerritories } = {}) {
  if (typeof payload !== "string" || payload.length < 2 || payload.length > DEFAULT_MAX_RESPONSE_BYTES) {
    fail("invalid_payload", "Gamcom 영토 응답 크기가 올바르지 않습니다.");
  }
  let parsed;
  try {
    parsed = JSON.parse(payload);
  } catch {
    fail("invalid_payload", "Gamcom 영토 JSON을 해석하지 못했습니다.");
  }
  const forces = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed.forces : null;
  if (!forces || typeof forces !== "object" || Array.isArray(forces)) {
    fail("invalid_payload", "Gamcom 영토 forces가 없습니다.");
  }
  const forceKeys = Object.keys(forces).sort();
  if (forceKeys.length !== 3 || Object.keys(TERRITORY_GROUPS).some(key => !forceKeys.includes(key))) {
    fail("invalid_territories", "Gamcom 영토 국가 묶음이 정확히 위·촉·오가 아닙니다.");
  }

  const territories = [];
  const ids = new Set();
  const numbers = new Set();
  const coordinates = new Set();
  for (const [group, bounds] of Object.entries(TERRITORY_GROUPS)) {
    const rows = forces[group];
    if (!Array.isArray(rows) || rows.length !== 20) {
      fail("invalid_territories", `Gamcom ${group} 구역 영토가 ${Array.isArray(rows) ? rows.length : 0}/20개입니다.`);
    }
    rows.forEach((raw, index) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        fail("invalid_payload", `${group} ${index + 1}번째 영토가 올바르지 않습니다.`);
      }
      const number = Number(raw.name);
      requiredInteger(number, bounds.start, bounds.end, `${group} 영토번호`);
      const localNumber = number - bounds.start + 1;
      const expectedId = `${group}-${String(localNumber).padStart(3, "0")}`;
      const id = safeText(raw.castleKey, { label: "castleKey", maximum: 24 });
      if (id !== expectedId) fail("invalid_territories", `${number}번 영토 ID가 '${expectedId}'와 다릅니다.`);
      const x = requiredInteger(raw.x, 0, 1180, `${number}번 X`);
      const y = requiredInteger(raw.y, 0, 720, `${number}번 Y`);
      const level = requiredInteger(raw.level, 0, 999, `${number}번 레벨`);
      const owner = normalizeTerritoryOwner(raw.owner);
      const facility = String(raw.facilityType || "").normalize("NFKC").trim();
      if (!owner || !TERRITORY_OWNERS.has(owner)) fail("invalid_territories", `${number}번 소유국이 올바르지 않습니다.`);
      if (!TERRITORY_FACILITIES.has(facility)) fail("invalid_territories", `${number}번 시설이 올바르지 않습니다.`);
      if (typeof raw.isCapital !== "boolean") fail("invalid_territories", `${number}번 수도 값이 boolean이 아닙니다.`);
      if (owner === "미점령" && (raw.isCapital || facility !== "없음")) {
        fail("invalid_territories", `${number}번 미점령 영토에 수도 또는 시설이 있습니다.`);
      }
      const coordinate = `${x},${y}`;
      if (ids.has(id) || numbers.has(number) || coordinates.has(coordinate)) {
        fail("invalid_territories", "Gamcom 영토 ID·번호·좌표가 중복되었습니다.");
      }
      ids.add(id);
      numbers.add(number);
      coordinates.add(coordinate);
      territories.push(Object.freeze({ id, number, x, y, owner, capital: raw.isCapital, facility, level }));
    });
  }
  if (territories.length !== EXPECTED_TERRITORY_COUNT || numbers.size !== EXPECTED_TERRITORY_COUNT) {
    fail("invalid_territories", `Gamcom 전체 영토가 ${territories.length}/60개입니다.`);
  }
  const capitalOwners = territories.filter(row => row.capital).map(row => row.owner).sort();
  if (capitalOwners.length !== 3 || capitalOwners.join(",") !== ["오", "위", "촉"].sort().join(",")) {
    fail("invalid_territories", "Gamcom 영토는 각 국가 수도가 정확히 하나씩 있어야 합니다.");
  }
  for (const owner of ["위", "촉", "오"]) {
    const manors = territories.filter(row => row.owner === owner && row.facility === "장원").length;
    if (manors > 10) fail("invalid_territories", `${owner} 장원이 10개를 초과했습니다.`);
  }

  const sorted = territories.sort((left, right) => left.number - right.number);
  if (currentTerritories !== undefined) {
    const current = normalizeCurrentTerritories(currentTerritories);
    sorted.forEach((row, index) => {
      const expected = current[index];
      if (row.id !== expected.id || row.number !== expected.number || row.x !== expected.x || row.y !== expected.y) {
        fail("invalid_territories", `${row.number}번 영토의 불변 ID·번호·좌표가 우리 원장과 다릅니다.`);
      }
    });
  }
  return Object.freeze(sorted);
}

function extractFlightText(payload) {
  if (!payload.includes("self.__next_f.push")) return payload;
  const chunks = [];
  const pattern = /self\.__next_f\.push\((\[.*?\])\)<\/script>/gs;
  for (const match of payload.matchAll(pattern)) {
    try {
      const frame = JSON.parse(match[1]);
      if (frame[0] === 1 && typeof frame[1] === "string") chunks.push(frame[1]);
    } catch {
      fail("invalid_payload", "Gamcom Next Flight 조각을 해석하지 못했습니다.");
    }
  }
  if (chunks.length === 0) fail("invalid_payload", "Gamcom Next Flight 데이터가 없습니다.");
  return chunks.join("");
}

function jsonArrayAt(text, start) {
  if (text[start] !== "[") return null;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === "[") depth += 1;
    else if (character === "]") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return null;
}

function extractRows(payload) {
  const text = extractFlightText(payload);
  let cursor = 0;
  while (cursor < text.length) {
    const marker = text.indexOf('"rows":', cursor);
    if (marker < 0) break;
    const bracket = text.indexOf("[", marker + 7);
    const candidate = bracket < 0 ? null : jsonArrayAt(text, bracket);
    if (candidate) {
      try {
        const parsed = JSON.parse(candidate);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      } catch {
        // 다른 Flight 조각에 있는 rows를 계속 찾습니다.
      }
    }
    cursor = marker + 7;
  }
  fail("invalid_payload", "Gamcom 참가자 rows를 찾지 못했습니다.");
}

function normalizeGamcomRow(raw, index) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    fail("invalid_payload", `${index + 1}번째 Gamcom 행이 올바르지 않습니다.`);
  }
  const nation = normalizeNation(raw.nation);
  if (!nation) fail("invalid_payload", `${index + 1}번째 행의 국가가 올바르지 않습니다.`);
  const result = {
    nation,
    crewName: safeText(raw.crew_name, { label: "세력/길드" }),
    nickname: safeText(raw.nickname, { label: "닉네임", maximum: 80 }),
    job: safeText(raw.job, { label: "장수/직업", maximum: 80 }),
    horse: safeText(raw.horse, { label: "말", maximum: 80, nullable: true }),
  };
  for (const [rawField, [field, maximum]] of Object.entries(RAW_NUMERIC_FIELDS)) {
    result[field] = nullableInteger(raw[rawField], maximum, field);
  }
  return Object.freeze(result);
}

function parseGamcomFactionPayload(payload, { expectedNation, expectedCount = EXPECTED_FACTION_COUNT } = {}) {
  if (typeof payload !== "string" || payload.length < 2) fail("invalid_payload", "Gamcom 응답이 비어 있습니다.");
  const normalizedNation = normalizeNation(expectedNation);
  if (!normalizedNation) fail("invalid_config", "기대 국가가 올바르지 않습니다.");
  if (!Number.isSafeInteger(expectedCount) || expectedCount < 1 || expectedCount > EXPECTED_ROSTER_COUNT) {
    fail("invalid_config", "기대 인원수가 올바르지 않습니다.");
  }
  const rows = extractRows(payload).map(normalizeGamcomRow);
  if (rows.length !== expectedCount) {
    fail("invalid_roster", `${normalizedNation} 인원이 ${rows.length}/${expectedCount}명입니다.`);
  }
  const names = new Set();
  for (const row of rows) {
    if (row.nation !== normalizedNation) fail("invalid_roster", `${row.nickname}의 국가가 ${normalizedNation}와 다릅니다.`);
    if (names.has(row.nickname)) fail("invalid_roster", `닉네임 '${row.nickname}'이 중복되었습니다.`);
    names.add(row.nickname);
  }
  return Object.freeze(rows);
}

async function readTextLimited(response, maximum) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximum) fail("response_too_large", "Gamcom 응답이 너무 큽니다.");
  if (!response.body) return "";
  const chunks = [];
  let total = 0;
  const reader = response.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximum) {
      await reader.cancel();
      fail("response_too_large", "Gamcom 응답이 너무 큽니다.");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

async function fetchGamcomFactions(options = {}) {
  const fetchImpl = options.fetchImpl || ((...args) => fetch(...args));
  const timeoutMs = Number(options.timeoutMs || DEFAULT_TIMEOUT_MS);
  const maxResponseBytes = Number(options.maxResponseBytes || DEFAULT_MAX_RESPONSE_BYTES);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000
      || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1024 || maxResponseBytes > 2 * 1024 * 1024) {
    fail("invalid_config", "Gamcom fetch 제한값이 올바르지 않습니다.");
  }
  const entries = await Promise.all(Object.entries(GAMCOM_FACTION_URLS).map(async ([nation, url]) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        headers: { Accept: "text/html", "User-Agent": "SOOPNOTICE-data-sync/1.0" },
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.ok || response.url && new URL(response.url).hostname !== GAMCOM_HOST) {
        fail("upstream_error", `${nation} Gamcom 조회에 실패했습니다 (${response.status}).`);
      }
      const contentType = String(response.headers.get("content-type") || "").toLowerCase();
      if (!contentType.includes("text/html") && !contentType.includes("text/x-component")) {
        fail("invalid_response", `${nation} Gamcom 응답 형식이 올바르지 않습니다.`);
      }
      const payload = await readTextLimited(response, maxResponseBytes);
      return parseGamcomFactionPayload(payload, { expectedNation: nation });
    } catch (error) {
      if (error?.name === "AbortError") fail("upstream_timeout", `${nation} Gamcom 조회 시간이 초과되었습니다.`);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }));
  const rows = entries.flat();
  if (rows.length !== EXPECTED_ROSTER_COUNT) fail("invalid_roster", `Gamcom 전체 인원이 ${rows.length}/90명입니다.`);
  return Object.freeze(rows);
}

async function fetchGamcomTerritories(options = {}) {
  const fetchImpl = options.fetchImpl || ((...args) => fetch(...args));
  const timeoutMs = Number(options.timeoutMs || DEFAULT_TIMEOUT_MS);
  const maxResponseBytes = Number(options.maxResponseBytes || DEFAULT_MAX_RESPONSE_BYTES);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000
      || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1024 || maxResponseBytes > 2 * 1024 * 1024) {
    fail("invalid_config", "Gamcom 영토 fetch 제한값이 올바르지 않습니다.");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(GAMCOM_TERRITORY_URL, {
      headers: { Accept: "application/json", "User-Agent": "SOOPNOTICE-data-sync/1.0" },
      redirect: "error",
      signal: controller.signal,
    });
    let responseUrl = null;
    try {
      responseUrl = response.url ? new URL(response.url) : null;
    } catch {
      fail("invalid_response", "Gamcom 영토 응답 URL이 올바르지 않습니다.");
    }
    if (!response.ok || responseUrl && (
      responseUrl.hostname !== GAMCOM_HOST
      || responseUrl.pathname !== "/api/castles"
      || responseUrl.searchParams.get("fresh") !== "1"
    )) {
      fail("upstream_error", `Gamcom 영토 조회에 실패했습니다 (${response.status}).`);
    }
    const contentType = String(response.headers.get("content-type") || "").toLowerCase();
    if (!contentType.includes("application/json")) fail("invalid_response", "Gamcom 영토 응답 형식이 JSON이 아닙니다.");
    const payload = await readTextLimited(response, maxResponseBytes);
    return parseGamcomTerritoryPayload(payload, { currentTerritories: options.currentTerritories });
  } catch (error) {
    if (error?.name === "AbortError") fail("upstream_timeout", "Gamcom 영토 조회 시간이 초과되었습니다.");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function present(value) {
  return value !== null && value !== undefined && value !== "";
}

function sameValue(left, right) {
  return !present(left) && !present(right) ? true : left === right;
}

function mergeGamcomMembers(currentMembers, externalRows, { collectedAt } = {}) {
  if (!Array.isArray(currentMembers) || currentMembers.length !== EXPECTED_ROSTER_COUNT
      || !Array.isArray(externalRows) || externalRows.length !== EXPECTED_ROSTER_COUNT) {
    fail("invalid_roster", "우리 원장과 Gamcom 모두 정확히 90명이어야 병합할 수 있습니다.");
  }
  const collectedTimestamp = Date.parse(collectedAt);
  if (!Number.isFinite(collectedTimestamp)) fail("invalid_config", "외부 수집시각이 올바르지 않습니다.");
  const normalizedCollectedAt = new Date(collectedTimestamp).toISOString();
  const externalByName = new Map();
  for (const row of externalRows) {
    if (!row || typeof row.nickname !== "string" || externalByName.has(row.nickname)) {
      fail("invalid_roster", "Gamcom 닉네임이 없거나 중복되었습니다.");
    }
    externalByName.set(row.nickname, row);
  }
  const currentNames = new Set();
  const members = [];
  const referenceRows = [];
  const conflicts = [];
  let changedCount = 0;

  for (const current of currentMembers) {
    const nickname = String(current?.name || "").normalize("NFKC").trim();
    if (!nickname || currentNames.has(nickname)) fail("invalid_roster", "우리 원장 닉네임이 없거나 중복되었습니다.");
    currentNames.add(nickname);
    const external = externalByName.get(nickname);
    if (!external) fail("invalid_roster", `닉네임 '${nickname}'을 Gamcom에서 매칭하지 못했습니다.`);
    if (normalizeNation(current.nation) !== normalizeNation(external.nation)) {
      fail("invalid_roster", `닉네임 '${nickname}'의 국가가 두 원장에서 다릅니다.`);
    }
    const merged = { ...current };
    const changedFields = [];
    const retainedFields = [];

    for (const field of TEXT_FIELDS) {
      const externalField = field === "crew" ? "crewName" : field;
      const currentValue = present(current[field]) ? String(current[field]).normalize("NFKC").trim() : null;
      const externalValue = present(external[externalField]) ? String(external[externalField]).normalize("NFKC").trim() : null;
      if (!currentValue && externalValue) merged[field] = externalValue;
      if (!sameValue(currentValue, merged[field])) {
        changedFields.push(field);
        changedCount += 1;
      } else if (currentValue && externalValue && currentValue !== externalValue) {
        retainedFields.push(field);
        conflicts.push({ playerId: current.playerId, nickname, field, currentValue, externalValue, reason: "current_text_preferred" });
      }
    }

    for (const field of NUMERIC_FIELDS) {
      const currentValue = present(current[field]) ? current[field] : null;
      const externalValue = present(external[field]) ? external[field] : null;
      if (currentValue !== null && (typeof currentValue !== "number" || !Number.isFinite(currentValue))) {
        fail("invalid_roster", `${nickname}의 우리 ${field} 값이 숫자가 아닙니다.`);
      }
      if (externalValue === null) continue;
      const selected = currentValue === null ? externalValue : Math.max(currentValue, externalValue);
      merged[field] = selected;
      if (!sameValue(currentValue, selected)) {
        changedFields.push(field);
        changedCount += 1;
      } else if (currentValue > externalValue) {
        retainedFields.push(field);
        conflicts.push({ playerId: current.playerId, nickname, field, currentValue, externalValue, reason: "higher_current_kept" });
      }
    }

    members.push(Object.freeze(merged));
    referenceRows.push(Object.freeze({
      playerId: current.playerId,
      soopId: current.soopId,
      nickname,
      nation: external.nation,
      crewName: external.crewName,
      job: external.job,
      horse: external.horse,
      horseLevel: external.horseLevel,
      weapon: external.weapon,
      helmet: external.helmet,
      armor: external.armor,
      shoes: external.shoes,
      strength: external.strength,
      agility: external.agility,
      vitality: external.vitality,
      intelligence: external.intelligence,
      sourceUrl: external.sourceUrl || GAMCOM_FACTION_URLS[normalizeNation(external.nation)],
      currentObservedAt: current.observedAt || null,
      collectedAt: normalizedCollectedAt,
      changedFields: Object.freeze(changedFields),
      retainedFields: Object.freeze(retainedFields),
      comparison: changedFields.length
        ? `${changedFields.length}개 채택${retainedFields.length ? ` · ${retainedFields.length}개 우리값 유지` : ""}`
        : `변경 없음${retainedFields.length ? ` · ${retainedFields.length}개 우리값 유지` : ""}`,
    }));
  }

  if (externalByName.size !== currentNames.size
      || [...externalByName.keys()].some(name => !currentNames.has(name))) {
    fail("invalid_roster", "Gamcom과 우리 원장의 90명 닉네임 구성이 다릅니다.");
  }
  return Object.freeze({
    members: Object.freeze(members),
    referenceRows: Object.freeze(referenceRows),
    matchedCount: members.length,
    changedCount,
    conflicts: Object.freeze(conflicts),
  });
}

function buildGamcomTerritoryChanges(currentTerritories, externalTerritories, { collectedAt } = {}) {
  const current = normalizeCurrentTerritories(currentTerritories);
  const external = normalizeCurrentTerritories(externalTerritories);
  const collectedTimestamp = Date.parse(collectedAt);
  if (!Number.isFinite(collectedTimestamp)) fail("invalid_config", "영토 수집시각이 올바르지 않습니다.");
  const observedAt = new Date(collectedTimestamp).toISOString();
  const currentById = new Map(current.map(row => [row.id, row]));
  external.forEach(row => {
    const expected = currentById.get(row.id);
    if (!expected || expected.number !== row.number || expected.x !== row.x || expected.y !== row.y) {
      fail("invalid_territories", `${row.number}번 영토의 불변 ID·번호·좌표가 우리 원장과 다릅니다.`);
    }
  });
  const snapshotMaterial = JSON.stringify(external.map(row => ({
    id: row.id,
    number: row.number,
    x: row.x,
    y: row.y,
    owner: row.owner,
    capital: row.capital,
    facility: row.facility,
    level: row.level,
  })));
  const snapshotHash = crypto.createHash("sha256").update(snapshotMaterial, "utf8").digest("hex");
  const changes = [];
  for (const row of external) {
    const previous = currentById.get(row.id);
    const changedFields = ["owner", "capital", "facility", "level"]
      .filter(field => previous[field] !== row[field]);
    if (changedFields.length === 0) continue;
    const transitionMaterial = JSON.stringify({
      snapshotHash,
      observedAt,
      id: row.id,
      previous: Object.fromEntries(changedFields.map(field => [field, previous[field]])),
      next: Object.fromEntries(changedFields.map(field => [field, row[field]])),
    });
    const transitionHash = crypto.createHash("sha256").update(transitionMaterial, "utf8").digest("hex");
    changes.push(Object.freeze({
      territoryObservationId: `TERR-GAMCOM-${transitionHash.slice(0, 24).toUpperCase()}`,
      territoryId: row.id,
      observedAt,
      sourceType: "Gamcom",
      evidence: GAMCOM_TERRITORY_URL,
      number: row.number,
      x: row.x,
      y: row.y,
      owner: row.owner,
      capital: row.capital,
      facility: row.facility,
      level: row.level,
      special: row.number === 27,
      captureStatus: row.owner === "미점령" ? "미점령" : "점령",
      captureRate: null,
      verificationStatus: "기준값",
      sourceCount: 1,
      evidenceHash: snapshotHash,
      note: `Gamcom 60칸 전체 응답에서 ${changedFields.join(", ")} 변경 감지; 원문 갱신시각 미제공`,
      inputAt: observedAt,
      changedFields: Object.freeze(changedFields),
      previous: Object.freeze({ ...previous }),
    }));
  }
  return Object.freeze({
    changes: Object.freeze(changes),
    changedCount: changes.length,
    snapshotHash,
    observedAt,
    sourceUpdatedAt: null,
  });
}

function sheetSafeText(value) {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /^\s*[=+\-@]/.test(text) ? `'${text}` : text;
}

function buildReferenceRows(result) {
  if (!result || !Array.isArray(result.referenceRows)) fail("invalid_reference", "외부참고 행이 없습니다.");
  return result.referenceRows.map(raw => {
    const row = { ...raw };
    for (const field of ["playerId", "soopId", "nickname", "nation", "crewName", "job", "horse", "sourceUrl", "comparison"]) {
      row[field] = sheetSafeText(row[field]);
    }
    row.changedFields = Array.isArray(raw.changedFields) ? raw.changedFields.map(sheetSafeText) : [];
    row.retainedFields = Array.isArray(raw.retainedFields) ? raw.retainedFields.map(sheetSafeText) : [];
    return Object.freeze(row);
  });
}

function referenceSheetValues(result) {
  const rows = buildReferenceRows(result).map(row => [
    row.playerId, row.soopId, row.nation, row.crewName, row.nickname, row.job,
    row.horse ?? "", row.horseLevel ?? "", row.weapon ?? "", row.helmet ?? "",
    row.armor ?? "", row.shoes ?? "", row.strength ?? "", row.agility ?? "",
    row.vitality ?? "", row.intelligence ?? "", row.changedFields.join(", "),
    row.retainedFields.join(", "), row.currentObservedAt || "", row.collectedAt,
    "", row.sourceUrl, "숫자 MAX · 텍스트 우리 원장 우선",
    "보조자료 · 원문 갱신시각 미제공 · 낮은 값 자동 반영 안 함",
  ]);
  return Object.freeze({ headers: REFERENCE_HEADERS, rows: Object.freeze(rows) });
}

function buildGamcomSnapshots(result, { sheetUrl, collectedAt } = {}) {
  if (!result || !Array.isArray(result.members) || !Array.isArray(result.referenceRows)) {
    fail("invalid_snapshot", "병합 결과가 올바르지 않습니다.");
  }
  const parsedTimestamp = Date.parse(collectedAt);
  if (!Number.isFinite(parsedTimestamp)) fail("invalid_config", "수집시각이 올바르지 않습니다.");
  const timestamp = new Date(parsedTimestamp).toISOString();
  return result.members.flatMap((member, index) => {
    const reference = result.referenceRows[index];
    const snapshotChangedFields = reference?.changedFields.filter(field => SNAPSHOT_FIELDS.includes(field)) || [];
    if (snapshotChangedFields.length === 0) return [];
    const fields = Object.fromEntries(SNAPSHOT_FIELDS.map(field => [
      field,
      member[field] === undefined || member[field] === "" ? null : member[field],
    ]));
    const material = JSON.stringify({ playerId: member.playerId, fields, sourceUrl: reference.sourceUrl });
    const digest = crypto.createHash("sha256").update(material, "utf8").digest("hex");
    return [Object.freeze({
      observationId: `OBS-GAMCOM-${digest.slice(0, 24).toUpperCase()}`,
      playerId: member.playerId,
      fields,
      observedAt: timestamp,
      verification: "gamcom-max",
      primarySourceType: "gamcom",
      sourceTypes: ["sheet", "gamcom"],
      sourceCount: 2,
      sourceUrls: [sheetUrl, reference.sourceUrl],
      evidenceHash: crypto.createHash("sha256").update(material, "utf8").digest("hex"),
      batchId: `GAMCOM-${timestamp.slice(0, 10).replace(/-/g, "")}-${digest.slice(0, 8).toUpperCase()}`,
      ocrConfidence: null,
      note: `Gamcom 보조자료와 우리 원장 숫자 최고값 병합 (${snapshotChangedFields.join(", ")}); 원문 갱신시각 미제공`,
    })];
  });
}

module.exports = {
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_TIMEOUT_MS,
  EXPECTED_FACTION_COUNT,
  EXPECTED_ROSTER_COUNT,
  EXPECTED_TERRITORY_COUNT,
  GAMCOM_FACTION_URLS,
  GAMCOM_TERRITORY_URL,
  NUMERIC_FIELDS,
  REFERENCE_HEADERS,
  SNAPSHOT_FIELDS,
  SamgukGamcomSyncError,
  buildGamcomSnapshots,
  buildGamcomTerritoryChanges,
  buildReferenceRows,
  fetchGamcomFactions,
  fetchGamcomTerritories,
  mergeGamcomMembers,
  normalizeNation,
  parseGamcomFactionPayload,
  parseGamcomTerritoryPayload,
  referenceSheetValues,
};
