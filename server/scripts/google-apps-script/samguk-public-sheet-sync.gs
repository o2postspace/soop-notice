/**
 * SOOPNOTICE 후국지 공개 현황 시트 설치기와 승인 제보 동기화.
 *
 * 이 파일은 비공개 운영원장에 바인딩된 Apps Script 프로젝트에서 실행합니다.
 * 공개 시트에는 표시값과 수정제안만 두고, 승인된 제안만 운영원장 관측입력에
 * 단일 sheet 기준값으로 추가합니다. 공개 시트는 독립 교차검증 출처로 세지 않습니다.
 */

var SAMGUK_PUBLIC_SCHEMA_VERSION = "2026.08.05.1";
var SAMGUK_PUBLIC_SEASON_ID = "hugukji-2026-08-04";
var SAMGUK_PUBLIC_DEFAULT_MASTER_SPREADSHEET_ID = "1yMUytX11t-SzB9Tz9tpizj0Dyc1iIC2H2utQpycUuTQ";
var SAMGUK_PUBLIC_API_URL = "https://api.soopnotice.com/api/samguk?refresh=1";
var SAMGUK_PUBLIC_SITE_URL = "https://soopnotice.com";
var SAMGUK_PUBLIC_EXPECTED_MEMBER_COUNT = 90;
var SAMGUK_PUBLIC_POWER_SCALE = 125;
var SAMGUK_PUBLIC_SYNC_INTERVAL_MINUTES = 5;
var SAMGUK_PUBLIC_MAX_PROPOSAL_ROW = 1001;
var SAMGUK_PUBLIC_MAX_MASTER_OBSERVATION_ROW = 5001;
var SAMGUK_PUBLIC_PROTECTION_PREFIX = "[SOOPNOTICE_PUBLIC]";
var SAMGUK_PUBLIC_ID_PROPERTY = "SAMGUK_PUBLIC_SPREADSHEET_ID";
var SAMGUK_PUBLIC_SYNCED_AT_PROPERTY = "SAMGUK_PUBLIC_SYNCED_AT";
var SAMGUK_PUBLIC_SHEET_ORDER = [
  "안내", "파워랭킹", "스탯·장비", "수정제안", "변경이력", "승인원장", "코드표"
];

var SAMGUK_PUBLIC_HEADERS = {
  "안내": ["SOOPNOTICE 후국지 공개 현황"],
  "파워랭킹": [
    "순위", "player_id", "국가", "닉네임", "세력/길드", "장수/직업", "파워점수",
    "수집률", "상태", "레벨", "무력", "기민", "기력", "지모", "무기강화",
    "두갑강화", "흉갑강화", "각갑강화", "말", "말강화", "최대체력", "공격력",
    "최종확인", "SOOP 방송", "체력", "현재장수", "방어력", "공격력증가(%)",
    "피해감소(%)", "치명타확률(%)", "치명타피해(%)", "스킬쿨타임감소(%)",
    "스킬피해증가(%)", "이동속도증가(%)", "말최대체력", "무력보너스",
    "기민보너스", "기력보너스", "지모보너스", "공격력증가량", "이동속도증가량",
    "체력증가량", "절기가속증가량", "절기배분"
  ],
  "스탯·장비": [
    "player_id", "국가", "닉네임", "SOOP_ID", "세력/길드", "장수/직업", "레벨",
    "말", "말강화", "무기강화", "두갑강화", "흉갑강화", "각갑강화", "무력",
    "기민", "기력", "지모", "최대체력", "공격력", "평타피해", "파워점수",
    "수집률", "출처", "출처수", "검증상태", "최종확인", "근거", "체력",
    "현재장수", "방어력", "공격력증가(%)", "피해감소(%)", "치명타확률(%)",
    "치명타피해(%)", "스킬쿨타임감소(%)", "스킬피해증가(%)", "이동속도증가(%)",
    "말최대체력", "무력보너스", "기민보너스", "기력보너스", "지모보너스",
    "공격력증가량", "이동속도증가량", "체력증가량", "절기가속증가량", "절기배분"
  ],
  "수정제안": [
    "proposal_id", "제출시각", "player_id", "닉네임", "field_key", "현재값", "제안값",
    "관측시각", "출처유형", "근거URL", "설명", "처리상태", "검수메모", "검수자",
    "검수시각", "master_observation_id", "master_row"
  ],
  "변경이력": [
    "처리시각", "proposal_id", "player_id", "닉네임", "field_key", "이전값", "제안값",
    "처리", "근거URL", "master_observation_id", "메모"
  ],
  "승인원장": [
    "record_id", "proposal_id", "player_id", "field_key", "value", "source_type",
    "evidence_url", "observed_at", "approved_at", "status", "master_observation_id",
    "master_row", "revoked_at", "revoke_reason", "schema_version"
  ],
  "코드표": [
    "player_id", "닉네임", "SOOP_ID", "국가", "", "field_key", "표시명", "상한", "정수"
  ]
};

var SAMGUK_PUBLIC_FIELD_CONFIG = {
  level: { label: "레벨", currentHeader: "레벨", observationHeader: "레벨", maximum: 10000, integer: true },
  horseLevel: { label: "말강화", currentHeader: "말강화", observationHeader: "말강화", maximum: 80, integer: true },
  weapon: { label: "무기강화", currentHeader: "무기강화", observationHeader: "무기강화", maximum: 15, integer: true },
  helmet: { label: "두갑강화", currentHeader: "두갑강화", observationHeader: "두갑강화", maximum: 15, integer: true },
  armor: { label: "흉갑강화", currentHeader: "흉갑강화", observationHeader: "흉갑강화", maximum: 15, integer: true },
  shoes: { label: "각갑강화", currentHeader: "각갑강화", observationHeader: "각갑강화", maximum: 15, integer: true },
  strength: { label: "무력", currentHeader: "무력", observationHeader: "무력", maximum: 1000000, integer: true },
  agility: { label: "기민", currentHeader: "기민", observationHeader: "기민", maximum: 1000000, integer: true },
  vitality: { label: "기력", currentHeader: "기력", observationHeader: "기력", maximum: 1000000, integer: true },
  intelligence: { label: "지모", currentHeader: "지모", observationHeader: "지모", maximum: 1000000, integer: true },
  maxHealth: { label: "최대체력", currentHeader: "최대체력", observationHeader: "최대체력", maximum: 1000000, integer: true },
  attackPower: { label: "공격력", currentHeader: "공격력", observationHeader: "공격력", maximum: 1000000, integer: false },
  healthStat: { label: "체력", currentHeader: "체력", observationHeader: "체력", maximum: 1000000, integer: false, higherOnly: false },
  defense: { label: "방어력", currentHeader: "방어력", observationHeader: "방어력", maximum: 1000000, integer: false, higherOnly: false },
  attackPowerBonusPct: { label: "공격력증가(%)", currentHeader: "공격력증가(%)", observationHeader: "공격력증가(%)", maximum: 1000, integer: false, higherOnly: false },
  damageReductionPct: { label: "피해감소(%)", currentHeader: "피해감소(%)", observationHeader: "피해감소(%)", maximum: 1000, integer: false, higherOnly: false },
  criticalChancePct: { label: "치명타확률(%)", currentHeader: "치명타확률(%)", observationHeader: "치명타확률(%)", maximum: 1000, integer: false, higherOnly: false },
  criticalDamagePct: { label: "치명타피해(%)", currentHeader: "치명타피해(%)", observationHeader: "치명타피해(%)", maximum: 1000, integer: false, higherOnly: false },
  skillCooldownReductionPct: { label: "스킬쿨타임감소(%)", currentHeader: "스킬쿨타임감소(%)", observationHeader: "스킬쿨타임감소(%)", maximum: 1000, integer: false, higherOnly: false },
  skillDamageBonusPct: { label: "스킬피해증가(%)", currentHeader: "스킬피해증가(%)", observationHeader: "스킬피해증가(%)", maximum: 1000, integer: false, higherOnly: false },
  moveSpeedBonusPct: { label: "이동속도증가(%)", currentHeader: "이동속도증가(%)", observationHeader: "이동속도증가(%)", maximum: 1000, integer: false, higherOnly: false },
  horseMaxHealth: { label: "말최대체력", currentHeader: "말최대체력", observationHeader: "말최대체력", maximum: 1000000, integer: true, higherOnly: false },
  strengthBonus: { label: "무력보너스", currentHeader: "무력보너스", observationHeader: "무력보너스", maximum: 1000000, integer: false, higherOnly: false },
  agilityBonus: { label: "기민보너스", currentHeader: "기민보너스", observationHeader: "기민보너스", maximum: 1000000, integer: false, higherOnly: false },
  vitalityBonus: { label: "기력보너스", currentHeader: "기력보너스", observationHeader: "기력보너스", maximum: 1000000, integer: false, higherOnly: false },
  intelligenceBonus: { label: "지모보너스", currentHeader: "지모보너스", observationHeader: "지모보너스", maximum: 1000000, integer: false, higherOnly: false },
  attackPowerIncrease: { label: "공격력증가량", currentHeader: "공격력증가량", observationHeader: "공격력증가량", maximum: 1000000, integer: false, higherOnly: false },
  moveSpeedIncrease: { label: "이동속도증가량", currentHeader: "이동속도증가량", observationHeader: "이동속도증가량", maximum: 1000000, integer: false, higherOnly: false },
  healthIncrease: { label: "체력증가량", currentHeader: "체력증가량", observationHeader: "체력증가량", maximum: 1000000, integer: false, higherOnly: false },
  skillHasteIncrease: { label: "절기가속증가량", currentHeader: "절기가속증가량", observationHeader: "절기가속증가량", maximum: 1000000, integer: false, higherOnly: false }
};

var SAMGUK_PUBLIC_SOURCE_TYPES = [
  "방송직접확인", "SOOP VOD", "공식시트", "FMKorea", "Gamcom", "기타 공개자료"
];

/**
 * 공개 시트를 새로 만들거나 기존 시트를 멱등 업데이트하고 5분 동기화를 설치합니다.
 */
function installSamgukPublicSheet() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error("public_sheet_busy");
  try {
    var properties = PropertiesService.getScriptProperties();
    var publicSpreadsheet = samgukPublicOpenOrCreate_(properties);
    samgukPublicPrepareWorkbook_(publicSpreadsheet);
    var result = samgukPublicSyncUnlocked_(publicSpreadsheet);
    samgukPublicConfigureSharing_(publicSpreadsheet);
    samgukPublicInstallTriggers_(publicSpreadsheet);
    properties.setProperty(SAMGUK_PUBLIC_ID_PROPERTY, publicSpreadsheet.getId());
    var summary = {
      ok: true,
      spreadsheetId: publicSpreadsheet.getId(),
      url: publicSpreadsheet.getUrl(),
      members: result.members,
      syncedAt: result.syncedAt,
      sharing: "ANYONE_WITH_LINK_VIEW"
    };
    console.log("SAMGUK_PUBLIC_SHEET_URL=" + summary.url);
    return summary;
  } finally {
    lock.releaseLock();
  }
}

/** 5분 트리거에서 호출하는 공개 출력 동기화 함수입니다. */
function syncSamgukPublicSheet() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error("public_sheet_busy");
  try {
    var publicSpreadsheet = samgukPublicSpreadsheet_();
    samgukPublicValidateWorkbook_(publicSpreadsheet);
    samgukPublicSeedCodeTable_(publicSpreadsheet.getSheetByName("코드표"));
    return samgukPublicSyncUnlocked_(publicSpreadsheet);
  } finally {
    lock.releaseLock();
  }
}

