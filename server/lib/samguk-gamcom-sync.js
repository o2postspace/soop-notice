"use strict";

const crypto = require("node:crypto");

const EXPECTED_FACTION_COUNT = 30;
const EXPECTED_ROSTER_COUNT = 90;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 512 * 1024;
const GAMCOM_HOST = "gamcom-3kingdom.vercel.app";
const GAMCOM_FACTION_URLS = Object.freeze({
  "위나라": `https://${GAMCOM_HOST}/factions/%EC%9C%84`,
  "촉나라": `https://${GAMCOM_HOST}/factions/%EC%B4%89`,
  "오나라": `https://${GAMCOM_HOST}/factions/%EC%98%A4`,
});
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
  "basicAttackDamage", "basicAttackSampleCount",
  "basicAttackTarget", "combatConditions",
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
  GAMCOM_FACTION_URLS,
  NUMERIC_FIELDS,
  REFERENCE_HEADERS,
  SNAPSHOT_FIELDS,
  SamgukGamcomSyncError,
  buildGamcomSnapshots,
  buildReferenceRows,
  fetchGamcomFactions,
  mergeGamcomMembers,
  normalizeNation,
  parseGamcomFactionPayload,
  referenceSheetValues,
};
