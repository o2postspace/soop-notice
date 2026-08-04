#!/usr/bin/env node

"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const FALLBACK_PATH = path.join(ROOT, "data/samguk-fallback.json");
const PUBLIC_INDEX_PATH = path.resolve(ROOT, "../public/index.html");
const PUBLIC_CLIENT_PATH = path.resolve(ROOT, "../public/samguk.js");
const TRACKER_PATH = path.join(__dirname, "build-samguk-tracker.py");

const SEASON_ID = "hugukji-2026-08-04";
const CUTOVER_AT = "2026-08-04T19:36:40+09:00";
const SOURCE_DATE = "2026-08-04";
const GAMCOM_MEMBER_URL = "https://gamcom-3kingdom.vercel.app/factions?season=2";
const GAMCOM_TERRITORY_URL = "https://gamcom-3kingdom.vercel.app/api/castles?fresh=1&season=2";
const MEMBER_COLLECTED_AT = "2026-08-04T11:54:47.294Z";
const TERRITORY_COLLECTED_AT = "2026-08-04T11:54:47.294Z";
const MEMBER_CONTENT_SHA256 = "4d10865b43421480207c1b30b8a3539864e02a583bdbf6cbf576ddd76108b64f";
const TERRITORY_CONTENT_SHA256 = "8534e87f86c97a6881b4704b7b9577c9b4e814fb9abbb93329b8c4f2bc91cb1b";
const MEMBER_ROWS_SHA256 = "44afca8937b46c08fe73a5be48eafc736075d231eb4eeee0475a1eb2fd2c8aeb";
const TERRITORY_ROWS_SHA256 = "00f5d548ab0229fc00901d01f3428ec6edd586f62af09d9baea0515f34bbf6f7";
const ROSTER_URL = GAMCOM_MEMBER_URL;
const OVERVIEW_TITLE = "후국지 RPG 영토전";
const OVERVIEW_DESCRIPTION = "2026년 8월 4일부터 8월 10일까지 진행됩니다. 요괴 사냥 RPG와 영토 전쟁이 결합되며, 종료 시 가장 많은 영토를 가진 나라가 우승합니다.";
const SPECIAL_RULE_TITLE = "후국지 초기 수도와 특수 영토";
const SPECIAL_RULE_DESCRIPTION = "후국지 초기 수도는 위 8번, 촉 42번, 오 47번이며 각각 위·촉·오가 소유합니다. season=2 지도 기준 특수 영토(isCheonrimun)는 확인되지 않았습니다.";

const DYNAMIC_MEMBER_FIELDS = Object.freeze([
  "crew", "job", "level", "horse", "horseLevel", "weapon", "helmet", "armor", "shoes",
  "strength", "agility", "vitality", "intelligence", "powerScore", "maxHealth", "attackPower",
  "basicAttackDamage", "basicAttackSampleCount", "basicAttackTarget", "combatConditions", "healthStat",
  "activeGeneral", "defense", "attackPowerBonusPct", "damageReductionPct", "criticalChancePct",
  "criticalDamagePct", "skillCooldownReductionPct", "skillDamageBonusPct", "moveSpeedBonusPct",
  "horseMaxHealth", "strengthBonus", "agilityBonus", "vitalityBonus", "intelligenceBonus",
  "attackPowerIncrease", "moveSpeedIncrease", "healthIncrease", "skillHasteIncrease", "skillBuild",
]);