/** 설치형 onEdit 트리거입니다. */
function handleSamgukPublicEdit(event) {
  if (!event || !event.range) return;
  var spreadsheet = event.source;
  var configuredId = PropertiesService.getScriptProperties().getProperty(SAMGUK_PUBLIC_ID_PROPERTY);
  if (!spreadsheet || !configuredId || spreadsheet.getId() !== configuredId) return;
  var sheet = event.range.getSheet();
  if (sheet.getName() !== "수정제안" || event.range.getLastRow() < 2) return;

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error("public_sheet_busy");
  try {
    var firstRow = Math.max(2, event.range.getRow());
    var lastRow = Math.min(SAMGUK_PUBLIC_MAX_PROPOSAL_ROW, event.range.getLastRow());
    var firstColumn = event.range.getColumn();
    var lastColumn = event.range.getLastColumn();
    var inputEdited = samgukPublicRangesOverlap_(firstColumn, lastColumn, [[3, 3], [5, 5], [7, 11]]);
    var statusEdited = firstColumn <= 12 && lastColumn >= 12;

    for (var row = firstRow; row <= lastRow; row += 1) {
      if (inputEdited && samgukPublicClearFormulaInputs_(sheet, row)) continue;
      if (inputEdited) samgukPublicRefreshProposalRow_(spreadsheet, sheet, row, true);
      if (statusEdited) {
        var editorEmail = samgukPublicEventUserEmail_(event);
        if (!editorEmail) {
          sheet.getRange(row, 13).setValue("관리자 신원을 확인할 수 없어 수동 처리 대기");
        } else if (!samgukPublicIsAdminEmail_(spreadsheet, editorEmail)) {
          var canonical = samgukPublicCanonicalProposalStatus_(spreadsheet, sheet.getRange(row, 1, 1, 17).getValues()[0]);
          sheet.getRange(row, 12).setValue(canonical === "오류" ? "대기" : canonical);
          sheet.getRange(row, 13).setValue("관리자만 처리상태를 변경할 수 있습니다.");
        } else {
          samgukPublicProcessProposalStatus_(spreadsheet, sheet, row);
        }
      }
    }
  } finally {
    lock.releaseLock();
  }
}

/**
 * 설치형 onEdit에서 사용자 식별이 제한된 계정용 관리자 수동 처리 함수입니다.
 * 비공개 Apps Script 프로젝트를 실행할 수 있는 운영자만 호출할 수 있습니다.
 */
function processSamgukPublicAdminActions() {
  var spreadsheet = samgukPublicSpreadsheet_();
  var effectiveEmail = Session.getEffectiveUser().getEmail() || "";
  if (!effectiveEmail || !samgukPublicIsAdminEmail_(spreadsheet, effectiveEmail)) {
    throw new Error("public_admin_required");
  }
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error("public_sheet_busy");
  try {
    var sheet = spreadsheet.getSheetByName("수정제안");
    var lastRow = Math.min(sheet.getLastRow(), SAMGUK_PUBLIC_MAX_PROPOSAL_ROW);
    var processed = 0;
    for (var row = 2; row <= lastRow; row += 1) {
      var status = String(sheet.getRange(row, 12).getDisplayValue() || "").trim();
      if (["승인", "거절", "철회"].indexOf(status) >= 0) {
        samgukPublicProcessProposalStatus_(spreadsheet, sheet, row);
        processed += 1;
      }
    }
    console.log("SAMGUK_PUBLIC_ADMIN_ACTIONS=" + processed);
    return { ok: true, processed: processed };
  } finally {
    lock.releaseLock();
  }
}

function getSamgukPublicSheetInfo() {
  var spreadsheet = samgukPublicSpreadsheet_();
  var file = DriveApp.getFileById(spreadsheet.getId());
  var ranking = spreadsheet.getSheetByName("파워랭킹");
  var detail = spreadsheet.getSheetByName("스탯·장비");
  var triggers = ScriptApp.getProjectTriggers();
  var info = {
    spreadsheetId: spreadsheet.getId(),
    url: spreadsheet.getUrl(),
    sharingAccess: String(file.getSharingAccess()),
    sharingPermission: String(file.getSharingPermission()),
    editorsCanShare: file.isShareableByEditors(),
    syncedAt: PropertiesService.getScriptProperties().getProperty(SAMGUK_PUBLIC_SYNCED_AT_PROPERTY) || "",
    rankingRows: ranking ? Math.max(0, ranking.getLastRow() - 1) : -1,
    detailRows: detail ? Math.max(0, detail.getLastRow() - 1) : -1,
    syncTriggers: triggers.filter(function(trigger) {
      return trigger.getHandlerFunction() === "syncSamgukPublicSheet";
    }).length,
    editTriggers: triggers.filter(function(trigger) {
      return trigger.getHandlerFunction() === "handleSamgukPublicEdit";
    }).length
  };
  console.log("SAMGUK_PUBLIC_SHEET_INFO=" + JSON.stringify(info));
  return info;
}

function samgukPublicOpenOrCreate_(properties) {
  var configuredId = properties.getProperty(SAMGUK_PUBLIC_ID_PROPERTY);
  if (configuredId) {
    try {
      return SpreadsheetApp.openById(configuredId);
    } catch (error) {
      throw new Error("configured_public_sheet_unavailable:" + String(error && error.message || error));
    }
  }
  var spreadsheet = SpreadsheetApp.create("SOOPNOTICE 후국지 공개 현황·파워랭킹", 1001, 27);
  properties.setProperty(SAMGUK_PUBLIC_ID_PROPERTY, spreadsheet.getId());
  return spreadsheet;
}

function samgukPublicSpreadsheet_() {
  var spreadsheetId = PropertiesService.getScriptProperties().getProperty(SAMGUK_PUBLIC_ID_PROPERTY);
  if (!spreadsheetId) throw new Error("public_sheet_not_installed");
  return SpreadsheetApp.openById(spreadsheetId);
}

function samgukPublicMasterSpreadsheet_() {
  var properties = PropertiesService.getScriptProperties();
  var spreadsheetId = properties.getProperty("SAMGUK_SPREADSHEET_ID")
    || SAMGUK_PUBLIC_DEFAULT_MASTER_SPREADSHEET_ID;
  var publicId = properties.getProperty(SAMGUK_PUBLIC_ID_PROPERTY);
  if (spreadsheetId === publicId) throw new Error("public_sheet_cannot_be_master");
  var spreadsheet = SpreadsheetApp.openById(spreadsheetId);
  samgukPublicAssertMasterSeason_(spreadsheet);
  return spreadsheet;
}

function samgukPublicAssertMasterSeason_(spreadsheet) {
  var rules = spreadsheet.getSheetByName("게임정보");
  if (!rules) throw new Error("master_rules_missing");
  var rowCount = Math.max(1, Math.min(30, rules.getLastRow()));
  var rows = rules.getRange(1, 1, rowCount, 3).getDisplayValues();
  var markers = rows.filter(function(row) {
    return String(row[1] || "").trim().toLowerCase() === "season_id";
  });
  if (markers.length !== 1
      || String(markers[0][0] || "").trim() !== "시즌"
      || String(markers[0][1] || "").trim() !== "season_id"
      || String(markers[0][2] || "").trim() !== SAMGUK_PUBLIC_SEASON_ID) {
    throw new Error("invalid_season");
  }
}

function samgukPublicPrepareWorkbook_(spreadsheet) {
  spreadsheet.rename("SOOPNOTICE 후국지 공개 현황·파워랭킹");
  spreadsheet.setSpreadsheetLocale("ko_KR");
  spreadsheet.setSpreadsheetTimeZone("Asia/Seoul");

  var sheets = {};
  SAMGUK_PUBLIC_SHEET_ORDER.forEach(function(name, index) {
    var sheet = spreadsheet.getSheetByName(name);
    if (!sheet && index === 0 && spreadsheet.getSheets().length === 1) {
      var only = spreadsheet.getSheets()[0];
      if (only.getName() === "Sheet1" || only.getName() === "시트1") {
        only.setName(name);
        sheet = only;
      }
    }
    if (!sheet) sheet = spreadsheet.insertSheet(name);
    if (sheet.isSheetHidden()) sheet.showSheet();
    sheets[name] = sheet;
    samgukPublicEnsureSize_(sheet, name === "수정제안" ? 1001 : name === "변경이력" || name === "승인원장" ? 2001 : 100, SAMGUK_PUBLIC_HEADERS[name].length);
    samgukPublicInstallHeader_(sheet, SAMGUK_PUBLIC_HEADERS[name]);
  });

  samgukPublicSeedGuide_(sheets["안내"], spreadsheet.getUrl());
  samgukPublicSeedCodeTable_(sheets["코드표"]);
  samgukPublicConfigureProposalSheet_(sheets["수정제안"], sheets["코드표"]);
  samgukPublicConfigureOutputSheet_(sheets["파워랭킹"]);
  samgukPublicConfigureOutputSheet_(sheets["스탯·장비"]);
  samgukPublicConfigureOutputSheet_(sheets["변경이력"]);
  samgukPublicConfigureOutputSheet_(sheets["승인원장"]);
  samgukPublicApplyProtections_(sheets);

  SAMGUK_PUBLIC_SHEET_ORDER.forEach(function(name, index) {
    spreadsheet.setActiveSheet(sheets[name]);
    spreadsheet.moveActiveSheet(index + 1);
  });
  sheets["코드표"].hideSheet();
  sheets["승인원장"].hideSheet();
  spreadsheet.setActiveSheet(sheets["안내"]);
  SpreadsheetApp.flush();
}

function samgukPublicValidateWorkbook_(spreadsheet) {
  SAMGUK_PUBLIC_SHEET_ORDER.forEach(function(name) {
    var sheet = spreadsheet.getSheetByName(name);
    if (!sheet) throw new Error("public_sheet_missing:" + name);
    var expected = SAMGUK_PUBLIC_HEADERS[name];
    var actual = sheet.getRange(1, 1, 1, expected.length).getDisplayValues()[0];
    if (actual.length !== expected.length || actual.some(function(header, index) {
      return String(header || "").trim() !== expected[index];
    })) throw new Error("public_sheet_schema_mismatch:" + name);
  });
}

function samgukPublicEnsureSize_(sheet, rows, columns) {
  if (sheet.getMaxRows() < rows) sheet.insertRowsAfter(sheet.getMaxRows(), rows - sheet.getMaxRows());
  if (sheet.getMaxColumns() < columns) sheet.insertColumnsAfter(sheet.getMaxColumns(), columns - sheet.getMaxColumns());
}

function samgukPublicInstallHeader_(sheet, headers) {
  sheet.getRange(1, 1, 1, headers.length).setValues([headers])
    .setBackground("#172033")
    .setFontColor("#FFFFFF")
    .setFontWeight("bold")
    .setHorizontalAlignment("center")
    .setVerticalAlignment("middle")
    .setWrap(true);
  sheet.setFrozenRows(1);
  sheet.setRowHeight(1, 30);
}

