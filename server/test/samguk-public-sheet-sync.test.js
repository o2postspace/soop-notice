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

test("공개 시트 설치기는 출력·제안·승인원장을 분리하고 링크 뷰어 권한을 검증한다", () => {
  const text = source();
  assert.doesNotThrow(() => new Function(text));
  const orderMatch = text.match(/var SAMGUK_PUBLIC_SHEET_ORDER = (\[[\s\S]*?\]);/);
  assert.ok(orderMatch);
  assert.deepEqual(Array.from(vm.runInNewContext(orderMatch[1])), [
    "안내", "파워랭킹", "스탯·장비", "수정제안", "변경이력", "승인원장", "코드표",
  ]);
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
});

test("공개 출력은 stale이 아닌 고유 90명 API만 받아 사이트와 같은 점수를 125배 표시한다", () => {
  const text = source();
  assert.match(text, /SAMGUK_PUBLIC_API_URL = "https:\/\/api\.soopnotice\.com\/api\/samguk"/);
  assert.match(text, /SAMGUK_PUBLIC_EXPECTED_MEMBER_COUNT = 90/);
  assert.match(text, /payload\.stale !== false/);
  assert.match(text, /payload\.members\.length !== SAMGUK_PUBLIC_EXPECTED_MEMBER_COUNT/);
  assert.match(text, /seen\[rosterMember\.playerId\]/);
  assert.match(text, /Object\.keys\(seen\)\.length !== SAMGUK_PUBLIC_EXPECTED_MEMBER_COUNT/);
  assert.match(text, /SAMGUK_PUBLIC_POWER_SCALE = 125/);
  assert.match(text, /Math\.round\(member\.powerRankScore \* SAMGUK_PUBLIC_POWER_SCALE\)/);
  assert.match(text, /everyMinutes\(15\)/);
  assert.match(text, /LockService\.getScriptLock\(\)/);
});

test("승인 제보는 HTTPS 상승값만 단일 시트 기준값으로 쓰며 교차검증으로 부풀리지 않는다", () => {
  const text = source();
  assert.match(text, /proposal_must_be_higher_than_current/);
  assert.match(text, /https_evidence_required/);
  assert.match(text, /weapon: \{[^\n]+maximum: 15/);
  assert.match(text, /horseLevel: \{[^\n]+maximum: 80/);
  assert.match(text, /attackPower: \{[^\n]+maximum: 1000000/);
  assert.match(text, /"근거종류": "시트"/);
  assert.match(text, /"교차검증수": 1/);
  assert.match(text, /"검증상태": "기준값"/);
  assert.doesNotMatch(text, /"근거종류": "공개현황표\+|"검증상태": "교차검증"/);
  assert.match(text, /record\[SAMGUK_PUBLIC_FIELD_CONFIG\[proposal\.fieldKey\]\.observationHeader\] = proposal\.proposedValue/);
  assert.match(text, /formula_input_not_allowed/);
  assert.match(text, /수식은 입력할 수 없습니다/);
  assert.match(text, /samgukPublicValidateLedgerMatch_/);
  assert.match(text, /samgukPublicValidateMasterObservation_/);
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
