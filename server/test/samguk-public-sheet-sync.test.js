"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const scriptPath = path.resolve(
  __dirname,
  "../scripts/google-apps-script/samguk-public-sheet-sync.gs",
);

function source() {
  return fs.readFileSync(scriptPath, "utf8");
}

function seasonMarkerSpreadsheet(rows) {
  return {
    getSheetByName: name => name === "게임정보" ? {
      getLastRow: () => rows.length,
      getRange: () => ({ getDisplayValues: () => rows }),
    } : null,
  };
}

test("공개 시트 설치기는 출력·제안·승인원장을 분리하고 링크 뷰어 권한을 검증한다", () => {
  const text = source();
  assert.doesNotThrow(() => new Function(text));
  const context = {};
  vm.runInNewContext(text, context, { filename: scriptPath });
  const orderMatch = text.match(/var SAMGUK_PUBLIC_SHEET_ORDER = (\[[\s\S]*?\]);/);
  assert.ok(orderMatch);
  assert.deepEqual(Array.from(vm.runInNewContext(orderMatch[1])), [
    "안내", "파워랭킹", "스탯·장비", "수정제안", "변경이력", "승인원장", "코드표",
  ]);
  assert.equal(context.SAMGUK_PUBLIC_SEASON_ID, "hugukji-2026-08-04");
  assert.equal(context.SAMGUK_PUBLIC_DEFAULT_MASTER_SPREADSHEET_ID, "1yMUytX11t-SzB9Tz9tpizj0Dyc1iIC2H2utQpycUuTQ");
  assert.equal(context.SAMGUK_PUBLIC_HEADERS["파워랭킹"].at(-1), "절기배분");
  assert.equal(context.SAMGUK_PUBLIC_HEADERS["스탯·장비"].at(-1), "절기배분");
  assert.match(text, /DriveApp\.Access\.ANYONE_WITH_LINK, DriveApp\.Permission\.VIEW/);
  assert.match(text, /setShareableByEditors\(false\)/);
  assert.match(text, /file\.getSharingAccess\(\) !== DriveApp\.Access\.ANYONE_WITH_LINK/);
  assert.match(text, /file\.getSharingPermission\(\) !== DriveApp\.Permission\.VIEW/);
  assert.match(text, /samgukPublicProtectSheet_\(proposal, \[/);
  assert.match(text, /getRange\("C2:C" \+ SAMGUK_PUBLIC_MAX_PROPOSAL_ROW\)/);
  assert.match(text, /getRange\("E2:E" \+ SAMGUK_PUBLIC_MAX_PROPOSAL_ROW\)/);
  assert.match(text, /getRange\("G2:K" \+ SAMGUK_PUBLIC_MAX_PROPOSAL_ROW\)/);
  assert.match(text, /\["승인", "거절", "철회"\]/);
  const syncBody = text.match(/function syncSamgukPublicSheet\(\) \{([\s\S]*?)\n\}/);
  assert.ok(syncBody);
  assert.doesNotMatch(syncBody[1], /samgukPublicPrepareWorkbook_|samgukPublicApplyProtections_/);
  assert.match(text, /samgukPublicEventUserEmail_/);
  assert.match(text, /samgukPublicIsAdminEmail_/);
  assert.match(text, /samgukPublicAssertMasterSeason_\(spreadsheet\)/);
});

test("공개 시트는 실제 운영원장의 후국지 시즌 마커만 허용한다", () => {
  const text = source();
  const context = {};
  vm.runInNewContext(text, context, { filename: scriptPath });
  const currentSeason = context.SAMGUK_PUBLIC_SEASON_ID;
  const valid = [["분류", "항목", "내용"], ["시즌", "season_id", currentSeason]];

  assert.doesNotThrow(() => context.samgukPublicAssertMasterSeason_(seasonMarkerSpreadsheet(valid)));
  for (const rows of [
    [["분류", "항목", "내용"]],
    [["시즌", "season_id", "samgukji-2026-07-31"]],
    [["기타", "season_id", currentSeason]],
    [["시즌", "SEASON_ID", currentSeason]],
    [...valid, ["시즌", "season_id", currentSeason]],
  ]) {
    assert.throws(
      () => context.samgukPublicAssertMasterSeason_(seasonMarkerSpreadsheet(rows)),
      /invalid_season/,
    );
  }
});

test("공개 출력은 stale이 아닌 고유 90명 API만 받아 사이트와 같은 점수를 125배 표시한다", () => {
  const text = source();
  assert.match(text, /SAMGUK_PUBLIC_API_URL = "https:\/\/api\.soopnotice\.com\/api\/samguk\?refresh=1"/);
  assert.match(text, /SAMGUK_PUBLIC_EXPECTED_MEMBER_COUNT = 90/);
  assert.match(text, /payload\.stale !== false/);
  assert.match(text, /payload\.seasonId !== SAMGUK_PUBLIC_SEASON_ID/);
  assert.match(text, /payload\.members\.length !== SAMGUK_PUBLIC_EXPECTED_MEMBER_COUNT/);
  assert.match(text, /seen\[rosterMember\.playerId\]/);
  assert.match(text, /Object\.keys\(seen\)\.length !== SAMGUK_PUBLIC_EXPECTED_MEMBER_COUNT/);
  assert.match(text, /SAMGUK_PUBLIC_POWER_SCALE = 125/);
  assert.match(text, /Math\.round\(member\.powerRankScore \* SAMGUK_PUBLIC_POWER_SCALE\)/);
  assert.match(text, /파워 v1\.6/);
  assert.match(text, /기량 1점당 파워 1점/);
  assert.doesNotMatch(text, /고정 600점/);
  assert.match(text, /SAMGUK_PUBLIC_SYNC_INTERVAL_MINUTES = 5/);
  assert.match(text, /everyMinutes\(SAMGUK_PUBLIC_SYNC_INTERVAL_MINUTES\)/);
  assert.match(text, /레벨·강화·무\/민\/기\/지·최대체력·공격력은 확인된 최고값/);
  assert.match(text, /동적 정보창 수치는 최신 관측값/);
  assert.match(text, /LockService\.getScriptLock\(\)/);
  assert.match(text, /healthStat: number\("healthStat", 1000000\)/);
  assert.match(text, /horseMaxHealth: number\("horseMaxHealth", 1000000\)/);
  assert.match(text, /samgukPublicBlank_\(member\.healthStat\), member\.activeGeneral/);
  assert.match(text, /samgukPublicSkillBuildCell_\(member\.skillBuild\)/);
  assert.match(text, /"말최대체력", "절기배분"/);

  const context = {};
  vm.runInNewContext(text, context, { filename: scriptPath });
  const skillBuild = {
    version: 1,
    preset: null,
    ownedPoints: 5,
    skills: Array.from({ length: 6 }, (_value, index) => ({
      name: `절기 ${index + 1}`,
      requiredPoints: index + 10,
      allocatedPoints: index,
    })),
  };
  const normalized = context.samgukPublicNormalizeMember_({
    name: "테스트",
    soopId: "test_bj",
    nation: "위",
    skillBuild,
  }, { playerId: "P001" });
  assert.equal(JSON.stringify(normalized.skillBuild), JSON.stringify(skillBuild));
  assert.equal(
    context.samgukPublicBuildDetailRows_([normalized])[0].at(-1),
    "총배분 15 · 강화 5/6 · 남은 5 · 프리셋 미확인 | 절기 1 0/10 | 절기 2 1/11"
      + " | 절기 3 2/12 | 절기 4 3/13 | 절기 5 4/14 | 절기 6 5/15",
  );
  assert.doesNotMatch(context.samgukPublicBuildRankingRows_([normalized])[0].at(-1), /^\{/);
  const nineRowBuild = {
    ...skillBuild,
    skills: Array.from({ length: 9 }, (_value, index) => ({
      name: `직업 절기 ${index + 1}`,
      requiredPoints: index + 1,
      allocatedPoints: index % 3,
    })),
  };
  assert.equal(
    context.samgukPublicNormalizeSkillBuild_(nineRowBuild).skills.length,
    9,
  );
  assert.throws(
    () => context.samgukPublicNormalizeSkillBuild_({ ...skillBuild, skills: skillBuild.skills.slice(0, 5) }),
    /public_api_invalid_field:skillBuild/,
  );
});

test("승인 제보는 HTTPS 상승값만 단일 시트 기준값으로 쓰며 교차검증으로 부풀리지 않는다", () => {
  const text = source();
  assert.match(text, /proposal_must_be_higher_than_current/);
  assert.match(text, /https_evidence_required/);
  assert.match(text, /weapon: \{[^\n]+maximum: 15/);
  assert.match(text, /horseLevel: \{[^\n]+maximum: 80/);
  assert.match(text, /attackPower: \{[^\n]+maximum: 1000000/);
  assert.match(text, /healthStat: \{[^\n]+integer: false, higherOnly: false/);
  assert.match(text, /defense: \{[^\n]+integer: false, higherOnly: false/);
  assert.match(text, /horseMaxHealth: \{[^\n]+higherOnly: false/);
  assert.match(text, /config\.higherOnly === false && currentValue !== null && numericValue === currentValue/);
  assert.match(text, /"근거종류": "시트"/);
  assert.match(text, /"교차검증수": 1/);
  assert.match(text, /"검증상태": "기준값"/);
  assert.doesNotMatch(text, /"근거종류": "공개현황표\+|"검증상태": "교차검증"/);
  assert.match(text, /record\[SAMGUK_PUBLIC_FIELD_CONFIG\[proposal\.fieldKey\]\.observationHeader\] = proposal\.proposedValue/);
  assert.match(text, /formula_input_not_allowed/);
  assert.match(text, /수식은 입력할 수 없습니다/);
  assert.match(text, /samgukPublicValidateLedgerMatch_/);
  assert.match(text, /samgukPublicValidateMasterObservation_/);
  assert.match(text, /Object\.keys\(SAMGUK_PUBLIC_FIELD_CONFIG\)\.length/);
  assert.match(text, /approved_proposal_must_be_revoked/);
});

test("관측 ID는 수집 실행시각과 무관하게 제안 근거에서 결정되고 승인값은 철회 가능하다", () => {
  const text = source();
  assert.match(
    text,
    /var observationId = "OBS-PUBLIC-" \+ samgukPublicSha256Hex_\(\[\s*proposalId, playerId, fieldKey, String\(numericValue\), timestamp\.toISOString\(\), evidenceUrl/,
  );
  assert.doesNotMatch(text, /observationId[\s\S]{0,250}Date\.now\(\)/);
  assert.match(text, /masterStatusCell\.setValue\("철회"\)/);
  assert.match(text, /ledgerStatusCell\.setValue\("revoked"\)/);
  assert.match(text, /samgukPublicSnapshotRange_\(ledgerRevokeRange\)/);
  assert.match(text, /samgukPublicRestoreRangeSnapshot_\(mutation\.ledgerRevoke/);
  assert.match(text, /samgukPublicRestoreRangeSnapshot_\(mutation\.ledgerStatus/);
  assert.match(text, /samgukPublicRestoreRangeSnapshot_\(mutation\.master/);
  assert.match(text, /"active"/);
  assert.match(text, /SAMGUK_PUBLIC_SCHEMA_VERSION/);
});

test("승인·철회 중간 실패는 master·ledger·history·UI를 역순 보상하고 실패 자체도 기록한다", () => {
  const text = source();
  assert.match(text, /masterMutation: masterResult\.mutation \|\| null/);
  assert.match(text, /samgukPublicWriteTrackedEmptyRange_\(target, values/);
  assert.match(text, /samgukPublicRollbackAppendedRow_\(approvalHistoryMutation, "approval_history"\)/);
  assert.match(text, /samgukPublicRollbackAppendedRow_\(ledgerMutation, "approval_ledger"\)/);
  assert.match(text, /samgukPublicRestoreProposalSystemCells_\(approvalUiSnapshot\)/);
  assert.match(text, /approved && approved\.masterMutation/);
  assert.match(text, /revoked && revoked\.revokeMutation/);
  assert.match(text, /samgukPublicRollbackRevokeMutation_\(revokeMutation\)/);
  assert.match(text, /rollback_failed\[/);
  assert.match(text, /SAMGUK_PUBLIC_TRANSACTION_ERROR/);
  assert.match(text, /SAMGUK_PUBLIC_PROCESS_ERROR/);
  assert.match(text, /처리완료 상태는 대기·빈값으로 되돌릴 수 없습니다/);
  assert.doesNotMatch(text, /sheet\.appendRow\(/);
});