function samgukPublicSeedGuide_(sheet, publicUrl) {
  var rows = [
    ["사이트", SAMGUK_PUBLIC_SITE_URL],
    ["공개 시트", publicUrl],
    ["시즌", SAMGUK_PUBLIC_SEASON_ID],
    ["자동 갱신", "5분마다 캐시를 우회해 SOOPNOTICE 공개 API의 정상 90명 자료로 갱신됩니다."],
    ["파워점수", "사이트 파워 v1.6 하한점수 × " + SAMGUK_PUBLIC_POWER_SCALE + " 표시값입니다. 무력·기민·기력·지모 원값 합계는 기량 1점당 파워 1점으로 그대로 더하고, 장비는 무기 60%·흉갑 30%·각갑 10%이며 군주 두갑은 15% 추가 보너스, 말은 5등급과 강화를 반영합니다."],
    ["보기 권한", "링크가 있는 모든 사용자는 볼 수 있습니다."],
    ["수정 권한", "Google Drive에서 편집 권한을 요청하면 소유자가 계정별로 승인합니다."],
    ["수정 방법", "승인된 편집자는 수정제안 탭의 입력 칸만 작성합니다. 한 행에는 한 선수의 한 항목만 적습니다."],
    ["반영 조건", "레벨·강화·무/민/기/지·최대체력·공격력은 확인된 최고값, 장비 세팅에 따라 내려갈 수 있는 동적 정보창 수치는 최신 관측값을 사용합니다."],
    ["교차검증", "이 공개 시트는 운영원장의 표시용 사본이므로 독립 출처나 교차검증 1회로 중복 계산하지 않습니다."],
    ["오류 정정", "잘못 승인된 값은 삭제하지 않고 철회한 뒤 이전 최고값으로 되돌립니다."],
    ["제보 안내", "player_id와 field_key는 드롭다운에서 고르고, 관측시각·원문 URL·설명을 함께 적어 주세요."],
    ["워터마크", "soopnotice.com"]
  ];
  sheet.getRange(2, 1, Math.max(1, sheet.getMaxRows() - 1), Math.min(8, sheet.getMaxColumns())).clearContent();
  sheet.getRange(3, 1, rows.length, 2).setValues(rows);
  sheet.getRange(3, 1, rows.length, 1).setFontWeight("bold").setBackground("#EEF2FF");
  sheet.getRange(3, 2, rows.length, 1).setWrap(true);
  sheet.setColumnWidth(1, 130);
  sheet.setColumnWidth(2, 680);
  for (var row = 3; row < 3 + rows.length; row += 1) sheet.setRowHeight(row, 36);
}

function samgukPublicSeedCodeTable_(sheet) {
  var roster = samgukPublicReadRoster_();
  var fieldKeys = Object.keys(SAMGUK_PUBLIC_FIELD_CONFIG);
  var height = Math.max(roster.length, fieldKeys.length);
  if (height > 0) sheet.getRange(2, 1, Math.max(height, sheet.getLastRow() - 1), 9).clearContent();
  if (roster.length) {
    sheet.getRange(2, 1, roster.length, 4).setValues(roster.map(function(member) {
      return [member.playerId, member.name, member.soopId, member.nation];
    }));
  }
  if (fieldKeys.length) {
    sheet.getRange(2, 6, fieldKeys.length, 4).setValues(fieldKeys.map(function(key) {
      var config = SAMGUK_PUBLIC_FIELD_CONFIG[key];
      return [key, config.label, config.maximum, config.integer ? "Y" : "N"];
    }));
  }
}

function samgukPublicConfigureProposalSheet_(sheet, codeSheet) {
  sheet.setFrozenColumns(2);
  sheet.getRange("B2:B" + SAMGUK_PUBLIC_MAX_PROPOSAL_ROW).setNumberFormat("yyyy-mm-dd hh:mm:ss");
  sheet.getRange("H2:H" + SAMGUK_PUBLIC_MAX_PROPOSAL_ROW).setNumberFormat("yyyy-mm-dd hh:mm:ss");
  sheet.getRange("O2:O" + SAMGUK_PUBLIC_MAX_PROPOSAL_ROW).setNumberFormat("yyyy-mm-dd hh:mm:ss");
  sheet.getRange("C2:C" + SAMGUK_PUBLIC_MAX_PROPOSAL_ROW).setDataValidation(
    SpreadsheetApp.newDataValidation()
      .requireValueInRange(codeSheet.getRange("A2:A91"), true)
      .setAllowInvalid(false)
      .setHelpText("player_id를 목록에서 선택하세요.")
      .build()
  );
  sheet.getRange("E2:E" + SAMGUK_PUBLIC_MAX_PROPOSAL_ROW).setDataValidation(
    SpreadsheetApp.newDataValidation()
      .requireValueInRange(codeSheet.getRange(2, 6, Object.keys(SAMGUK_PUBLIC_FIELD_CONFIG).length, 1), true)
      .setAllowInvalid(false)
      .setHelpText("수정할 항목을 선택하세요.")
      .build()
  );
  sheet.getRange("G2:G" + SAMGUK_PUBLIC_MAX_PROPOSAL_ROW).setDataValidation(
    SpreadsheetApp.newDataValidation()
      .requireNumberBetween(0, 1000000)
      .setAllowInvalid(false)
      .setHelpText("현재보다 큰 확인값을 숫자로 입력하세요.")
      .build()
  );
  sheet.getRange("H2:H" + SAMGUK_PUBLIC_MAX_PROPOSAL_ROW).setDataValidation(
    SpreadsheetApp.newDataValidation().requireDate().setAllowInvalid(false).build()
  );
  sheet.getRange("I2:I" + SAMGUK_PUBLIC_MAX_PROPOSAL_ROW).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(SAMGUK_PUBLIC_SOURCE_TYPES, true).setAllowInvalid(false).build()
  );
  sheet.getRange("C2:K" + SAMGUK_PUBLIC_MAX_PROPOSAL_ROW).setBackground("#FFF8DC");
  [140, 145, 90, 110, 130, 90, 90, 145, 130, 280, 260, 90, 220, 90, 145, 190, 90]
    .forEach(function(width, index) { sheet.setColumnWidth(index + 1, width); });
  var filter = sheet.getFilter();
  if (filter) filter.remove();
  sheet.getRange(1, 1, SAMGUK_PUBLIC_MAX_PROPOSAL_ROW, SAMGUK_PUBLIC_HEADERS["수정제안"].length).createFilter();
}

function samgukPublicConfigureOutputSheet_(sheet) {
  var filter = sheet.getFilter();
  if (filter) filter.remove();
  var width = SAMGUK_PUBLIC_HEADERS[sheet.getName()].length;
  var filterRows = sheet.getName() === "변경이력" || sheet.getName() === "승인원장" ? 2001 : 91;
  sheet.getRange(1, 1, filterRows, width).createFilter();
  sheet.setFrozenColumns(sheet.getName() === "파워랭킹" ? 4 : 3);
  sheet.getRange(2, 1, Math.max(1, filterRows - 1), width).setVerticalAlignment("middle");
  sheet.autoResizeColumns(1, width);
  for (var column = 1; column <= width; column += 1) {
    sheet.setColumnWidth(column, Math.min(220, Math.max(72, sheet.getColumnWidth(column))));
  }
}

function samgukPublicApplyProtections_(sheets) {
  SAMGUK_PUBLIC_SHEET_ORDER.forEach(function(name) {
    samgukPublicRemoveManagedProtections_(sheets[name]);
  });
  ["안내", "파워랭킹", "스탯·장비", "변경이력", "승인원장", "코드표"].forEach(function(name) {
    samgukPublicProtectSheet_(sheets[name], []);
  });
  var proposal = sheets["수정제안"];
  samgukPublicProtectSheet_(proposal, [
    proposal.getRange("C2:C" + SAMGUK_PUBLIC_MAX_PROPOSAL_ROW),
    proposal.getRange("E2:E" + SAMGUK_PUBLIC_MAX_PROPOSAL_ROW),
    proposal.getRange("G2:K" + SAMGUK_PUBLIC_MAX_PROPOSAL_ROW)
  ]);
  var lastRow = Math.min(proposal.getLastRow(), SAMGUK_PUBLIC_MAX_PROPOSAL_ROW);
  if (lastRow >= 2) {
    var statuses = proposal.getRange(2, 12, lastRow - 1, 1).getDisplayValues();
    statuses.forEach(function(value, index) {
      if (["승인", "거절", "철회"].indexOf(String(value[0] || "").trim()) >= 0) {
        samgukPublicProtectProposalRow_(proposal, index + 2);
      }
    });
  }
}

function samgukPublicProtectSheet_(sheet, unprotectedRanges) {
  var protection = sheet.protect()
    .setDescription(SAMGUK_PUBLIC_PROTECTION_PREFIX + " 관리자 보호 " + sheet.getName())
    .setWarningOnly(false)
    .setUnprotectedRanges(unprotectedRanges || []);
  samgukPublicRestrictEditors_(protection);
}

function samgukPublicProtectProposalRow_(sheet, row) {
  var description = SAMGUK_PUBLIC_PROTECTION_PREFIX + " 처리완료 " + row;
  var existing = sheet.getProtections(SpreadsheetApp.ProtectionType.RANGE).some(function(protection) {
    return String(protection.getDescription() || "") === description;
  });
  if (existing) return;
  var range = sheet.getRange(row, 3, 1, 9);
  var protection = range.protect()
    .setDescription(description)
    .setWarningOnly(false);
  try {
    samgukPublicRestrictEditors_(protection);
  } catch (error) {
    var rollbackErrors = [];
    samgukPublicRollbackStep_(rollbackErrors, "row_protection", function() {
      protection.remove();
    });
    throw samgukPublicTransactionError_("proposal_row_protection", error, rollbackErrors);
  }
}

function samgukPublicRestrictEditors_(protection) {
  var configured = PropertiesService.getScriptProperties().getProperty("SAMGUK_SHEET_ADMIN_EMAILS") || "";
  var effective = Session.getEffectiveUser().getEmail() || "";
  var admins = configured.split(",").map(function(value) { return value.trim(); }).filter(Boolean);
  if (effective && admins.indexOf(effective) < 0) admins.push(effective);
  var editors = protection.getEditors();
  if (editors.length) protection.removeEditors(editors);
  if (admins.length) protection.addEditors(admins);
  if (protection.canDomainEdit()) protection.setDomainEdit(false);
}

function samgukPublicEventUserEmail_(event) {
  try {
    if (event && event.user && typeof event.user.getEmail === "function") {
      var eventEmail = String(event.user.getEmail() || "").trim().toLowerCase();
      if (eventEmail) return eventEmail;
    }
    return String(Session.getActiveUser().getEmail() || "").trim().toLowerCase();
  } catch (error) {
    return "";
  }
}

function samgukPublicIsAdminEmail_(spreadsheet, email) {
  var normalized = String(email || "").trim().toLowerCase();
  if (!normalized) return false;
  var configured = PropertiesService.getScriptProperties().getProperty("SAMGUK_SHEET_ADMIN_EMAILS") || "";
  var admins = configured.split(",").map(function(value) {
    return value.trim().toLowerCase();
  }).filter(Boolean);
  try {
    var owner = DriveApp.getFileById(spreadsheet.getId()).getOwner();
    var ownerEmail = owner ? String(owner.getEmail() || "").trim().toLowerCase() : "";
    if (ownerEmail && admins.indexOf(ownerEmail) < 0) admins.push(ownerEmail);
  } catch (error) {
    // owner 조회 실패 시 configured 관리자 외에는 fail-closed 합니다.
  }
  return admins.indexOf(normalized) >= 0;
}

function samgukPublicRemoveManagedProtections_(sheet) {
  [SpreadsheetApp.ProtectionType.SHEET, SpreadsheetApp.ProtectionType.RANGE].forEach(function(type) {
    sheet.getProtections(type).forEach(function(protection) {
      if (String(protection.getDescription() || "").indexOf(SAMGUK_PUBLIC_PROTECTION_PREFIX) === 0) {
        protection.remove();
      }
    });
  });
}