const SEEDED_MEMBER_FIELD_MAP = Object.freeze({
  crew: "crew_name",
  job: "job",
  horse: "horse",
  horseLevel: "horse_level",
  weapon: "weapon",
  helmet: "helmet",
  armor: "armor",
  shoes: "shoes",
  strength: "stat_strength",
  agility: "stat_agility",
  vitality: "stat_vitality",
  intelligence: "stat_intelligence",
});
const NULL_MEMBER_FIELDS = Object.freeze(
  DYNAMIC_MEMBER_FIELDS.filter(field => !Object.hasOwn(SEEDED_MEMBER_FIELD_MAP, field)),
);
const MEMBER_SEED_KEYS = Object.freeze([
  "nation", "crew_name", "nickname", "job", "horse", "horse_level", "weapon", "helmet",
  "armor", "shoes", "stat_strength", "stat_agility", "stat_vitality", "stat_intelligence",
]);
const TERRITORY_SEED_KEYS = Object.freeze([
  "castleKey", "name", "level", "owner", "isCapital", "isCheonrimun", "facilityType", "x", "y",
]);
const NATION_MAP = Object.freeze({ "위나라": "위", "촉나라": "촉", "오나라": "오" });
const EXPECTED_CAPITAL_OWNERS = Object.freeze({ 8: "위", 42: "촉", 47: "오" });
const EXPECTED_CURRENT_OWNERS = Object.freeze({ 8: "위", 33: "촉", 42: "촉", 47: "오" });

const OLD_OVERVIEW_TITLE = "10일간 진행되는 RPG 영토전";
const OLD_OVERVIEW_DESCRIPTION = "2026년 8월 1일 21시부터 8월 10일 21시까지 진행됩니다. 요괴 사냥 RPG와 영토 전쟁이 결합되며, 종료 시 가장 많은 영토를 가진 나라가 우승합니다.";
const OLD_SPECIAL_TITLES = Object.freeze([
  "수도 · 시설 · 27번 특수 영토",
  "수도 · 시설 · 특수 영토",
]);
const OLD_SPECIAL_DESCRIPTION = "초기 수도는 위 8번, 촉 42번, 오 47번입니다. 시설은 병영·성채·장원이 있고 장원은 국가당 최대 10개입니다. 27번 특수 영토는 보유국 인원의 공격력을 5% 높입니다.";

function fail(message) {
  throw new Error(message);
}

function countMatches(text, needle) {
  return text.split(needle).length - 1;
}

function replaceOneVariantOrKeep(text, oldValues, newValue, label) {
  const values = [...new Set(oldValues.filter(value => value !== newValue))];
  const oldCounts = values.map(value => countMatches(text, value));
  const oldTotal = oldCounts.reduce((sum, count) => sum + count, 0);
  const newCount = countMatches(text, newValue);
  if (oldTotal === 1 && newCount === 0) {
    return text.replace(values[oldCounts.findIndex(Boolean)], newValue);
  }
  if (oldTotal === 0 && newCount === 1) return text;
  fail(`${label} 교체 대상을 하나로 확정할 수 없습니다. old=${oldTotal}, new=${newCount}`);
}

function sameKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function sha256(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function validateIdentityRows(members) {
  if (!Array.isArray(members) || members.length !== 90) fail("fallback 참가자는 정확히 90명이어야 합니다.");
  const names = new Set();
  const soopIds = new Set();
  const nationCounts = { "위": 0, "촉": 0, "오": 0 };
  members.forEach((member, index) => {
    const playerId = `P${String(index + 1).padStart(3, "0")}`;
    if (!member || typeof member !== "object" || Array.isArray(member)) fail(`${playerId} 형식이 올바르지 않습니다.`);
    if (typeof member.name !== "string" || !member.name.trim()) fail(`${playerId} 닉네임이 없습니다.`);
    if (!/^[A-Za-z0-9_]{1,30}$/.test(member.soopId || "")) fail(`${playerId} SOOP ID가 올바르지 않습니다.`);
    if (!Object.hasOwn(nationCounts, member.nation)) fail(`${playerId} 국가가 올바르지 않습니다.`);
    if (names.has(member.name) || soopIds.has(member.soopId.toLowerCase())) fail(`${playerId} 식별자가 중복되었습니다.`);
    names.add(member.name);
    soopIds.add(member.soopId.toLowerCase());
    nationCounts[member.nation] += 1;
  });
  if (Object.values(nationCounts).some(count => count !== 30)) fail("위·촉·오 참가자는 각각 30명이어야 합니다.");
}

function validateTerritories(territories) {
  if (!Array.isArray(territories) || territories.length !== 60) fail("fallback 영토는 정확히 60개여야 합니다.");
  const ids = new Set();
  const numbers = new Set();
  territories.forEach((territory, index) => {
    if (!territory || typeof territory !== "object" || Array.isArray(territory)) {
      fail(`영토 ${index + 1} 형식이 올바르지 않습니다.`);
    }
    if (typeof territory.id !== "string" || !territory.id || ids.has(territory.id)) {
      fail(`영토 ${index + 1} ID가 올바르지 않습니다.`);
    }
    if (!Number.isSafeInteger(territory.number) || territory.number < 1 || territory.number > 60) {
      fail(`영토 ${index + 1} 번호가 올바르지 않습니다.`);
    }
    if (numbers.has(territory.number)) fail(`영토 번호가 중복되었습니다: ${territory.number}`);
    if (!Number.isFinite(territory.x) || !Number.isFinite(territory.y)) fail(`영토 ${territory.number} 좌표가 올바르지 않습니다.`);
    ids.add(territory.id);
    numbers.add(territory.number);
  });
}

function validateSeedEnvelope(payload, { label, sourceUrl, collectedAt, contentSha256, rowCount }) {
  const envelopeKeys = ["version", "seasonId", "sourceUrl", "collectedAt", "contentSha256", "rows"];
  if (!sameKeys(payload, envelopeKeys) || payload.version !== 1 || payload.seasonId !== SEASON_ID
      || payload.sourceUrl !== sourceUrl || payload.collectedAt !== collectedAt
      || payload.contentSha256 !== contentSha256 || !Array.isArray(payload.rows)
      || payload.rows.length !== rowCount) {
    fail(`${label} seed envelope가 검증된 season=2 스냅샷과 다릅니다.`);
  }
  if (!Number.isFinite(Date.parse(payload.collectedAt))) fail(`${label} collectedAt이 올바르지 않습니다.`);
}

function validateSeedText(value, label) {
  if (typeof value !== "string" || !value.trim() || value !== value.trim()
      || value.length > 120 || /[\u0000-\u001f\u007f]/.test(value)) {
    fail(`${label} 문자열이 올바르지 않습니다.`);
  }
}

function validateSeedInteger(value, maximum, label, nullable = false) {
  if (nullable && value === null) return;
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) fail(`${label} 숫자가 올바르지 않습니다.`);
}

function validateMemberSeed(payload, members) {
  validateSeedEnvelope(payload, {
    label: "Gamcom roster",
    sourceUrl: GAMCOM_MEMBER_URL,
    collectedAt: MEMBER_COLLECTED_AT,
    contentSha256: MEMBER_CONTENT_SHA256,
    rowCount: 90,
  });
  if (sha256(payload.rows.map(row => MEMBER_SEED_KEYS.map(key => row?.[key]))) !== MEMBER_ROWS_SHA256) {
    fail("Gamcom roster rows가 검증된 exact snapshot과 다릅니다.");
  }
  const identities = new Map(members.map(member => [member.name, member]));
  const byName = new Map();
  for (const row of payload.rows) {
    if (!sameKeys(row, MEMBER_SEED_KEYS)) fail("Gamcom roster row schema가 올바르지 않습니다.");
    for (const field of ["nickname", "crew_name", "job", "horse"]) validateSeedText(row[field], `${row.nickname || "?"} ${field}`);
    const member = identities.get(row.nickname);
    const nation = NATION_MAP[row.nation];
    if (!member || member.nation !== nation || byName.has(row.nickname)) {
      fail(`Gamcom roster identity/nation이 fallback과 다릅니다: ${row.nickname || "?"}`);
    }
    validateSeedInteger(row.horse_level, 80, `${row.nickname} horse_level`);
    for (const field of ["weapon", "helmet", "armor", "shoes"]) {
      validateSeedInteger(row[field], 15, `${row.nickname} ${field}`, true);
    }
    for (const field of ["stat_strength", "stat_agility", "stat_vitality", "stat_intelligence"]) {
      validateSeedInteger(row[field], 1_000_000, `${row.nickname} ${field}`);
    }
    byName.set(row.nickname, row);
  }
  if (byName.size !== identities.size || [...identities.keys()].some(name => !byName.has(name))) {
    fail("Gamcom roster는 fallback 90명 exact-set이어야 합니다.");
  }
  return byName;
}

