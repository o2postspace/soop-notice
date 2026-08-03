"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const PUBLIC_DIR = path.join(__dirname, "../../public");

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function territory(number, overrides = {}) {
  const group = number <= 20 ? "위" : number <= 40 ? "촉" : "오";
  const start = number <= 20 ? 1 : number <= 40 ? 21 : 41;
  return {
    id: `${group}-${String(number - start + 1).padStart(3, "0")}`,
    number,
    x: 310 + ((number - 1) % 10) * 54,
    y: 115 + Math.floor((number - 1) / 10) * 54,
    owner: "미점령",
    capital: false,
    facility: "없음",
    level: 3,
    observedAt: "2026-08-03T03:04:05.000Z",
    sourceType: "Gamcom",
    ...overrides,
  };
}

async function runClient(payload, { tab = "status" } = {}) {
  const root = { innerHTML: "" };
  const members = [{ name: "감스트", soopId: "devil0108", nation: "촉", crew: "버컴퍼니", job: "유비" }];
  const storage = new Map();
  const context = {
    API_BASE: "",
    AbortController,
    URL,
    console,
    currentSamgukTab: tab,
    currentTab: "samguk",
    SAMGUK_MEMBERS: members,
    SAMGUK_NATIONS: {
      "위": { label: "위", color: "#4169a8" },
      "촉": { label: "촉", color: "#3f8b58" },
      "오": { label: "오", color: "#b94d4d" },
    },
    escapeHtml,
    samgukReviewBadge: () => "",
    renderSamguk: () => {},
    renderSamgukPowerRanking: () => {},
    setInterval: () => 0,
    setTimeout,
    clearTimeout,
    fetch: async () => ({ ok: true, json: async () => payload }),
    localStorage: {
      getItem: key => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, value),
    },
    location: { origin: "https://soopnotice.com" },
    document: {
      hidden: false,
      addEventListener: () => {},
      getElementById: id => id === "samgukTerritoryMap" ? root : null,
    },
  };
  context.window = context;
  context.window.addEventListener = () => {};
  vm.runInNewContext(fs.readFileSync(path.join(PUBLIC_DIR, "samguk.js"), "utf8"), context);
  await context.window.loadSamgukData(true);
  return { context, members, root };
}

test("현황 payload의 정보창 11개 필드를 보존하고 HTML 모양 오염값은 숨긴다", async () => {
  const { members } = await runClient({
    source: "google-sheet",
    updatedAt: "2026-08-03T03:04:05.000Z",
    members: [{
      name: "감스트",
      soopId: "devil0108",
      nation: "촉",
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
      level: '<span class="samguk-empty-value">—</span>',
    }],
    territories: [],
    rules: [],
  });

  assert.deepEqual(
    {
      healthStat: members[0].healthStat,
      activeGeneral: members[0].activeGeneral,
      defense: members[0].defense,
      attackPowerBonusPct: members[0].attackPowerBonusPct,
      damageReductionPct: members[0].damageReductionPct,
      criticalChancePct: members[0].criticalChancePct,
      criticalDamagePct: members[0].criticalDamagePct,
      skillCooldownReductionPct: members[0].skillCooldownReductionPct,
      skillDamageBonusPct: members[0].skillDamageBonusPct,
      moveSpeedBonusPct: members[0].moveSpeedBonusPct,
      horseMaxHealth: members[0].horseMaxHealth,
    },
    {
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
    },
  );
  assert.equal(members[0].level, null);
});

test("영토 화면은 60개 사각 타일·국가 합계·현재 스냅샷 갱신 목록을 렌더링한다", async () => {
  const territories = Array.from({ length: 60 }, (_value, index) => territory(index + 1));
  territories[4] = territory(5, { owner: "위" });
  territories[24] = territory(25, { owner: "촉", capital: true });
  territories[26] = territory(27, { owner: "위" });
  territories[46] = territory(47, { owner: "오", capital: true, facility: "장원" });
  const { root } = await runClient({
    source: "google-sheet",
    updatedAt: "2026-08-03T03:04:05.000Z",
    members: [],
    territories,
    rules: [],
  }, { tab: "territory" });

  assert.equal((root.innerHTML.match(/class="samguk-map-node/g) || []).length, 60);
  assert.equal((root.innerHTML.match(/<circle cx=/g) || []).length, 0);
  assert.match(root.innerHTML, /<rect x=/);
  assert.match(root.innerHTML, /魏 위[\s\S]*?>2</);
  assert.match(root.innerHTML, /蜀 촉[\s\S]*?>1</);
  assert.match(root.innerHTML, /吳 오[\s\S]*?>1</);
  assert.match(root.innerHTML, /최근 영토 갱신/);
  assert.match(root.innerHTML, /현재 스냅샷의 확인시각 기준/);
  assert.match(root.innerHTML, /class="samguk-map-marker is-capital"/);
  assert.match(root.innerHTML, /class="samguk-map-marker is-facility"/);
  assert.match(root.innerHTML, /class="samguk-map-marker is-bonus"/);
});

test("전투 관측 셀은 기량 증가량을 포함해 빈값 없이 최대 다섯 그룹으로 escape해 표시한다", () => {
  const html = fs.readFileSync(path.join(PUBLIC_DIR, "index.html"), "utf8");
  const combatCell = html.match(/function combatCell\(member\) \{[\s\S]*?\n  \}/)?.[0] || "";

  for (const field of [
    "healthStat", "activeGeneral", "defense", "attackPowerBonusPct", "damageReductionPct",
    "criticalChancePct", "criticalDamagePct", "skillCooldownReductionPct", "skillDamageBonusPct",
    "moveSpeedBonusPct", "horseMaxHealth", "strengthBonus", "agilityBonus", "vitalityBonus",
    "intelligenceBonus", "attackPowerIncrease", "moveSpeedIncrease", "healthIncrease", "skillHasteIncrease",
  ]) {
    assert.match(combatCell, new RegExp(`member\\.${field}`));
  }
  assert.match(combatCell, /filter\(Boolean\)/);
  assert.match(combatCell, /if \(damage\) primary\.push\(damage \+ \(samples !== null/);
  assert.match(combatCell, /escapeHtml\(group\.join\(' · '\)\)/);
  assert.match(combatCell, /const groups = \[primary, character, rates, skillRates, quantity\]/);
  assert.match(combatCell, /metric\('무력\+', member\.strengthBonus\)/);
  assert.match(combatCell, /metric\('절기가속', member\.skillHasteIncrease\)/);
  assert.match(combatCell, /파워 v1\.5 미반영/);
  assert.doesNotMatch(html, /return '<span class="samguk-empty-value">—<\/span>'/);
  assert.match(html, /samguk\.css\?v=20260803c/);
  assert.match(html, /samguk\.js\?v=20260803d/);
});