function samgukPublicConfigureSharing_(spreadsheet) {
  var file = DriveApp.getFileById(spreadsheet.getId());
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  file.setShareableByEditors(false);
  if (file.getSharingAccess() !== DriveApp.Access.ANYONE_WITH_LINK
      || file.getSharingPermission() !== DriveApp.Permission.VIEW
      || file.isShareableByEditors()) {
    throw new Error("public_sharing_verification_failed");
  }
}

function samgukPublicInstallTriggers_(spreadsheet) {
  var handlers = { syncSamgukPublicSheet: true, handleSamgukPublicEdit: true };
  var existing = ScriptApp.getProjectTriggers().filter(function(trigger) {
    return handlers[trigger.getHandlerFunction()] === true;
  });
  var syncTrigger = ScriptApp.newTrigger("syncSamgukPublicSheet").timeBased()
    .everyMinutes(SAMGUK_PUBLIC_SYNC_INTERVAL_MINUTES).create();
  var editTrigger = ScriptApp.newTrigger("handleSamgukPublicEdit").forSpreadsheet(spreadsheet).onEdit().create();
  var keep = {};
  keep[syncTrigger.getUniqueId()] = true;
  keep[editTrigger.getUniqueId()] = true;
  existing.forEach(function(trigger) {
    if (!keep[trigger.getUniqueId()]) ScriptApp.deleteTrigger(trigger);
  });
}

function samgukPublicSyncUnlocked_(spreadsheet) {
  var members = samgukPublicFetchMembers_();
  var rankingRows = samgukPublicBuildRankingRows_(members);
  var detailRows = samgukPublicBuildDetailRows_(members);
  samgukPublicReplaceOutput_(spreadsheet.getSheetByName("파워랭킹"), rankingRows);
  samgukPublicReplaceOutput_(spreadsheet.getSheetByName("스탯·장비"), detailRows);
  samgukPublicRefreshPendingProposals_(spreadsheet);
  var syncedAt = new Date().toISOString();
  PropertiesService.getScriptProperties().setProperty(SAMGUK_PUBLIC_SYNCED_AT_PROPERTY, syncedAt);
  spreadsheet.getSheetByName("안내").getRange("A16:B16").setValues([["최근 정상 동기화", new Date()]])
    .setNumberFormat("yyyy-mm-dd hh:mm:ss");
  SpreadsheetApp.flush();
  return { ok: true, members: members.length, syncedAt: syncedAt };
}

function samgukPublicFetchMembers_() {
  var response = UrlFetchApp.fetch(SAMGUK_PUBLIC_API_URL, {
    method: "get",
    muteHttpExceptions: true,
    followRedirects: false,
    validateHttpsCertificates: true,
    headers: { Accept: "application/json" }
  });
  if (response.getResponseCode() !== 200) throw new Error("public_api_http_" + response.getResponseCode());
  var text = response.getContentText("UTF-8");
  if (text.length > 2 * 1024 * 1024) throw new Error("public_api_too_large");
  var payload = JSON.parse(text);
  if (!payload || payload.seasonId !== SAMGUK_PUBLIC_SEASON_ID
      || payload.stale !== false || !Array.isArray(payload.members)
      || payload.members.length !== SAMGUK_PUBLIC_EXPECTED_MEMBER_COUNT) {
    throw new Error("public_api_invalid_roster");
  }

  var roster = samgukPublicReadRoster_();
  if (roster.length !== SAMGUK_PUBLIC_EXPECTED_MEMBER_COUNT) throw new Error("master_roster_invalid");
  var bySoopId = {};
  var byIdentity = {};
  roster.forEach(function(member) {
    bySoopId[String(member.soopId || "").toLowerCase()] = member;
    byIdentity[member.nation + "\u0000" + member.name] = member;
  });
  var seen = {};
  var normalized = payload.members.map(function(raw) {
    if (!raw || typeof raw !== "object") throw new Error("public_api_invalid_member");
    var soopId = String(raw.soopId || "").trim();
    var name = String(raw.name || "").trim();
    var nation = String(raw.nation || "").trim();
    var rosterMember = bySoopId[soopId.toLowerCase()] || byIdentity[nation + "\u0000" + name];
    if (!rosterMember || seen[rosterMember.playerId]) throw new Error("public_api_member_mismatch");
    seen[rosterMember.playerId] = true;
    return samgukPublicNormalizeMember_(raw, rosterMember);
  });
  if (Object.keys(seen).length !== SAMGUK_PUBLIC_EXPECTED_MEMBER_COUNT) {
    throw new Error("public_api_duplicate_member");
  }
  return normalized;
}

function samgukPublicNormalizeMember_(raw, rosterMember) {
  function number(field, maximum) {
    var value = raw[field];
    if (value === null || value === undefined || value === "") return null;
    var parsed = Number(value);
    if (!isFinite(parsed) || parsed < 0 || parsed > maximum) throw new Error("public_api_invalid_field:" + field);
    return parsed;
  }
  function text(field, maximum) {
    var value = String(raw[field] === null || raw[field] === undefined ? "" : raw[field]).trim();
    if (value.length > maximum) throw new Error("public_api_invalid_field:" + field);
    return value;
  }
  var rankScore = number("powerRankScore", 100);
  if (rankScore === null && raw.powerRange && raw.powerRange.lower !== null && raw.powerRange.lower !== undefined) {
    rankScore = Number(raw.powerRange.lower);
    if (!isFinite(rankScore) || rankScore < 0 || rankScore > 100) throw new Error("public_api_invalid_power_range");
  }
  return {
    playerId: rosterMember.playerId,
    name: text("name", 80),
    soopId: text("soopId", 40),
    nation: text("nation", 10),
    crew: text("crew", 120),
    job: text("job", 80),
    level: number("level", 10000),
    horse: text("horse", 80),
    horseLevel: number("horseLevel", 80),
    weapon: number("weapon", 15),
    helmet: number("helmet", 15),
    armor: number("armor", 15),
    shoes: number("shoes", 15),
    strength: number("strength", 1000000),
    agility: number("agility", 1000000),
    vitality: number("vitality", 1000000),
    intelligence: number("intelligence", 1000000),
    maxHealth: number("maxHealth", 1000000),
    attackPower: number("attackPower", 1000000),
    basicAttackDamage: number("basicAttackDamage", 1000000),
    healthStat: number("healthStat", 1000000),
    activeGeneral: text("activeGeneral", 80),
    defense: number("defense", 1000000),
    attackPowerBonusPct: number("attackPowerBonusPct", 1000),
    damageReductionPct: number("damageReductionPct", 1000),
    criticalChancePct: number("criticalChancePct", 1000),
    criticalDamagePct: number("criticalDamagePct", 1000),
    skillCooldownReductionPct: number("skillCooldownReductionPct", 1000),
    skillDamageBonusPct: number("skillDamageBonusPct", 1000),
    moveSpeedBonusPct: number("moveSpeedBonusPct", 1000),
    horseMaxHealth: number("horseMaxHealth", 1000000),
    strengthBonus: number("strengthBonus", 1000000),
    agilityBonus: number("agilityBonus", 1000000),
    vitalityBonus: number("vitalityBonus", 1000000),
    intelligenceBonus: number("intelligenceBonus", 1000000),
    attackPowerIncrease: number("attackPowerIncrease", 1000000),
    moveSpeedIncrease: number("moveSpeedIncrease", 1000000),
    healthIncrease: number("healthIncrease", 1000000),
    skillHasteIncrease: number("skillHasteIncrease", 1000000),
    skillBuild: samgukPublicNormalizeSkillBuild_(raw.skillBuild),
    powerRankScore: rankScore,
    powerIndex: number("powerIndex", 100),
    powerCoverage: number("powerCoverage", 100),
    powerStatus: text("powerStatus", 40),
    sourceType: text("sourceType", 80),
    sourceCount: number("sourceCount", 10),
    reviewStatus: text("reviewStatus", 40),
    observedAt: text("observedAt", 80),
    evidence: text("evidence", 4000)
  };
}

function samgukPublicNormalizeSkillBuild_(value) {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).sort().join(",") !== "ownedPoints,preset,skills,version"
      || value.version !== 1
      || (value.preset !== null
        && (!Number.isInteger(value.preset) || value.preset < 1 || value.preset > 4))
      || !Number.isInteger(value.ownedPoints) || value.ownedPoints < 0 || value.ownedPoints > 1000000
      || !Array.isArray(value.skills) || [6, 9].indexOf(value.skills.length) === -1) {
    throw new Error("public_api_invalid_field:skillBuild");
  }
  var seen = {};
  var skills = value.skills.map(function(skill) {
    if (!skill || typeof skill !== "object" || Array.isArray(skill)
        || Object.keys(skill).sort().join(",") !== "allocatedPoints,name,requiredPoints"
        || typeof skill.name !== "string" || skill.name !== skill.name.trim()
        || !skill.name || skill.name.length > 80 || /[\u0000-\u001F\u007F]/.test(skill.name)
        || Object.prototype.hasOwnProperty.call(seen, skill.name)
        || !Number.isInteger(skill.requiredPoints) || skill.requiredPoints < 0 || skill.requiredPoints > 1000000
        || !Number.isInteger(skill.allocatedPoints) || skill.allocatedPoints < 0 || skill.allocatedPoints > 1000000) {
      throw new Error("public_api_invalid_field:skillBuild");
    }
    seen[skill.name] = true;
    return {
      name: skill.name,
      requiredPoints: skill.requiredPoints,
      allocatedPoints: skill.allocatedPoints
    };
  });
  return { version: 1, preset: value.preset, ownedPoints: value.ownedPoints, skills: skills };
}

function samgukPublicSkillBuildCell_(value) {
  if (value === null) return "";
  var allocatedTotal = value.skills.reduce(function(sum, skill) {
    return sum + skill.allocatedPoints;
  }, 0);
  var upgraded = value.skills.filter(function(skill) { return skill.allocatedPoints > 0; }).length;
  var preset = value.preset === null ? "프리셋 미확인" : "프리셋 " + value.preset;
  var details = value.skills.map(function(skill) {
    return skill.name + " " + skill.allocatedPoints + "/" + skill.requiredPoints;
  }).join(" | ");
  return "총배분 " + allocatedTotal + " · 강화 " + upgraded + "/" + value.skills.length
    + " · 남은 " + value.ownedPoints + " · " + preset + " | " + details;
}