function validateTerritorySeed(payload, territories) {
  validateSeedEnvelope(payload, {
    label: "Gamcom territory",
    sourceUrl: GAMCOM_TERRITORY_URL,
    collectedAt: TERRITORY_COLLECTED_AT,
    contentSha256: TERRITORY_CONTENT_SHA256,
    rowCount: 60,
  });
  if (sha256(payload.rows.map(row => TERRITORY_SEED_KEYS.map(key => row?.[key]))) !== TERRITORY_ROWS_SHA256) {
    fail("Gamcom territory rows가 검증된 exact snapshot과 다릅니다.");
  }
  const topology = new Map(territories.map(territory => [territory.id, territory]));
  const byId = new Map();
  for (const row of payload.rows) {
    if (!sameKeys(row, TERRITORY_SEED_KEYS)) fail("Gamcom territory row schema가 올바르지 않습니다.");
    validateSeedText(row.castleKey, "castleKey");
    validateSeedText(row.name, `${row.castleKey} name`);
    validateSeedText(row.facilityType, `${row.castleKey} facilityType`);
    const territory = topology.get(row.castleKey);
    const number = Number(row.name);
    if (!territory || byId.has(row.castleKey) || !Number.isSafeInteger(number)
        || number !== territory.number || row.x !== territory.x || row.y !== territory.y
        || !["위", "촉", "오", "미점령"].includes(row.owner)
        || typeof row.isCapital !== "boolean" || typeof row.isCheonrimun !== "boolean") {
      fail(`Gamcom territory topology/owner가 fallback과 다릅니다: ${row.castleKey}`);
    }
    validateSeedInteger(row.level, 999, `${row.castleKey} level`);
    byId.set(row.castleKey, row);
  }
  const capitals = [...byId.values()].filter(row => row.isCapital);
  const owned = [...byId.values()].filter(row => row.owner !== "미점령");
  if (capitals.length !== 3 || owned.length !== 4 || capitals.some(row => (
    row.owner !== EXPECTED_CAPITAL_OWNERS[Number(row.name)]
  )) || owned.some(row => row.owner !== EXPECTED_CURRENT_OWNERS[Number(row.name)])
      || [...byId.values()].some(row => row.isCheonrimun)) {
    fail("후국지 현재 영토는 8:위, 33:촉, 42:촉, 47:오 소유이고 특수지는 없어야 합니다.");
  }
  return byId;
}

function resetMember(member, row) {
  const output = { name: member.name, soopId: member.soopId, nation: member.nation };
  DYNAMIC_MEMBER_FIELDS.forEach(field => {
    output[field] = Object.hasOwn(SEEDED_MEMBER_FIELD_MAP, field)
      ? row[SEEDED_MEMBER_FIELD_MAP[field]]
      : null;
  });
  return {
    ...output,
    sourceType: "gamcom",
    sourceCount: 1,
    verificationStatus: "baseline",
    reviewStatus: "기준값",
    observedAt: MEMBER_COLLECTED_AT,
    evidence: GAMCOM_MEMBER_URL,
  };
}

function resetTerritory(territory, row) {
  return {
    id: territory.id,
    number: territory.number,
    x: territory.x,
    y: territory.y,
    owner: row.owner,
    capital: row.isCapital,
    facility: row.facilityType,
    level: row.level,
    special: row.isCheonrimun,
    sourceType: "gamcom",
    sourceCount: 1,
    verificationStatus: "baseline",
    reviewStatus: "기준값",
    observedAt: TERRITORY_COLLECTED_AT,
    evidence: GAMCOM_TERRITORY_URL,
  };
}

