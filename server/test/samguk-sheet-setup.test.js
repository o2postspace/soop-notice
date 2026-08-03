const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { spawnSync } = require("node:child_process");

const scriptsDirectory = path.resolve(__dirname, "../scripts");
const appsScriptDirectory = path.join(scriptsDirectory, "google-apps-script");
const setupPath = path.join(appsScriptDirectory, "samguk-sheet-setup.gs");
const seedPath = path.join(appsScriptDirectory, "samguk-sheet-seed.generated.gs");
const webhookPath = path.join(appsScriptDirectory, "samguk-observation-webhook.gs");
const gamcomSyncPath = path.join(appsScriptDirectory, "samguk-gamcom-sync.gs");
const builderPath = path.join(scriptsDirectory, "build-samguk-tracker.py");
const fallback = require("../data/samguk-fallback.json");

function source(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function seedPayload() {
  const context = {};
  vm.runInNewContext(source(seedPath), context, { filename: seedPath });
  return context.SAMGUK_SETUP_SEED;
}

test("설치용 generated seed는 현재 fallback의 참가자 90명과 영토 60개를 그대로 담는다", () => {
  const seed = seedPayload();
  assert.equal(seed.version, 1);
  assert.equal(seed.members.length, 90);
  assert.equal(seed.territories.length, 60);
  assert.equal(new Set(seed.members.map(row => row[0])).size, 90);
  assert.equal(new Set(seed.members.map(row => row[2])).size, 90);
  assert.deepEqual(
    Array.from(seed.members[0].slice(1)),
    Array.from(seed.memberFields, field => fallback.members[0][field] ?? null),
  );
  assert.deepEqual(
    Array.from(seed.territories[0]),
    Array.from(seed.territoryFields, field => fallback.territories[0][field] ?? null),
  );

  const check = spawnSync(process.execPath, [path.join(scriptsDirectory, "generate-samguk-sheet-seed.js"), "--check"], {
    encoding: "utf8",
  });
  assert.equal(check.status, 0, check.stderr);
});

test("setup은 14개 운영 탭, seed, 수식과 멱등 백업 전략을 함께 설치한다", () => {
  const text = source(setupPath);
  assert.doesNotThrow(() => new Function(text));
  const setupContext = {};
  vm.runInNewContext(text, setupContext, { filename: setupPath });
  const orderMatch = text.match(/var SAMGUK_SETUP_SHEET_ORDER = (\[[\s\S]*?\]);/);
  assert.ok(orderMatch);
  const order = vm.runInNewContext(orderMatch[1]);
  assert.deepEqual(Array.from(order), [
    "사용법", "게임정보", "기준정보", "참가자", "방송모니터링", "관측입력",
    "현재현황", "장비현황", "무력랭킹", "외부참고", "영토입력", "영토현황", "OCR설정", "변경로그",
  ]);
  assert.equal(setupContext.SAMGUK_SETUP_HEADERS["관측입력"].length, 50);
  assert.equal(setupContext.SAMGUK_SETUP_HEADERS["현재현황"].length, 55);
  assert.deepEqual(Array.from(setupContext.SAMGUK_SETUP_HEADERS["관측입력"].slice(-8)), [
    "무력보너스", "기민보너스", "기력보너스", "지모보너스",
    "공격력증가량", "이동속도증가량", "체력증가량", "절기가속증가량",
  ]);
  assert.deepEqual(Array.from(setupContext.SAMGUK_SETUP_HEADERS["현재현황"].slice(-8)), [
    "무력보너스", "기민보너스", "기력보너스", "지모보너스",
    "공격력증가량", "이동속도증가량", "체력증가량", "절기가속증가량",
  ]);
  assert.match(text, /spreadsheet\.rename\("SOOPNOTICE 삼국지 운영원장"\)/);
  assert.match(text, /백업_" \+ timestamp \+ "_" \+ originalName/);
  assert.match(text, /samgukHeaderMatches_/);
  assert.match(text, /samgukMigrateCommonColumns_/);
  assert.match(text, /samgukArchiveLegacySheets_/);
  assert.match(text, /name\.indexOf\("백업_"\) !== 0/);
  assert.match(text, /sheet\.hideSheet\(\)/);
  assert.match(text, /SAMGUK_SETUP_SEED\.members\.length !== 90/);
  assert.match(text, /SAMGUK_SETUP_SEED\.territories\.length !== 60/);
  assert.match(text, /var memberSeedDate = String\(member\.observedAt \|\| SAMGUK_SETUP_SEED\.updatedAt\)/);
  assert.match(text, /"INIT-" \+ memberSeedDate \+ "-" \+ String\(index \+ 1\)\.padStart\(3, "0"\)/);
  assert.match(text, /samgukInstallCurrentFormulas_/);
  assert.match(text, /samgukMaxAcceptedValueFormula_/);
  assert.match(text, /var monotonicColumns =/);
  const monotonicMatch = text.match(/var monotonicColumns = (\{[\s\S]*?\});/);
  assert.ok(monotonicMatch);
  assert.deepEqual(Object.keys(vm.runInNewContext(`(${monotonicMatch[1]})`)).map(Number), [
    7, 9, 10, 11, 12, 13, 15, 16, 17, 18, 19, 31, 32, 33, 36,
  ]);
  assert.match(text, /31: "Y", 32: "Z"/);
  assert.match(text, /33: "AA", 36: "AE"/);
  assert.match(text, /37: "AF", 38: "AG", 39: "AH", 40: "AI", 41: "AJ"/);
  assert.match(text, /42: "AK", 43: "AL", 44: "AM", 45: "AN", 46: "AO", 47: "AP"/);
  assert.match(text, /48: "AQ", 49: "AR", 50: "AS", 51: "AT", 52: "AU", 53: "AV"/);
  assert.match(text, /54: "AW", 55: "AX"/);
  assert.match(text, /new Array\(55\)\.fill\(""\)/);
  assert.match(text, /getRange\(2, 1, 90, 55\)\.setValues\(rows\)/);
  let currentFormulaWrite;
  setupContext.samgukInstallCurrentFormulas_({
    getRange: (...args) => ({
      setValues: rows => { currentFormulaWrite = { args, rows }; },
    }),
  });
  assert.deepEqual(currentFormulaWrite.args, [2, 1, 90, 55]);
  assert.equal(currentFormulaWrite.rows.length, 90);
  assert.match(currentFormulaWrite.rows[0][47], /INDEX\(관측입력!\$AQ:\$AQ,\$AD2\)/);
  assert.match(currentFormulaWrite.rows[0][48], /INDEX\(관측입력!\$AR:\$AR,\$AD2\)/);
  assert.match(currentFormulaWrite.rows[0][49], /INDEX\(관측입력!\$AS:\$AS,\$AD2\)/);
  assert.match(currentFormulaWrite.rows[0][50], /INDEX\(관측입력!\$AT:\$AT,\$AD2\)/);
  assert.match(currentFormulaWrite.rows[0][51], /INDEX\(관측입력!\$AU:\$AU,\$AD2\)/);
  assert.match(currentFormulaWrite.rows[0][52], /INDEX\(관측입력!\$AV:\$AV,\$AD2\)/);
  assert.match(currentFormulaWrite.rows[0][53], /INDEX\(관측입력!\$AW:\$AW,\$AD2\)/);
  assert.match(currentFormulaWrite.rows[0][54], /INDEX\(관측입력!\$AX:\$AX,\$AD2\)/);
  assert.match(text, /filter: "A1:AX5001"/);
  assert.match(text, /filter: "A1:BC91"/);
  assert.match(text, /"OCR설정": \{ rows: 40,[^\n]+filter: "A1:K40"/);
  assert.match(text, /\["attackPower", "공격력"\]/);
  assert.match(text, /\["healthStat", "체력"\], \["activeGeneral", "현재장수"\]/);
  assert.match(text, /\["horseMaxHealth", "말최대체력"\]/);
  assert.match(text, /\["strengthBonus", "무력보너스"\]/);
  assert.match(text, /\["skillHasteIncrease", "절기가속증가량"\]/);
  assert.match(text, /samgukSeedRowsByCompositeKey_\(sheet, rows, \[1, 2\], 40\)/);
  assert.match(text, /MAX\(FILTER\(/);
  assert.match(text, /RANK\.EQ/);
  assert.match(text, /setProperty\("SAMGUK_SETUP_VERSION"/);
  assert.match(text, /setProperty\("SAMGUK_SPREADSHEET_ID", spreadsheet\.getId\(\)\)/);
  assert.doesNotMatch(text, /"OBS-"&TEXT|"TERR-"&TEXT/);
});

test("OCR설정은 기존 키와 정보창·기량창 19개 동적 키를 빈 ROI로 seed한다", () => {
  const context = {};
  vm.runInNewContext(source(setupPath), context, { filename: setupPath });
  let captured;
  context.samgukSeedRowsByCompositeKey_ = (_sheet, rows, keyColumns, maxRow) => {
    captured = { rows, keyColumns, maxRow };
  };
  context.samgukSeedOcr_({});

  assert.equal(captured.rows.length, 34);
  assert.deepEqual(Array.from(captured.keyColumns), [1, 2]);
  assert.equal(captured.maxRow, 40);
  assert.deepEqual(Array.from(captured.rows, row => String(row[10]).replace("OCR key: ", "")), [
    "level", "horse", "horse_level", "weapon", "helmet", "armor", "shoes", "strength",
    "agility", "vitality", "intelligence", "powerScore", "maxHealth", "basicAttackDamage",
    "attackPower", "healthStat", "activeGeneral", "defense", "attackPowerBonusPct",
    "damageReductionPct", "criticalChancePct", "criticalDamagePct", "skillCooldownReductionPct",
    "skillDamageBonusPct", "moveSpeedBonusPct", "horseMaxHealth", "strengthBonus",
    "agilityBonus", "vitalityBonus", "intelligenceBonus", "attackPowerIncrease",
    "moveSpeedIncrease", "healthIncrease", "skillHasteIncrease",
  ]);
  assert.ok(captured.rows.every(row => Array.from(row.slice(2, 6)).every(value => value === "")));
  assert.ok(captured.rows.every(row => row[8] === "N"));
});

test("setup은 출력 관리자-only와 입력 warning-only 보호, 드롭다운·동결·필터를 구분한다", () => {
  const text = source(setupPath);
  assert.match(text, /samgukProtectAdminOnly_/);
  assert.match(text, /samgukProtectWarningOnly_/);
  assert.match(text, /setUnprotectedRanges/);
  assert.match(text, /SAMGUK_SHEET_ADMIN_EMAILS/);
  assert.match(text, /protection\.canDomainEdit\(\)/);
  assert.match(text, /indexOf\(SAMGUK_SETUP_PROTECTION_PREFIX\) === 0/);
  assert.match(text, /requireValueInRange/);
  assert.match(text, /requireNumberBetween/);
  assert.match(text, /getRange\("H2:H5001"\), 80/);
  assert.match(text, /getRange\("I2:L5001"\), 15/);
  assert.match(text, /\["검증상태", "기준값", "교차검증", "방송교차검증", "충돌", "철회"\]/);
  assert.match(text, /reference\.getRange\("G2:G6"\)/);
  assert.match(text, /getRange\("AE2:AE5001"\), 1000000/);
  assert.match(text, /getRange\("AF2:AF5001"\), 1000000/);
  assert.match(text, /getRange\("AH2:AH5001"\), 1000000/);
  assert.match(text, /getRange\("AI2:AO5001"\), 1000/);
  assert.match(text, /getRange\("AP2:AP5001"\), 1000000/);
  assert.match(text, /getRange\("AQ2:AX5001"\), 1000000/);
  assert.match(text, /getRange\("AQ2:AX5001"\)\.setNumberFormat\("0\.##"\)/);
  assert.match(text, /getRange\("AV2:BC91"\)\.setNumberFormat\("0\.##"\)/);
  assert.doesNotMatch(text, /getRange\("H2:L5001"\), 999/);
  assert.match(text, /setFrozenRows/);
  assert.match(text, /setFrozenColumns/);
  assert.match(text, /createFilter\(\)/);
  assert.match(text, /\["B2:Q5001", "X2:AC5001", "AE2:AX5001"\]/);
  assert.match(text, /samgukProtectInputSheet_\(sheets\["장비현황"\], \["C2:R91"\]\)/);
  assert.match(text, /\["B2:O5001", "S2:S5001"\]/);
  assert.match(text, /samgukProtectInputSheet_\(sheets\["게임정보"\], \["A2:F30"\]\)/);
  assert.match(text, /getRange\("I2:I40"\)/);
  assert.match(text, /getRange\("C2:F40"\), 10000/);
  assert.match(text, /samgukProtectInputSheet_\(sheets\["OCR설정"\], \["C2:K40"\]\)/);
});

test("webhook은 A:AX 전체가 빈 첫 행만 쓰고 미래 관측시각을 400 분류로 거부한다", () => {
  const text = source(webhookPath);
  assert.doesNotThrow(() => new Function(text));
  assert.match(text, /samgukFindFirstEmptyObservationRow_\(sheet, headers\.length\)/);
  assert.match(text, /getRange\(2, 1, SAMGUK_MAX_OBSERVATION_ROW - 1, columnCount\)/);
  assert.match(text, /throw new Error\("target_row_conflict"\)/);
  assert.match(text, /throw new Error\("write_verification_failed"\)/);
  assert.match(text, /throw new Error\("observation_sheet_full"\)/);
  assert.doesNotMatch(text, /targetRow\s*=\s*lastRow\s*\+\s*1/);
  assert.match(text, /observedAt > Date\.now\(\) \+ SAMGUK_MAX_CLOCK_SKEW_MS/);
  assert.match(text, /throw new Error\("future_observed_at"\)/);
  assert.match(text, /return 400/);
  assert.match(text, /"gamcom-max": "기준값"/);
  assert.match(text, /invalid_gamcom_max/);
  assert.match(text, /"healthStat", "defense"/);
  assert.match(text, /healthStat: "체력", activeGeneral: "현재장수"/);
  assert.match(text, /horseLevel: 80/);
  assert.match(text, /weapon: 15/);
  assert.match(text, /helmet: 15/);
  assert.match(text, /armor: 15/);
  assert.match(text, /shoes: 15/);
});

test("Gamcom Apps Script는 최고값 기준과 안정적 중복 제거·트리거 교체 순서를 강제한다", () => {
  const text = source(gamcomSyncPath);
  assert.doesNotThrow(() => new Function(text));
  assert.match(text, /Math\.max\(currentValue, externalValue\)/);
  assert.match(text, /samgukGamcomFillParticipantText_/);
  assert.match(text, /samgukGamcomMigrateLegacyProvenance_/);
  assert.match(text, /samgukGamcomInstallMonotonicFormulas_/);
  assert.match(text, /"검증상태": "기준값"/);
  assert.doesNotMatch(text, /sourceUrl: member\.gamcom\.sourceUrl,\s*collectedAt:/);
  assert.match(text, /var result = syncSamgukGamcom\(\);[\s\S]*getProjectTriggers\(\)/);
});

test("Python 원장 generator도 빈 A열에 ID 수식을 미리 채우지 않는다", () => {
  const text = source(builderPath);
  assert.doesNotMatch(text, /OBS-"&TEXT\(ROW\(\)-1/);
  assert.doesNotMatch(text, /TERR-"&TEXT\(ROW\(\)-1/);
  assert.match(text, /--allow-legacy-schema/);
  assert.match(text, /setupSamgukSheet\(\)/);
  assert.ok(text.indexOf("if not args.allow_legacy_schema") < text.indexOf("result = build_workbook"));
});