function samgukPublicBuildRankingRows_(members) {
  var sorted = members.slice().sort(function(left, right) {
    var score = samgukPublicNullableCompare_(right.powerRankScore, left.powerRankScore);
    if (score) return score;
    var coverage = samgukPublicNullableCompare_(right.powerCoverage, left.powerCoverage);
    if (coverage) return coverage;
    var index = samgukPublicNullableCompare_(right.powerIndex, left.powerIndex);
    if (index) return index;
    return left.name.localeCompare(right.name, "ko");
  });
  var previousScore = null;
  var previousRank = 0;
  return sorted.map(function(member, index) {
    var displayScore = member.powerRankScore === null ? null : Math.round(member.powerRankScore * SAMGUK_PUBLIC_POWER_SCALE);
    var rank = displayScore === null ? "" : displayScore === previousScore ? previousRank : index + 1;
    if (displayScore !== null && displayScore !== previousScore) {
      previousScore = displayScore;
      previousRank = rank;
    }
    return [
      rank, member.playerId, member.nation, member.name, member.crew, member.job,
      samgukPublicBlank_(displayScore), samgukPublicBlank_(member.powerCoverage), member.powerStatus,
      samgukPublicBlank_(member.level), samgukPublicBlank_(member.strength), samgukPublicBlank_(member.agility),
      samgukPublicBlank_(member.vitality), samgukPublicBlank_(member.intelligence),
      samgukPublicBlank_(member.weapon), samgukPublicBlank_(member.helmet), samgukPublicBlank_(member.armor),
      samgukPublicBlank_(member.shoes), member.horse, samgukPublicBlank_(member.horseLevel),
      samgukPublicBlank_(member.maxHealth), samgukPublicBlank_(member.attackPower),
      samgukPublicDateOrText_(member.observedAt), "https://play.sooplive.com/" + member.soopId,
      samgukPublicBlank_(member.healthStat), member.activeGeneral, samgukPublicBlank_(member.defense),
      samgukPublicBlank_(member.attackPowerBonusPct), samgukPublicBlank_(member.damageReductionPct),
      samgukPublicBlank_(member.criticalChancePct), samgukPublicBlank_(member.criticalDamagePct),
      samgukPublicBlank_(member.skillCooldownReductionPct), samgukPublicBlank_(member.skillDamageBonusPct),
      samgukPublicBlank_(member.moveSpeedBonusPct), samgukPublicBlank_(member.horseMaxHealth),
      samgukPublicBlank_(member.strengthBonus), samgukPublicBlank_(member.agilityBonus),
      samgukPublicBlank_(member.vitalityBonus), samgukPublicBlank_(member.intelligenceBonus),
      samgukPublicBlank_(member.attackPowerIncrease), samgukPublicBlank_(member.moveSpeedIncrease),
      samgukPublicBlank_(member.healthIncrease), samgukPublicBlank_(member.skillHasteIncrease),
      samgukPublicSkillBuildCell_(member.skillBuild)
    ].map(samgukPublicSafeCell_);
  });
}

function samgukPublicBuildDetailRows_(members) {
  return members.slice().sort(function(left, right) {
    var nation = left.nation.localeCompare(right.nation, "ko");
    return nation || left.name.localeCompare(right.name, "ko");
  }).map(function(member) {
    var displayScore = member.powerRankScore === null ? null : Math.round(member.powerRankScore * SAMGUK_PUBLIC_POWER_SCALE);
    return [
      member.playerId, member.nation, member.name, member.soopId, member.crew, member.job,
      samgukPublicBlank_(member.level), member.horse, samgukPublicBlank_(member.horseLevel),
      samgukPublicBlank_(member.weapon), samgukPublicBlank_(member.helmet), samgukPublicBlank_(member.armor),
      samgukPublicBlank_(member.shoes), samgukPublicBlank_(member.strength), samgukPublicBlank_(member.agility),
      samgukPublicBlank_(member.vitality), samgukPublicBlank_(member.intelligence),
      samgukPublicBlank_(member.maxHealth), samgukPublicBlank_(member.attackPower),
      samgukPublicBlank_(member.basicAttackDamage), samgukPublicBlank_(displayScore),
      samgukPublicBlank_(member.powerCoverage), member.sourceType, samgukPublicBlank_(member.sourceCount),
      member.reviewStatus, samgukPublicDateOrText_(member.observedAt), member.evidence,
      samgukPublicBlank_(member.healthStat), member.activeGeneral, samgukPublicBlank_(member.defense),
      samgukPublicBlank_(member.attackPowerBonusPct), samgukPublicBlank_(member.damageReductionPct),
      samgukPublicBlank_(member.criticalChancePct), samgukPublicBlank_(member.criticalDamagePct),
      samgukPublicBlank_(member.skillCooldownReductionPct), samgukPublicBlank_(member.skillDamageBonusPct),
      samgukPublicBlank_(member.moveSpeedBonusPct), samgukPublicBlank_(member.horseMaxHealth),
      samgukPublicBlank_(member.strengthBonus), samgukPublicBlank_(member.agilityBonus),
      samgukPublicBlank_(member.vitalityBonus), samgukPublicBlank_(member.intelligenceBonus),
      samgukPublicBlank_(member.attackPowerIncrease), samgukPublicBlank_(member.moveSpeedIncrease),
      samgukPublicBlank_(member.healthIncrease), samgukPublicBlank_(member.skillHasteIncrease),
      samgukPublicSkillBuildCell_(member.skillBuild)
    ].map(samgukPublicSafeCell_);
  });
}

function samgukPublicReplaceOutput_(sheet, rows) {
  var headers = SAMGUK_PUBLIC_HEADERS[sheet.getName()];
  var clearRows = Math.max(1, sheet.getMaxRows() - 1);
  sheet.getRange(2, 1, clearRows, headers.length).clearContent();
  if (rows.length) sheet.getRange(2, 1, rows.length, headers.length).setValues(rows);
  sheet.getRange(2, 1, Math.max(rows.length, 1), headers.length).setWrap(false);
  for (var row = 2; row <= rows.length + 1; row += 1) sheet.setRowHeight(row, 25);
}

function samgukPublicReadRoster_() {
  var sheet = samgukPublicMasterSpreadsheet_().getSheetByName("참가자");
  if (!sheet) throw new Error("master_roster_missing");
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  var values = sheet.getRange(2, 1, lastRow - 1, 6).getDisplayValues();
  var seen = {};
  var roster = values.filter(function(row) { return String(row[0] || "").trim(); }).map(function(row) {
    var member = {
      playerId: String(row[0] || "").trim(),
      nation: String(row[1] || "").trim(),
      crew: String(row[2] || "").trim(),
      name: String(row[3] || "").trim(),
      soopId: String(row[4] || "").trim(),
      job: String(row[5] || "").trim()
    };
    if (!/^P\d{3}$/.test(member.playerId) || !member.name || !member.soopId || seen[member.playerId]) {
      throw new Error("master_roster_invalid");
    }
    seen[member.playerId] = true;
    return member;
  });
  return roster;
}

function samgukPublicRefreshPendingProposals_(spreadsheet) {
  var sheet = spreadsheet.getSheetByName("수정제안");
  var lastRow = Math.min(sheet.getLastRow(), SAMGUK_PUBLIC_MAX_PROPOSAL_ROW);
  for (var row = 2; row <= lastRow; row += 1) {
    var status = String(sheet.getRange(row, 12).getDisplayValue() || "").trim();
    if (!status || status === "대기" || status === "오류") {
      samgukPublicRefreshProposalRow_(spreadsheet, sheet, row, false);
    }
  }
}

function samgukPublicRefreshProposalRow_(spreadsheet, sheet, row, markPending) {
  var values = sheet.getRange(row, 1, 1, SAMGUK_PUBLIC_HEADERS["수정제안"].length).getValues()[0];
  var playerId = String(values[2] || "").trim();
  var fieldKey = String(values[4] || "").trim();
  var proposed = values[6];
  var hasInput = playerId || fieldKey || proposed !== "" || values.slice(7, 11).some(function(value) { return value !== ""; });
  if (!hasInput) return;
  var roster = samgukPublicReadRoster_();
  var member = roster.filter(function(candidate) { return candidate.playerId === playerId; })[0];
  var current = fieldKey && SAMGUK_PUBLIC_FIELD_CONFIG[fieldKey]
    ? samgukPublicReadCurrentValue_(playerId, fieldKey)
    : "";
  if (!values[0] && playerId && fieldKey && proposed !== "") {
    values[0] = "PROP-" + Utilities.getUuid().toUpperCase();
    sheet.getRange(row, 1).setValue(values[0]);
  }
  if (!values[1] && values[0]) {
    values[1] = new Date();
    sheet.getRange(row, 2).setValue(values[1]);
  }
  sheet.getRange(row, 4).setValue(member ? samgukPublicSafeCell_(member.name) : "");
  sheet.getRange(row, 6).setValue(current === null ? "" : current);
  if (markPending && ["승인", "거절", "철회"].indexOf(String(values[11] || "").trim()) < 0) {
    sheet.getRange(row, 12, 1, 4).setValues([["대기", "", "", ""]]);
  }
}

function samgukPublicProcessProposalStatus_(spreadsheet, sheet, row) {
  var values = sheet.getRange(row, 1, 1, SAMGUK_PUBLIC_HEADERS["수정제안"].length).getValues()[0];
  var status = String(values[11] || "").trim();
  if (status === "승인") {
    var approvalUiSnapshot = null;
    var approved = null;
    var ledgerMutation = null;
    var approvalHistoryMutation = null;
    try {
      approvalUiSnapshot = samgukPublicSnapshotProposalSystemCells_(sheet, row);
      approved = samgukPublicApproveProposal_(spreadsheet, values, row);
      sheet.getRange(row, 1, 1, 2).setValues([[approved.proposalId, approved.submittedAt]]);
      sheet.getRange(row, 4).setValue(samgukPublicSafeCell_(approved.name));
      sheet.getRange(row, 6).setValue(approved.currentValue === null ? "" : approved.currentValue);
      sheet.getRange(row, 12, 1, 6).setValues([[
        "승인", "운영원장 반영 완료", "운영자", new Date(), approved.observationId, approved.masterRow
      ]]);
      ledgerMutation = samgukPublicAppendLedger_(spreadsheet, approved);
      approvalHistoryMutation = samgukPublicAppendHistory_(
        spreadsheet, approved, "승인", "운영원장 단일 시트 기준값 반영"
      );
      samgukPublicProtectProposalRow_(sheet, row);
    } catch (error) {
      var approvalRollbackErrors = [];
      samgukPublicRollbackStep_(approvalRollbackErrors, "history", function() {
        samgukPublicRollbackAppendedRow_(approvalHistoryMutation, "approval_history");
      });
      samgukPublicRollbackStep_(approvalRollbackErrors, "ledger", function() {
        samgukPublicRollbackAppendedRow_(ledgerMutation, "approval_ledger");
      });
      samgukPublicRollbackStep_(approvalRollbackErrors, "ui", function() {
        samgukPublicRestoreProposalSystemCells_(approvalUiSnapshot);
      });
      samgukPublicRollbackStep_(approvalRollbackErrors, "master", function() {
        samgukPublicRollbackAppendedRow_(approved && approved.masterMutation, "master_observation");
      });
      samgukPublicWriteProcessError_(
        spreadsheet, sheet, row, values,
        samgukPublicTransactionError_("approval", error, approvalRollbackErrors)
      );
    }
  } else if (status === "거절") {
    try {
      var rejected = samgukPublicProposalSummary_(values, row);
      if (!rejected.proposalId) throw new Error("proposal_id_required");
      var rejectedLedger = samgukPublicFindLedgerRecord_(spreadsheet, rejected.proposalId, rejected.observationId);
      var priorAction = samgukPublicLatestHistoryAction_(spreadsheet, rejected.proposalId);
      if (rejectedLedger || rejected.observationId || priorAction === "승인" || priorAction === "철회") {
        throw new Error("approved_proposal_must_be_revoked");
      }
      var rejectionNote = String(values[12] || "근거 또는 값 확인 필요").slice(0, 200);
      sheet.getRange(row, 12, 1, 4).setValues([[
        "거절", samgukPublicSafeCell_(rejectionNote), "운영자", new Date()
      ]]);
      samgukPublicAppendHistory_(spreadsheet, rejected, "거절", rejectionNote);
      samgukPublicProtectProposalRow_(sheet, row);
    } catch (error) {
      samgukPublicWriteProcessError_(spreadsheet, sheet, row, values, error);
    }
  } else if (status === "철회") {
    var revokeUiSnapshot = null;
    var revoked = null;
    var revokeHistoryMutation = null;
    try {
      revokeUiSnapshot = samgukPublicSnapshotProposalSystemCells_(sheet, row);
      revoked = samgukPublicRevokeProposal_(spreadsheet, values, row);
      sheet.getRange(row, 12, 1, 4).setValues([[
        "철회", samgukPublicSafeCell_(revoked.reason), "운영자", new Date()
      ]]);
      revokeHistoryMutation = samgukPublicAppendHistory_(spreadsheet, revoked, "철회", revoked.reason);
      samgukPublicProtectProposalRow_(sheet, row);
    } catch (error) {
      var revokeRollbackErrors = [];
      samgukPublicRollbackStep_(revokeRollbackErrors, "history", function() {
        samgukPublicRollbackAppendedRow_(revokeHistoryMutation, "revoke_history");
      });
      samgukPublicRollbackStep_(revokeRollbackErrors, "ui", function() {
        samgukPublicRestoreProposalSystemCells_(revokeUiSnapshot);
      });
      samgukPublicRollbackStep_(revokeRollbackErrors, "master_and_ledger", function() {
        samgukPublicRollbackRevokeMutation_(revoked && revoked.revokeMutation);
      });
      samgukPublicWriteProcessError_(
        spreadsheet, sheet, row, values,
        samgukPublicTransactionError_("revoke", error, revokeRollbackErrors)
      );
    }
  } else {
    var canonical;
    try {
      canonical = samgukPublicCanonicalProposalStatus_(spreadsheet, values);
    } catch (error) {
      samgukPublicWriteProcessError_(spreadsheet, sheet, row, values, error);
      return;
    }
    if (["승인", "거절", "철회"].indexOf(canonical) >= 0 && canonical !== status) {
      sheet.getRange(row, 12, 1, 2).setValues([[
        canonical, "처리완료 상태는 대기·빈값으로 되돌릴 수 없습니다."
      ]]);
    } else if (status && ["대기", "오류"].indexOf(status) < 0) {
      sheet.getRange(row, 12, 1, 2).setValues([["오류", "허용되지 않은 처리상태입니다."]]);
    }
  }
}