function resetRules(rules) {
  if (!Array.isArray(rules) || rules.length === 0) fail("게임정보 rules가 없습니다.");
  const specialMatches = rules.filter(rule => /27번|특수\s*영토/.test(`${rule?.title || ""} ${rule?.description || ""}`));
  if (specialMatches.length !== 1) fail(`특수 영토 rule은 정확히 1개여야 합니다: ${specialMatches.length}`);
  return rules.map((rule, index) => {
    const special = rule === specialMatches[0];
    return {
      ...rule,
      ...(index === 0 ? {
        category: "서버 개요",
        title: OVERVIEW_TITLE,
        description: OVERVIEW_DESCRIPTION,
        sourceUrl: GAMCOM_MEMBER_URL,
      } : {}),
      ...(special ? {
        category: "영토",
        title: SPECIAL_RULE_TITLE,
        description: SPECIAL_RULE_DESCRIPTION,
        sourceUrl: GAMCOM_TERRITORY_URL,
      } : {}),
      sourceDate: SOURCE_DATE,
    };
  });
}

function resetFallback(source, memberSeed, territorySeed) {
  validateIdentityRows(source.members);
  validateTerritories(source.territories);
  const memberByName = validateMemberSeed(memberSeed, source.members);
  const territoryById = validateTerritorySeed(territorySeed, source.territories);
  return {
    source: "fallback-seed",
    seasonId: SEASON_ID,
    updatedAt: TERRITORY_COLLECTED_AT,
    stale: true,
    sheetUrl: source.sheetUrl,
    members: source.members.map(member => resetMember(member, memberByName.get(member.name))),
    territories: source.territories.map(territory => resetTerritory(territory, territoryById.get(territory.id))),
    rules: resetRules(source.rules),
    warnings: [
      "Gamcom season=2 스냅샷에서 후국지 90명의 길드·장수·말·강화·기량을 exact-set으로 대조했습니다.",
      "강화·기량의 0은 미입력이 아니라 Gamcom이 확인한 유효한 초기값입니다.",
      "레벨·전투 정보창·절기 배분 등 Gamcom seed에 없는 동적값은 새 관측 전까지 공란(null)입니다.",
      "영토는 season=2 기준 8:위, 33:촉, 42:촉, 47:오 소유이며 특수 영토는 없습니다.",
      "Google Sheet 정상값이 수집되면 이 초기 기준값을 대체합니다.",
    ],
  };
}

function renderCompactArray(name, values, trailingComma = true) {
  const suffix = trailingComma ? "," : "";
  return [
    `  "${name}": [`,
    ...values.map((value, index) => `    ${JSON.stringify(value)}${index + 1 === values.length ? "" : ","}`),
    `  ]${suffix}`,
  ].join("\n");
}

function renderFallback(fallback) {
  return [
    "{",
    `  "source": ${JSON.stringify(fallback.source)},`,
    `  "seasonId": ${JSON.stringify(fallback.seasonId)},`,
    `  "updatedAt": ${JSON.stringify(fallback.updatedAt)},`,
    `  "stale": ${JSON.stringify(fallback.stale)},`,
    `  "sheetUrl": ${JSON.stringify(fallback.sheetUrl)},`,
    renderCompactArray("members", fallback.members),
    renderCompactArray("territories", fallback.territories),
    renderCompactArray("rules", fallback.rules),
    renderCompactArray("warnings", fallback.warnings, false),
    "}",
    "",
  ].join("\n");
}

