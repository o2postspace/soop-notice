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
  const orderMatch = text.match(/var SAMGUK_SETUP_SHEET_ORDER = (\[[\s\S]*?\]);/);
  assert.ok(orderMatch);
  const order = vm.runInNewContext(orderMatch[1]);
  assert.deepEqual(Array.from(order), [
    "사용법", "게임정보", "기준정보", "참가자", "방송모니터링", "관측입력",
    "현재현황", "장비현황", "무력랭킹", "외부참고", "영토입력", "영토현황", "OCR설정", "변경로그",
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
  assert.match(text, /samgukInstallCurrentFormulas_/);
  assert.match(text, /samgukMaxAcceptedValueFormula_/);
  assert.match(text, /var monotonicColumns =/);
  assert.match(text, /31: "Y", 36: "AE"/);
  assert.match(text, /MAX\(FILTER\(/);
  assert.match(text, /RANK\.EQ/);
  assert.match(text, /setProperty\("SAMGUK_SETUP_VERSION"/);
  assert.match(text, /setProperty\("SAMGUK_SPREADSHEET_ID", spreadsheet\.getId\(\)\)/);
  assert.doesNotMatch(text, /"OBS-"&TEXT|"TERR-"&TEXT/);
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
  assert.doesNotMatch(text, /getRange\("H2:L5001"\), 999/);
  assert.match(text, /setFrozenRows/);
  assert.match(text, /setFrozenColumns/);
  assert.match(text, /createFilter\(\)/);
  assert.match(text, /\["B2:Q5001", "X2:AC5001", "AE2:AE5001"\]/);
  assert.match(text, /samgukProtectInputSheet_\(sheets\["장비현황"\], \["C2:R91"\]\)/);
  assert.match(text, /\["B2:O5001", "S2:S5001"\]/);
  assert.match(text, /samgukProtectInputSheet_\(sheets\["게임정보"\], \["A2:F30"\]\)/);
});

test("webhook은 A:AE 전체가 빈 첫 행만 쓰고 미래 관측시각을 400 분류로 거부한다", () => {
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
});