function samgukPublicApproveProposal_(spreadsheet, values, proposalRow) {
  var proposalSheet = spreadsheet.getSheetByName("수정제안");
  if (proposalSheet.getRange(proposalRow, 3, 1, 9).getFormulas()[0].some(Boolean)) {
    throw new Error("formula_input_not_allowed");
  }
  var proposalId = String(values[0] || "").trim();
  var playerId = String(values[2] || "").trim();
  var fieldKey = String(values[4] || "").trim();
  var proposedValue = values[6];
  var observedAt = values[7];
  var sourceType = String(values[8] || "").trim();
  var evidenceUrl = String(values[9] || "").trim();
  var note = String(values[10] || "").trim();
  if (!proposalId) {
    proposalId = "PROP-" + Utilities.getUuid().toUpperCase();
    proposalSheet.getRange(proposalRow, 1).setValue(proposalId);
    values[0] = proposalId;
  }
  if (!values[1]) {
    values[1] = new Date();
    proposalSheet.getRange(proposalRow, 2).setValue(values[1]);
  }
  if (!/^PROP-[A-Z0-9-]{8,80}$/.test(proposalId)) throw new Error("invalid_proposal_id");
  if (!/^P\d{3}$/.test(playerId)) throw new Error("invalid_player_id");
  var config = SAMGUK_PUBLIC_FIELD_CONFIG[fieldKey];
  if (!config) throw new Error("invalid_field_key");
  var numericValue = samgukPublicValidateProposalNumber_(proposedValue, config);
  var timestamp = samgukPublicValidateObservedAt_(observedAt);
  if (SAMGUK_PUBLIC_SOURCE_TYPES.indexOf(sourceType) < 0) throw new Error("invalid_source_type");
  if (!samgukPublicIsHttpsEvidence_(evidenceUrl)) throw new Error("https_evidence_required");
  if (note.length > 500) throw new Error("note_too_long");

  var roster = samgukPublicReadRoster_();
  var member = roster.filter(function(candidate) { return candidate.playerId === playerId; })[0];
  if (!member) throw new Error("unknown_player");
  var observationId = "OBS-PUBLIC-" + samgukPublicSha256Hex_([
    proposalId, playerId, fieldKey, String(numericValue), timestamp.toISOString(), evidenceUrl
  ].join("\u0000")).slice(0, 32).toUpperCase();
  var existingObservationId = String(values[15] || "").trim();
  if (existingObservationId && existingObservationId !== observationId) {
    throw new Error("proposal_observation_id_mismatch");
  }
  var priorAction = samgukPublicLatestHistoryAction_(spreadsheet, proposalId);
  if (priorAction === "거절" || priorAction === "철회") throw new Error("proposal_is_immutable:" + priorAction);
  var ledger = samgukPublicFindLedgerRecord_(spreadsheet, proposalId, observationId);
  if (ledger) {
    samgukPublicValidateLedgerMatch_(ledger, {
      proposalId: proposalId,
      playerId: playerId,
      fieldKey: fieldKey,
      proposedValue: numericValue,
      evidenceUrl: evidenceUrl,
      observationId: observationId
    });
    if (ledger.status !== "active") throw new Error("revoked_proposal_is_immutable");
  }
  var masterObservation = samgukPublicReadMasterObservation_(observationId);
  if (masterObservation) {
    samgukPublicValidateMasterObservation_(masterObservation, {
      proposalId: proposalId,
      playerId: playerId,
      fieldKey: fieldKey,
      proposedValue: numericValue,
      observationId: observationId
    }, false);
  }
  var currentValue = samgukPublicReadCurrentValue_(playerId, fieldKey);
  if (config.higherOnly !== false && currentValue !== null && numericValue <= currentValue && !masterObservation) {
    throw new Error("proposal_must_be_higher_than_current");
  }
  if (config.higherOnly === false && currentValue !== null && numericValue === currentValue && !masterObservation) {
    throw new Error("proposal_must_differ_from_current");
  }
  var masterResult = samgukPublicAppendMasterObservation_({
    observationId: observationId,
    proposalId: proposalId,
    playerId: playerId,
    fieldKey: fieldKey,
    proposedValue: numericValue,
    observedAt: timestamp,
    evidenceUrl: evidenceUrl,
    sourceType: sourceType,
    note: note,
    currentValues: samgukPublicReadCurrentRecord_(playerId)
  });
  return {
    proposalId: proposalId,
    submittedAt: values[1] || new Date(),
    proposalRow: proposalRow,
    playerId: playerId,
    name: member.name,
    fieldKey: fieldKey,
    previousValue: currentValue,
    currentValue: currentValue,
    proposedValue: numericValue,
    sourceType: sourceType,
    evidenceUrl: evidenceUrl,
    observedAt: timestamp,
    note: note,
    observationId: observationId,
    masterRow: masterResult.row,
    masterMutation: masterResult.mutation || null
  };
}

function samgukPublicAppendMasterObservation_(proposal) {
  var master = samgukPublicMasterSpreadsheet_();
  var sheet = master.getSheetByName("관측입력");
  if (!sheet) throw new Error("master_observation_sheet_missing");
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0];
  [
    "observation_id", "player_id", "확인시각", "근거종류", "근거(URL/타임코드)",
    "교차검증수", "검증상태", "증거해시", "수집배치", "기록자", "메모", "입력시각",
    proposal.fieldKey === "attackPower" ? "공격력" : SAMGUK_PUBLIC_FIELD_CONFIG[proposal.fieldKey].observationHeader
  ].forEach(function(header) {
    if (headers.indexOf(header) < 0) throw new Error("master_missing_header:" + header);
  });

  var existingLastRow = Math.min(sheet.getLastRow(), SAMGUK_PUBLIC_MAX_MASTER_OBSERVATION_ROW);
  if (existingLastRow > 1) {
    var duplicate = sheet.getRange(2, 1, existingLastRow - 1, 1)
      .createTextFinder(proposal.observationId).matchEntireCell(true).findNext();
    if (duplicate) return { duplicate: true, row: duplicate.getRow(), mutation: null };
  }

  var record = {
    observation_id: proposal.observationId,
    player_id: proposal.playerId,
    "확인시각": proposal.observedAt,
    "근거종류": "시트",
    "근거(URL/타임코드)": proposal.evidenceUrl,
    "교차검증수": 1,
    "검증상태": "기준값",
    "증거해시": samgukPublicSha256Hex_([
      proposal.playerId, proposal.fieldKey, String(proposal.proposedValue),
      proposal.observedAt.toISOString(), proposal.evidenceUrl
    ].join("\u0000")),
    "수집배치": "PUBLIC-" + proposal.proposalId.slice(-24),
    "기록자": "공개시트 승인",
    "OCR신뢰도": "",
    "메모": samgukPublicSafeCell_("공개 수정제안 승인 · " + proposal.sourceType + (proposal.note ? " · " + proposal.note : "")),
    "입력시각": new Date()
  };
  // 공개 제보는 해당 숫자 한 필드만 새 기준으로 기록합니다. 다른 단조 증가값을
  // 복사하지 않아 나중에 이 행을 철회하면 이전 최고값으로 되돌릴 수 있습니다.
  record[SAMGUK_PUBLIC_FIELD_CONFIG[proposal.fieldKey].observationHeader] = proposal.proposedValue;
  // 제안 대상 외의 선택 스냅샷 항목은 현재값을 보존합니다.
  [
    "말", "평타피해대표값", "평타표본수", "평타대상", "전투조건", "체력", "현재장수",
    "방어력", "공격력증가(%)", "피해감소(%)", "치명타확률(%)", "치명타피해(%)",
    "스킬쿨타임감소(%)", "스킬피해증가(%)", "이동속도증가(%)", "말최대체력", "절기배분"
  ].forEach(function(header) {
    if (header !== SAMGUK_PUBLIC_FIELD_CONFIG[proposal.fieldKey].observationHeader
        && Object.prototype.hasOwnProperty.call(proposal.currentValues, header)) {
      record[header] = proposal.currentValues[header];
    }
  });

  var values = headers.map(function(header) {
    return Object.prototype.hasOwnProperty.call(record, header) ? samgukPublicSafeCell_(record[header]) : "";
  });
  var targetRow = samgukPublicFindFirstEmptyRow_(sheet, headers.length, SAMGUK_PUBLIC_MAX_MASTER_OBSERVATION_ROW);
  var target = sheet.getRange(targetRow, 1, 1, headers.length);
  var mutation = samgukPublicWriteTrackedEmptyRange_(target, values, [
    { index: headers.indexOf("observation_id"), expected: proposal.observationId },
    { index: headers.indexOf("player_id"), expected: proposal.playerId },
    { index: headers.indexOf("교차검증수"), expected: 1, numeric: true },
    { index: headers.indexOf("검증상태"), expected: "기준값" },
    {
      index: headers.indexOf(SAMGUK_PUBLIC_FIELD_CONFIG[proposal.fieldKey].observationHeader),
      expected: proposal.proposedValue,
      numeric: true
    }
  ], "master_observation");
  return { duplicate: false, row: targetRow, mutation: mutation };
}