function jsSingleQuoted(value) {
  if (typeof value !== "string" || /[\r\n]/.test(value)) fail("public roster 문자열이 올바르지 않습니다.");
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

function resetPublicRoster(text, members) {
  const blockMatch = text.match(/const SAMGUK_MEMBERS = \[([\s\S]*?)\n\]\.map/);
  if (!blockMatch) fail("public/index.html의 SAMGUK_MEMBERS를 찾지 못했습니다.");
  const rowPattern = /^(\s*)\['([^']*)','([^']*)','([^']*)','([^']*)',(null|'[^']*')\],$/gm;
  const rows = [...blockMatch[1].matchAll(rowPattern)];
  if (rows.length !== 90) fail(`public 정적 roster가 90명이 아닙니다: ${rows.length}`);
  rows.forEach((row, index) => {
    const member = members[index];
    if (row[2] !== member.nation || row[4] !== member.name || row[5] !== member.soopId) {
      fail(`P${String(index + 1).padStart(3, "0")} public/fallback 신원이 다릅니다.`);
    }
  });
  let rowIndex = 0;
  const resetBlock = blockMatch[1].replace(rowPattern, (_line, indent) => {
    const member = members[rowIndex];
    rowIndex += 1;
    return `${indent}[${[
      member.nation, member.crew, member.name, member.soopId, member.job,
    ].map(jsSingleQuoted).join(",")}],`;
  });
  let output = text.replace(blockMatch[1], resetBlock);
  output = replaceOneVariantOrKeep(
    output,
    ["2026년 8월 1일–10일 · 위·촉·오 참가자 90명"],
    "후국지 · 2026년 8월 4일–10일 · 위·촉·오 참가자 90명",
    "public 후국지 기간",
  );
  return output;
}

function resetRuleText(text, label) {
  let output = replaceOneVariantOrKeep(text, [OLD_OVERVIEW_TITLE], OVERVIEW_TITLE, `${label} overview title`);
  output = replaceOneVariantOrKeep(output, [OLD_OVERVIEW_DESCRIPTION], OVERVIEW_DESCRIPTION, `${label} overview description`);
  output = replaceOneVariantOrKeep(output, OLD_SPECIAL_TITLES, SPECIAL_RULE_TITLE, `${label} special title`);
  output = replaceOneVariantOrKeep(output, [OLD_SPECIAL_DESCRIPTION], SPECIAL_RULE_DESCRIPTION, `${label} special description`);
  return output;
}

function assertBaseline(fallback, publicIndex, publicClient, tracker) {
  validateIdentityRows(fallback.members);
  validateTerritories(fallback.territories);
  if (fallback.seasonId !== SEASON_ID || fallback.updatedAt !== TERRITORY_COLLECTED_AT) {
    fail("후국지 season metadata가 다릅니다.");
  }
  if (fallback.members.some(member => NULL_MEMBER_FIELDS.some(field => member[field] !== null))) {
    fail("Gamcom seed 밖의 구시즌 참가자 동적값이 남아 있습니다.");
  }
  if (fallback.members.some(member => member.sourceType !== "gamcom" || member.sourceCount !== 1
      || member.verificationStatus !== "baseline" || member.reviewStatus !== "기준값"
      || member.observedAt !== MEMBER_COLLECTED_AT || member.evidence !== GAMCOM_MEMBER_URL)) {
    fail("참가자 Gamcom provenance가 다릅니다.");
  }
  const jogyeonghun = fallback.members.find(member => member.name === "조경훈");
  const gamst = fallback.members.find(member => member.name === "감스트");
  const danchu = fallback.members.find(member => member.name === "단츄");
  const gpt = fallback.members.find(member => member.name === "지피티");
  if (!jogyeonghun || jogyeonghun.crew !== "버인협회" || jogyeonghun.job !== "조조"
      || jogyeonghun.horse !== "백룡마" || jogyeonghun.horseLevel !== 0
      || jogyeonghun.strength !== 20 || jogyeonghun.weapon !== 5
      || !gamst || gamst.crew !== "버컴퍼니" || gamst.job !== "유비"
      || gamst.horse !== "적토마" || gamst.weapon !== 2 || gamst.strength !== 30
      || !danchu || danchu.weapon !== 1 || !gpt || gpt.weapon !== 3) {
    fail("후국지 검증 기준 참가자 값이 다릅니다.");
  }
  const expectedOwners = new Map(Object.entries(EXPECTED_CURRENT_OWNERS).map(([number, owner]) => [Number(number), owner]));
  if (fallback.territories.some(territory => (
    territory.owner !== (expectedOwners.get(territory.number) || "미점령")
    || territory.capital !== Object.hasOwn(EXPECTED_CAPITAL_OWNERS, territory.number)
    || territory.special !== false || territory.facility !== "없음" || territory.level !== 3
    || territory.sourceType !== "gamcom" || territory.sourceCount !== 1
    || territory.verificationStatus !== "baseline" || territory.reviewStatus !== "기준값"
    || territory.observedAt !== TERRITORY_COLLECTED_AT || territory.evidence !== GAMCOM_TERRITORY_URL
  ))) {
    fail("후국지 Gamcom 영토 기준값이 다릅니다.");
  }
  if (fallback.rules.some(rule => rule.sourceDate !== SOURCE_DATE)
      || fallback.rules[0].description !== OVERVIEW_DESCRIPTION
      || !fallback.rules.some(rule => rule.title === SPECIAL_RULE_TITLE
        && rule.description === SPECIAL_RULE_DESCRIPTION && rule.sourceUrl === GAMCOM_TERRITORY_URL)) {
    fail("후국지 게임정보 기준값이 다릅니다.");
  }
  const resetIndex = resetPublicRoster(publicIndex, fallback.members);
  if (resetIndex !== publicIndex) fail("public 정적 roster가 후국지 baseline과 다릅니다.");
  if (resetRuleText(publicClient, "public client") !== publicClient
      || !publicClient.includes(GAMCOM_TERRITORY_URL)) {
    fail("public local rules가 후국지 season=2 기준과 다릅니다.");
  }
  if (resetRuleText(tracker, "legacy tracker") !== tracker
      || !tracker.includes(GAMCOM_TERRITORY_URL)) {
    fail("tracker rules가 후국지 season=2 기준과 다릅니다.");
  }
}

function parseArgs(argv) {
  if (argv.length === 1 && argv[0] === "--check") return { mode: "check" };
  if (argv[0] !== "--write") fail("Usage: node scripts/reset-samguk-fallback-season.js --check | --write --members FILE --territories FILE");
  const options = { mode: "write" };
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!value || !["--members", "--territories"].includes(flag) || options[flag]) {
      fail("Usage: node scripts/reset-samguk-fallback-season.js --check | --write --members FILE --territories FILE");
    }
    options[flag] = value;
  }
  if (!options["--members"] || !options["--territories"]) {
    fail("--write에는 검증된 --members와 --territories seed가 모두 필요합니다.");
  }
  return options;
}

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(path.resolve(filePath), "utf8"));
  } catch (error) {
    fail(`${label} JSON을 읽지 못했습니다: ${error.message}`);
  }
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const fallback = JSON.parse(fs.readFileSync(FALLBACK_PATH, "utf8"));
  const publicIndex = fs.readFileSync(PUBLIC_INDEX_PATH, "utf8");
  const publicClient = fs.readFileSync(PUBLIC_CLIENT_PATH, "utf8");
  const tracker = fs.readFileSync(TRACKER_PATH, "utf8");
  if (options.mode === "check") {
    assertBaseline(fallback, publicIndex, publicClient, tracker);
    return;
  }

  const memberSeed = readJson(options["--members"], "members seed");
  const territorySeed = readJson(options["--territories"], "territories seed");
  const reset = resetFallback(fallback, memberSeed, territorySeed);
  const resetIndex = resetPublicRoster(publicIndex, reset.members);
  const resetClient = resetRuleText(publicClient, "public client");
  const resetTracker = resetRuleText(tracker, "legacy tracker");
  fs.writeFileSync(FALLBACK_PATH, renderFallback(reset), "utf8");
  fs.writeFileSync(PUBLIC_INDEX_PATH, resetIndex, "utf8");
  fs.writeFileSync(PUBLIC_CLIENT_PATH, resetClient, "utf8");
  fs.writeFileSync(TRACKER_PATH, resetTracker, "utf8");
  assertBaseline(reset, resetIndex, resetClient, resetTracker);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  CUTOVER_AT,
  DYNAMIC_MEMBER_FIELDS,
  GAMCOM_MEMBER_URL,
  GAMCOM_TERRITORY_URL,
  MEMBER_COLLECTED_AT,
  NULL_MEMBER_FIELDS,
  OVERVIEW_DESCRIPTION,
  ROSTER_URL,
  SEASON_ID,
  SOURCE_DATE,
  SPECIAL_RULE_DESCRIPTION,
  SPECIAL_RULE_TITLE,
  TERRITORY_COLLECTED_AT,
  assertBaseline,
  resetFallback,
  resetPublicRoster,
  validateMemberSeed,
  validateTerritorySeed,
};
