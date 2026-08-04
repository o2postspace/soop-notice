#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const FALLBACK_PATH = path.join(ROOT, "data/samguk-fallback.json");
const OUTPUT_PATH = path.join(__dirname, "google-apps-script/samguk-sheet-seed.generated.gs");
const MEMBER_FIELDS = [
  "name", "soopId", "nation", "crew", "job", "level", "horse", "horseLevel",
  "weapon", "helmet", "armor", "shoes", "strength", "agility", "vitality",
  "intelligence", "powerScore", "maxHealth", "attackPower", "basicAttackDamage",
  "basicAttackSampleCount", "basicAttackTarget", "combatConditions", "healthStat",
  "activeGeneral", "defense", "attackPowerBonusPct", "damageReductionPct",
  "criticalChancePct", "criticalDamagePct", "skillCooldownReductionPct",
  "skillDamageBonusPct", "moveSpeedBonusPct", "horseMaxHealth",
  "strengthBonus", "agilityBonus", "vitalityBonus", "intelligenceBonus",
  "attackPowerIncrease", "moveSpeedIncrease", "healthIncrease", "skillHasteIncrease",
  "skillBuild", "sourceType", "sourceCount", "verificationStatus", "reviewStatus",
  "observedAt", "evidence",
];
const TERRITORY_FIELDS = [
  "id", "number", "x", "y", "owner", "capital", "facility", "level", "special",
  "sourceType", "sourceCount", "verificationStatus", "reviewStatus", "observedAt", "evidence",
];
const RULE_FIELDS = [
  "category", "title", "description", "sourceUrl", "sourceDate", "reviewStatus",
];

function compact(row, fields) {
  return fields.map(field => row[field] === undefined ? null : row[field]);
}

function buildSeed(fallback) {
  if (!fallback || fallback.members?.length !== 90 || fallback.territories?.length !== 60) {
    throw new Error("fallback은 참가자 90명과 영토 60개를 포함해야 합니다.");
  }
  const soopIds = new Set(fallback.members.map(member => member.soopId));
  const territoryNumbers = new Set(fallback.territories.map(territory => territory.number));
  if (soopIds.size !== 90) throw new Error("SOOP_ID가 중복되었습니다.");
  if (territoryNumbers.size !== 60) throw new Error("영토 번호가 중복되었습니다.");
  return {
    version: 1,
    seasonId: fallback.seasonId,
    updatedAt: fallback.updatedAt,
    memberFields: MEMBER_FIELDS,
    members: fallback.members.map((member, index) => [
      `P${String(index + 1).padStart(3, "0")}`,
      ...compact(member, MEMBER_FIELDS),
    ]),
    territoryFields: TERRITORY_FIELDS,
    territories: fallback.territories.map(territory => compact(territory, TERRITORY_FIELDS)),
    ruleFields: RULE_FIELDS,
    rules: (fallback.rules || []).map(rule => compact(rule, RULE_FIELDS)),
  };
}

function render(seed) {
  return [
    "/**",
    " * GENERATED FILE. `node scripts/generate-samguk-sheet-seed.js`로 갱신합니다.",
    " * server/data/samguk-fallback.json의 설치용 기준 스냅샷입니다.",
    " */",
    `var SAMGUK_SETUP_SEED = ${JSON.stringify(seed)};`,
    "",
  ].join("\n");
}

function main(argv = process.argv.slice(2)) {
  const check = argv.includes("--check");
  if (argv.some(argument => argument !== "--check")) {
    throw new Error("Usage: node scripts/generate-samguk-sheet-seed.js [--check]");
  }
  const fallback = JSON.parse(fs.readFileSync(FALLBACK_PATH, "utf8"));
  const output = render(buildSeed(fallback));
  if (check) {
    const current = fs.existsSync(OUTPUT_PATH) ? fs.readFileSync(OUTPUT_PATH, "utf8") : "";
    if (current !== output) throw new Error("samguk-sheet-seed.generated.gs가 최신 fallback과 다릅니다.");
    return;
  }
  fs.writeFileSync(OUTPUT_PATH, output, "utf8");
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { buildSeed, render };