function samgukPublicRevokeProposal_(spreadsheet, values, proposalRow) {
  var summary = samgukPublicProposalSummary_(values, proposalRow);
  if (!summary.proposalId || !summary.observationId) throw new Error("approved_observation_missing");
  var ledger = samgukPublicFindLedgerRecord_(spreadsheet, summary.proposalId, summary.observationId);
  if (!ledger) throw new Error("approval_ledger_record_missing");
  samgukPublicValidateLedgerMatch_(ledger, summary);
  if (["active", "revoked"].indexOf(ledger.status) < 0) throw new Error("approval_ledger_status_invalid");
  var masterObservation = samgukPublicReadMasterObservation_(summary.observationId);
  if (!masterObservation) throw new Error("approved_observation_not_found");
  samgukPublicValidateMasterObservation_(masterObservation, summary, true);
  var reason = String(values[12] || "").trim().slice(0, 200);
  if (!reason || reason === "운영원장 반영 완료" || reason.indexOf("수동 처리 대기") >= 0) {
    reason = "오승인 값 철회";
  }
  var masterStatus = String(masterObservation.record["검증상태"] || "").trim();
  if (ledger.status === "revoked" && masterStatus === "철회") {
    summary.reason = reason;
    summary.masterRow = masterObservation.row;
    summary.revokeMutation = null;
    return summary;
  }
  var masterStatusCell = masterObservation.sheet.getRange(masterObservation.row, masterObservation.statusIndex + 1);
  var ledgerStatusCell = ledger.sheet.getRange(ledger.row, 10);
  var ledgerRevokeRange = ledger.sheet.getRange(ledger.row, 13, 1, 2);
  var masterChanged = masterStatus !== "철회";
  var revokeMutation = {
    masterChanged: masterChanged,
    master: samgukPublicSnapshotRange_(masterStatusCell),
    ledgerStatus: samgukPublicSnapshotRange_(ledgerStatusCell),
    ledgerRevoke: samgukPublicSnapshotRange_(ledgerRevokeRange)
  };
  try {
    if (masterChanged) masterStatusCell.setValue("철회");
    ledgerStatusCell.setValue("revoked");
    ledgerRevokeRange.setValues([[new Date(), samgukPublicSafeCell_(reason)]]);
    SpreadsheetApp.flush();
    var revokeValues = ledgerRevokeRange.getValues()[0];
    if (String(masterStatusCell.getDisplayValue()) !== "철회") {
      throw new Error("master_revoke_verification_failed");
    }
    if (String(ledgerStatusCell.getDisplayValue()) !== "revoked"
        || !(revokeValues[0] instanceof Date)
        || !samgukPublicStoredSafeTextEquals_(revokeValues[1], reason)) {
      throw new Error("approval_ledger_revoke_verification_failed");
    }
  } catch (error) {
    var rollbackErrors = [];
    samgukPublicRollbackStep_(rollbackErrors, "master_and_ledger", function() {
      samgukPublicRollbackRevokeMutation_(revokeMutation);
    });
    throw samgukPublicTransactionError_("revoke_write", error, rollbackErrors);
  }
  summary.reason = reason;
  summary.masterRow = masterObservation.row;
  summary.revokeMutation = revokeMutation;
  return summary;
}

function samgukPublicAppendLedger_(spreadsheet, approved) {
  var sheet = spreadsheet.getSheetByName("승인원장");
  var recordId = "REC-" + samgukPublicSha256Hex_(approved.observationId).slice(0, 24).toUpperCase();
  var existing = samgukPublicFindLedgerRecord_(spreadsheet, approved.proposalId, approved.observationId);
  if (existing) {
    samgukPublicValidateLedgerMatch_(existing, approved);
    if (existing.recordId !== recordId || existing.status !== "active") {
      throw new Error("approval_ledger_conflict");
    }
    return { created: false };
  }
  var row = Math.max(2, sheet.getLastRow() + 1);
  if (sheet.getMaxRows() < row) sheet.insertRowsAfter(sheet.getMaxRows(), row - sheet.getMaxRows());
  var ledgerValues = [
    recordId, approved.proposalId, approved.playerId, approved.fieldKey, approved.proposedValue,
    approved.sourceType, approved.evidenceUrl, approved.observedAt, new Date(), "active",
    approved.observationId, approved.masterRow, "", "", SAMGUK_PUBLIC_SCHEMA_VERSION
  ].map(samgukPublicSafeCell_);
  return samgukPublicWriteTrackedEmptyRange_(
    sheet.getRange(row, 1, 1, ledgerValues.length), ledgerValues, [
      { index: 0, expected: recordId },
      { index: 1, expected: approved.proposalId },
      { index: 9, expected: "active" },
      { index: 10, expected: approved.observationId }
    ], "approval_ledger"
  );
}

function samgukPublicFindLedgerRecord_(spreadsheet, proposalId, observationId) {
  var sheet = spreadsheet.getSheetByName("승인원장");
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;
  var matches = [];
  sheet.getRange(2, 1, lastRow - 1, SAMGUK_PUBLIC_HEADERS["승인원장"].length).getValues()
    .forEach(function(row, index) {
      var rowProposalId = String(row[1] || "").trim();
      var rowObservationId = String(row[10] || "").trim();
      if ((proposalId && rowProposalId === proposalId) || (observationId && rowObservationId === observationId)) {
        matches.push({
          sheet: sheet,
          row: index + 2,
          recordId: String(row[0] || "").trim(),
          proposalId: rowProposalId,
          playerId: String(row[2] || "").trim(),
          fieldKey: String(row[3] || "").trim(),
          proposedValue: row[4],
          sourceType: String(row[5] || "").trim(),
          evidenceUrl: String(row[6] || "").trim(),
          observedAt: row[7],
          status: String(row[9] || "").trim(),
          observationId: rowObservationId,
          masterRow: row[11]
        });
      }
    });
  if (matches.length > 1) throw new Error("duplicate_approval_ledger_record");
  return matches[0] || null;
}

function samgukPublicValidateLedgerMatch_(ledger, proposal) {
  if (ledger.proposalId !== String(proposal.proposalId || "").trim()
      || ledger.playerId !== String(proposal.playerId || "").trim()
      || ledger.fieldKey !== String(proposal.fieldKey || "").trim()
      || Number(ledger.proposedValue) !== Number(proposal.proposedValue)
      || ledger.observationId !== String(proposal.observationId || "").trim()) {
    throw new Error("approval_ledger_content_mismatch");
  }
  if (proposal.evidenceUrl !== undefined
      && ledger.evidenceUrl !== String(proposal.evidenceUrl || "").trim()) {
    throw new Error("approval_ledger_evidence_mismatch");
  }
}

function samgukPublicLatestHistoryAction_(spreadsheet, proposalId) {
  if (!proposalId) return "";
  var sheet = spreadsheet.getSheetByName("변경이력");
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return "";
  var rows = sheet.getRange(2, 2, lastRow - 1, 7).getDisplayValues();
  for (var index = rows.length - 1; index >= 0; index -= 1) {
    if (String(rows[index][0] || "").trim() === proposalId) return String(rows[index][6] || "").trim();
  }
  return "";
}

function samgukPublicCanonicalProposalStatus_(spreadsheet, values) {
  var summary = samgukPublicProposalSummary_(values, 0);
  var ledger = samgukPublicFindLedgerRecord_(spreadsheet, summary.proposalId, summary.observationId);
  if (ledger && ledger.status === "active") return "승인";
  if (ledger && ledger.status === "revoked") return "철회";
  var action = samgukPublicLatestHistoryAction_(spreadsheet, summary.proposalId);
  if (["승인", "거절", "철회"].indexOf(action) >= 0) return action;
  return "오류";
}

function samgukPublicSnapshotRange_(range) {
  var formulas = range.getFormulas();
  if (formulas.some(function(row) { return row.some(Boolean); })) {
    throw new Error("transaction_snapshot_formula_conflict:" + range.getSheet().getName() + "!" + range.getA1Notation());
  }
  return { range: range, values: range.getValues() };
}

function samgukPublicSnapshotProposalSystemCells_(sheet, row) {
  return {
    snapshots: [
      sheet.getRange(row, 1, 1, 2),
      sheet.getRange(row, 4),
      sheet.getRange(row, 6),
      sheet.getRange(row, 12, 1, 6)
    ].map(samgukPublicSnapshotRange_)
  };
}

function samgukPublicRestoreProposalSystemCells_(snapshot) {
  if (!snapshot) return;
  snapshot.snapshots.forEach(function(item) {
    item.range.setValues(item.values.map(function(row) { return row.map(samgukPublicSafeCell_); }));
  });
  SpreadsheetApp.flush();
  snapshot.snapshots.forEach(function(item) {
    if (!samgukPublicMatrixEquals_(item.values, item.range.getValues())) {
      throw new Error("proposal_ui_restore_verification_failed:" + item.range.getA1Notation());
    }
  });
}

function samgukPublicRestoreRangeSnapshot_(snapshot, label) {
  if (!snapshot) return;
  snapshot.range.setValues(snapshot.values.map(function(row) { return row.map(samgukPublicSafeCell_); }));
  SpreadsheetApp.flush();
  if (!samgukPublicMatrixEquals_(snapshot.values, snapshot.range.getValues())) {
    throw new Error(label + "_restore_verification_failed");
  }
}

function samgukPublicWriteTrackedEmptyRange_(range, values, checks, label) {
  var snapshot = samgukPublicSnapshotRange_(range);
  if (range.getDisplayValues()[0].some(function(value) { return String(value || "").trim() !== ""; })) {
    throw new Error(label + "_target_row_conflict");
  }
  var mutation = {
    created: true,
    label: label,
    snapshot: snapshot,
    checks: checks,
    writtenValues: values.slice()
  };
  try {
    range.setValues([values]);
    SpreadsheetApp.flush();
    var written = range.getValues()[0];
    checks.forEach(function(check) {
      var matches = check.numeric
        ? Number(written[check.index]) === Number(check.expected)
        : samgukPublicScalarText_(written[check.index]) === samgukPublicScalarText_(check.expected);
      if (!matches) throw new Error(label + "_write_verification_failed:" + check.index);
    });
    return mutation;
  } catch (error) {
    var rollbackErrors = [];
    samgukPublicRollbackStep_(rollbackErrors, label, function() {
      samgukPublicRollbackAppendedRow_(mutation, label);
    });
    throw samgukPublicTransactionError_(label + "_append", error, rollbackErrors);
  }
}

function samgukPublicRollbackAppendedRow_(mutation, label) {
  if (!mutation || !mutation.created) return;
  var current = mutation.snapshot.range.getValues()[0];
  var identity = mutation.checks.filter(function(check) {
    return !check.numeric && samgukPublicScalarText_(check.expected) !== "";
  })[0];
  if (identity) {
    var currentIdentity = samgukPublicScalarText_(current[identity.index]);
    if (currentIdentity && currentIdentity !== samgukPublicScalarText_(identity.expected)) {
      throw new Error(label + "_rollback_identity_conflict");
    }
  }
  samgukPublicRestoreRangeSnapshot_(mutation.snapshot, label + "_append");
}

function samgukPublicRollbackRevokeMutation_(mutation) {
  if (!mutation) return;
  var errors = [];
  samgukPublicRollbackStep_(errors, "ledger_revoke_fields", function() {
    samgukPublicRestoreRangeSnapshot_(mutation.ledgerRevoke, "ledger_revoke_fields");
  });
  samgukPublicRollbackStep_(errors, "ledger_status", function() {
    samgukPublicRestoreRangeSnapshot_(mutation.ledgerStatus, "ledger_status");
  });
  if (mutation.masterChanged) {
    samgukPublicRollbackStep_(errors, "master_status", function() {
      samgukPublicRestoreRangeSnapshot_(mutation.master, "master_status");
    });
  }
  if (errors.length) throw new Error("revoke_restore_failed:" + errors.join(" | "));
}

function samgukPublicRollbackStep_(errors, label, action) {
  try {
    action();
  } catch (error) {
    errors.push(label + ":" + String(error && error.message || error).slice(0, 240));
  }
}

function samgukPublicTransactionError_(scope, originalError, rollbackErrors) {
  var original = String(originalError && originalError.message || originalError).slice(0, 500);
  var message = rollbackErrors.length
    ? "rollback_failed[" + rollbackErrors.join(" | ") + "] | " + scope + "_error:" + original
    : scope + "_rolled_back:" + original;
  console.error("SAMGUK_PUBLIC_TRANSACTION_ERROR " + message);
  return new Error(message);
}

function samgukPublicWriteProcessError_(spreadsheet, sheet, row, values, error) {
  var canonical = "오류";
  var canonicalError = "";
  try {
    canonical = samgukPublicCanonicalProposalStatus_(spreadsheet, values);
  } catch (stateError) {
    canonicalError = "state_resolution_failed:" + String(stateError && stateError.message || stateError);
  }
  var message = String(error && error.message || error);
  if (canonicalError) message = canonicalError + " | " + message;
  console.error("SAMGUK_PUBLIC_PROCESS_ERROR row=" + row + " " + message);
  try {
    sheet.getRange(row, 12, 1, 4).setValues([[
      canonical, message.slice(0, 200), "운영자", new Date()
    ]]);
  } catch (reportError) {
    var reportMessage = "error_reporting_failed:" + String(reportError && reportError.message || reportError)
      + " | original:" + message;
    console.error("SAMGUK_PUBLIC_PROCESS_ERROR " + reportMessage);
    throw new Error(reportMessage);
  }
}

function samgukPublicScalarText_(value) {
  return value === null || value === undefined ? "" : String(value);
}

function samgukPublicStoredSafeTextEquals_(actual, original) {
  var actualText = samgukPublicScalarText_(actual);
  return actualText === samgukPublicScalarText_(original)
    || actualText === samgukPublicScalarText_(samgukPublicSafeCell_(original));
}

function samgukPublicMatrixEquals_(left, right) {
  if (!left || !right || left.length !== right.length) return false;
  return left.every(function(row, rowIndex) {
    if (!right[rowIndex] || row.length !== right[rowIndex].length) return false;
    return row.every(function(value, columnIndex) {
      var other = right[rowIndex][columnIndex];
      if (value instanceof Date || other instanceof Date) {
        return value instanceof Date && other instanceof Date && value.getTime() === other.getTime();
      }
      if (typeof value === "string" && /^\s*[=+\-@]/.test(value)) {
        return samgukPublicStoredSafeTextEquals_(other, value);
      }
      return value === other;
    });
  });
}

function samgukPublicAppendHistory_(spreadsheet, summary, action, note) {
  var sheet = spreadsheet.getSheetByName("변경이력");
  var duplicateKey = [summary.proposalId, action, summary.observationId || ""].join("\u0000");
  var lastRow = sheet.getLastRow();
  if (lastRow >= 2) {
    var rows = sheet.getRange(2, 1, lastRow - 1, 10).getDisplayValues();
    var duplicate = rows.some(function(row) {
      return [row[1], row[7], row[9]].join("\u0000") === duplicateKey;
    });
    if (duplicate) return { created: false };
  }
  var row = Math.max(2, sheet.getLastRow() + 1);
  if (sheet.getMaxRows() < row) sheet.insertRowsAfter(sheet.getMaxRows(), row - sheet.getMaxRows());
  var historyValues = [
    new Date(), summary.proposalId || "", summary.playerId || "", summary.name || "",
    summary.fieldKey || "", samgukPublicBlank_(summary.previousValue),
    samgukPublicBlank_(summary.proposedValue), action, summary.evidenceUrl || "",
    summary.observationId || "", note || ""
  ].map(samgukPublicSafeCell_);
  return samgukPublicWriteTrackedEmptyRange_(
    sheet.getRange(row, 1, 1, historyValues.length), historyValues, [
      { index: 1, expected: summary.proposalId || "" },
      { index: 7, expected: action },
      { index: 9, expected: summary.observationId || "" }
    ], "change_history"
  );
}

function samgukPublicProposalSummary_(values, proposalRow) {
  return {
    proposalId: String(values[0] || "").trim(),
    proposalRow: proposalRow,
    playerId: String(values[2] || "").trim(),
    name: String(values[3] || "").trim(),
    fieldKey: String(values[4] || "").trim(),
    previousValue: values[5] === "" ? null : values[5],
    proposedValue: values[6] === "" ? null : values[6],
    evidenceUrl: String(values[9] || "").trim(),
    observationId: String(values[15] || "").trim(),
    masterRow: values[16] || ""
  };
}

function samgukPublicReadMasterObservation_(observationId) {
  if (!observationId) return null;
  var sheet = samgukPublicMasterSpreadsheet_().getSheetByName("관측입력");
  if (!sheet) throw new Error("master_observation_sheet_missing");
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0];
  var idIndex = headers.indexOf("observation_id");
  var statusIndex = headers.indexOf("검증상태");
  if (idIndex < 0 || statusIndex < 0) throw new Error("master_schema_invalid");
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;
  var match = sheet.getRange(2, idIndex + 1, lastRow - 1, 1)
    .createTextFinder(observationId).matchEntireCell(true).findNext();
  if (!match) return null;
  var values = sheet.getRange(match.getRow(), 1, 1, headers.length).getValues()[0];
  var record = {};
  headers.forEach(function(header, index) { record[header] = values[index]; });
  return { sheet: sheet, row: match.getRow(), headers: headers, statusIndex: statusIndex, record: record };
}

function samgukPublicValidateMasterObservation_(masterObservation, proposal, allowRevoked) {
  var record = masterObservation.record;
  var fieldConfig = SAMGUK_PUBLIC_FIELD_CONFIG[proposal.fieldKey];
  if (!fieldConfig
      || !/^OBS-PUBLIC-[A-F0-9]{32}$/.test(String(record.observation_id || ""))
      || String(record.observation_id || "") !== String(proposal.observationId || "")
      || String(record.player_id || "") !== String(proposal.playerId || "")
      || String(record["기록자"] || "") !== "공개시트 승인"
      || String(record["근거종류"] || "") !== "시트"
      || Number(record["교차검증수"]) !== 1
      || String(record["수집배치"] || "") !== "PUBLIC-" + String(proposal.proposalId || "").slice(-24)
      || Number(record[fieldConfig.observationHeader]) !== Number(proposal.proposedValue)) {
    throw new Error("master_public_observation_mismatch");
  }
  var status = String(record["검증상태"] || "").trim();
  if (status !== "기준값" && !(allowRevoked && status === "철회")) {
    throw new Error("master_public_observation_status_invalid");
  }
}

function samgukPublicReadCurrentRecord_(playerId) {
  var sheet = samgukPublicMasterSpreadsheet_().getSheetByName("현재현황");
  if (!sheet) throw new Error("master_current_sheet_missing");
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0];
  var playerIndex = headers.indexOf("player_id");
  if (playerIndex < 0) throw new Error("master_current_schema_invalid");
  var lastRow = sheet.getLastRow();
  var match = sheet.getRange(2, playerIndex + 1, Math.max(1, lastRow - 1), 1)
    .createTextFinder(playerId).matchEntireCell(true).findNext();
  if (!match) throw new Error("master_current_player_missing");
  var values = sheet.getRange(match.getRow(), 1, 1, headers.length).getValues()[0];
  var record = {};
  headers.forEach(function(header, index) { record[header] = values[index]; });
  return record;
}

function samgukPublicReadCurrentValue_(playerId, fieldKey) {
  if (!playerId || !SAMGUK_PUBLIC_FIELD_CONFIG[fieldKey]) return "";
  var record = samgukPublicReadCurrentRecord_(playerId);
  var value = record[SAMGUK_PUBLIC_FIELD_CONFIG[fieldKey].currentHeader];
  if (value === "" || value === null || value === undefined) return null;
  var numeric = Number(value);
  return isFinite(numeric) ? numeric : null;
}

function samgukPublicValidateProposalNumber_(value, config) {
  if (value === "" || value === null || value === undefined) throw new Error("proposal_value_required");
  var numeric = Number(value);
  if (!isFinite(numeric) || numeric < 0 || numeric > config.maximum) throw new Error("proposal_value_out_of_range");
  if (config.integer && !Number.isInteger(numeric)) throw new Error("proposal_value_must_be_integer");
  return Object.is(numeric, -0) ? 0 : numeric;
}

function samgukPublicValidateObservedAt_(value) {
  var date = value instanceof Date ? new Date(value.getTime()) : new Date(String(value || ""));
  var timestamp = date.getTime();
  if (!isFinite(timestamp) || date.getUTCFullYear() < 2000) throw new Error("observed_at_required");
  if (timestamp > Date.now() + 5 * 60 * 1000) throw new Error("future_observed_at");
  return date;
}

function samgukPublicIsHttpsEvidence_(value) {
  if (typeof value !== "string" || value.length > 2048 || /\s/.test(value)) return false;
  return /^https:\/\/[a-z0-9.-]+(?::\d+)?(?:[\/?#]|$)/i.test(value)
    && value.indexOf("@") < 0;
}

function samgukPublicFindFirstEmptyRow_(sheet, columnCount, maximumRow) {
  if (sheet.getMaxRows() < maximumRow) sheet.insertRowsAfter(sheet.getMaxRows(), maximumRow - sheet.getMaxRows());
  var rows = sheet.getRange(2, 1, maximumRow - 1, columnCount).getDisplayValues();
  for (var index = 0; index < rows.length; index += 1) {
    if (rows[index].every(function(value) { return String(value || "").trim() === ""; })) return index + 2;
  }
  throw new Error("master_observation_sheet_full");
}

function samgukPublicRangesOverlap_(firstColumn, lastColumn, ranges) {
  return ranges.some(function(range) {
    return firstColumn <= range[1] && lastColumn >= range[0];
  });
}

function samgukPublicClearFormulaInputs_(sheet, row) {
  var range = sheet.getRange(row, 3, 1, 9);
  var formulas = range.getFormulas()[0];
  var invalid = [];
  // C, E, G:K만 입력 칸입니다. D와 F의 자동표시 칸은 검사에서 제외합니다.
  [0, 2, 4, 5, 6, 7, 8].forEach(function(index) {
    if (formulas[index]) invalid.push(index + 3);
  });
  if (!invalid.length) return false;
  invalid.forEach(function(column) { sheet.getRange(row, column).clearContent(); });
  sheet.getRange(row, 12, 1, 3).setValues([["오류", "수식은 입력할 수 없습니다.", "자동 차단"]]);
  return true;
}

function samgukPublicNullableCompare_(left, right) {
  if (left === null && right === null) return 0;
  if (left === null) return -1;
  if (right === null) return 1;
  return left - right;
}

function samgukPublicBlank_(value) {
  return value === null || value === undefined || value === "" ? "" : value;
}

function samgukPublicDateOrText_(value) {
  if (!value) return "";
  var timestamp = Date.parse(value);
  return isFinite(timestamp) ? new Date(timestamp) : String(value);
}

function samgukPublicSafeCell_(value) {
  if (typeof value === "string" && /^\s*[=+\-@]/.test(value)) return "'" + value;
  return value;
}

function samgukPublicSha256Hex_(value) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(value), Utilities.Charset.UTF_8)
    .map(function(byte) {
      var normalized = byte < 0 ? byte + 256 : byte;
      return ("0" + normalized.toString(16)).slice(-2);
    }).join("");
}
