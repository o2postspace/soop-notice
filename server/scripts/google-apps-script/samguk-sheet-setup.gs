/**
 * SOOPNOTICE 삼국지 Google Sheet 원장 설치기.
 *
 * 사용법
 * 1. 대상 Spreadsheet에 바인딩된 Apps Script 프로젝트를 엽니다.
 * 2. 이 파일과 samguk-sheet-seed.generated.gs를 같은 프로젝트에 추가합니다.
 * 3. setupSamgukSheet()를 Spreadsheet 소유자 계정으로 한 번 실행합니다.
 * 4. 추가 운영 관리자는 스크립트 속성 SAMGUK_SHEET_ADMIN_EMAILS에 쉼표로 구분해 넣습니다.
 *
 * 동일 헤더의 운영 탭은 그대로 갱신합니다. 구형 헤더가 발견되면 원본 탭을
 * 백업_YYYYMMDD_HHmmss_탭이름으로 보존하고 공통 열을 새 탭으로 이관합니다.
 */

var SAMGUK_SETUP_VERSION = "2026.08.02.1";
var SAMGUK_SETUP_MAX_INPUT_ROW = 5001;
var SAMGUK_SETUP_PROTECTION_PREFIX = "[SOOPNOTICE_SETUP]";
var SAMGUK_SETUP_SHEET_ORDER = [
  "사용법", "게임정보", "기준정보", "참가자", "방송모니터링", "관측입력",
  "현재현황", "무력랭킹", "영토입력", "영토현황", "OCR설정", "변경로그"
];

var SAMGUK_SETUP_HEADERS = {
  "사용법": ["삼국지 방송 추적 운영 시트"],
  "게임정보": ["분류", "항목", "내용", "출처URL", "기준일", "검수상태"],
  "기준정보": [
    "국가", "", "활동상태", "", "근거종류", "", "검증상태", "", "모니터링상태", "",
    "방송상태", "", "설정", "값", "", "영토소유", "", "예/아니오", "", "시설", "", "점령상태"
  ],
  "참가자": [
    "player_id", "국가", "세력/길드", "닉네임", "SOOP_ID", "장수/직업",
    "활동상태", "프로필URL", "방송URL", "메모"
  ],
  "방송모니터링": [
    "player_id", "국가", "세력/길드", "닉네임", "SOOP_ID", "방송링크",
    "방송상태", "방송제목", "시청자", "모니터링상태", "화면/창번호",
    "해상도", "OCR프로필", "상태확인시각", "담당자", "메모"
  ],
  "관측입력": [
    "observation_id", "player_id", "확인시각", "근거종류", "근거(URL/타임코드)",
    "레벨", "말", "말강화", "무기강화", "두갑강화", "흉갑강화", "각갑강화",
    "무력", "기민", "기력", "지모", "무력점수", "교차검증수", "검증상태",
    "증거해시", "수집배치", "기록자", "OCR신뢰도", "메모", "입력시각"
  ],
  "현재현황": [
    "player_id", "국가", "세력/길드", "닉네임", "SOOP_ID", "장수/직업", "레벨", "말",
    "말강화", "무기강화", "두갑강화", "흉갑강화", "각갑강화", "장비총강화",
    "무력", "기민", "기력", "지모", "무력점수", "최종확인", "최근근거", "출처종류",
    "교차검증수", "검증상태", "신선도", "기량합계", "랭킹점수", "공동순위",
    "정렬순번", "선택원본행"
  ],
  "무력랭킹": [
    "공동순위", "player_id", "국가", "세력/길드", "닉네임", "장수/직업",
    "레벨", "랭킹점수", "기준", "무력점수", "무력", "기민", "기력", "지모",
    "장비총강화", "최종확인", "출처종류", "교차검증수", "검증상태", "근거", "정렬순번"
  ],
  "영토입력": [
    "territory_observation_id", "영토ID", "확인시각", "근거종류", "근거(URL/타임코드)",
    "번호", "X", "Y", "소유국", "수도", "시설", "레벨", "특수지", "점령상태",
    "점령률", "검증상태", "교차검증수", "증거해시", "메모", "입력시각"
  ],
  "영토현황": [
    "영토ID", "번호", "X", "Y", "소유국", "수도", "시설", "레벨", "특수지",
    "점령상태", "점령률", "최종확인", "근거", "출처종류", "교차검증수",
    "검증상태", "메모", "선택원본행"
  ],
  "OCR설정": [
    "profile_id", "항목", "x", "y", "width", "height", "기준해상도", "배율", "활성", "샘플경로", "메모"
  ],
  "변경로그": [
    "change_id", "승격시각", "확인시각", "player_id", "항목", "이전값", "새값",
    "근거", "출처", "교차검증수", "observation_id"
  ]
};

var SAMGUK_SETUP_SPECS = {
  "사용법": { rows: 20, freezeRows: 2, freezeColumns: 0, tabColor: "#5B6AED" },
  "게임정보": { rows: 30, freezeRows: 1, freezeColumns: 0, filter: "A1:F30", tabColor: "#8064A2" },
  "기준정보": { rows: 20, freezeRows: 1, freezeColumns: 0, tabColor: "#8497B0" },
  "참가자": { rows: 91, freezeRows: 1, freezeColumns: 1, filter: "A1:J91", tabColor: "#70AD47" },
  "방송모니터링": { rows: 91, freezeRows: 1, freezeColumns: 1, filter: "A1:P91", tabColor: "#00B0F0" },
  "관측입력": { rows: 5001, freezeRows: 1, freezeColumns: 5, filter: "A1:Y5001", tabColor: "#FFC000" },
  "현재현황": { rows: 91, freezeRows: 1, freezeColumns: 6, filter: "A1:AB91", tabColor: "#4472C4" },
  "무력랭킹": { rows: 91, freezeRows: 1, freezeColumns: 0, filter: "A1:T91", tabColor: "#C00000" },
  "영토입력": { rows: 5001, freezeRows: 1, freezeColumns: 5, filter: "A1:T5001", tabColor: "#ED7D31" },
  "영토현황": { rows: 61, freezeRows: 1, freezeColumns: 4, filter: "A1:Q61", tabColor: "#548235" },
  "OCR설정": { rows: 20, freezeRows: 1, freezeColumns: 0, filter: "A1:K20", tabColor: "#7030A0" },
  "변경로그": { rows: 501, freezeRows: 1, freezeColumns: 0, filter: "A1:K501", tabColor: "#A5A5A5" }
};

var SAMGUK_SETUP_MIGRATION_KEYS = {
  "게임정보": "항목",
  "참가자": "player_id",
  "방송모니터링": "player_id",
  "관측입력": "player_id",
  "영토입력": "영토ID",
  "OCR설정": "profile_id"
};

var SAMGUK_SETUP_HEADER_ALIASES = {
  "검증상태": ["검수상태"],
  "시설": ["거점유형"],
  "출처URL": ["근거", "출처"],
  "근거(URL/타임코드)": ["근거", "최근근거"],
  "세력/길드": ["세력", "길드", "크루"],
  "장수/직업": ["장수", "직업"]
};

function onOpen() {
  SpreadsheetApp.getUi().createMenu("삼국지 원장")
    .addItem("원장 설치/업데이트", "setupSamgukSheet")
    .addItem("보호 다시 적용", "reapplySamgukSheetProtections")
    .addToUi();
}

function setupSamgukSheet() {
  samgukValidateSetupSeed_();
  // webhook과 같은 ScriptLock을 사용해 설치 중 append가 끼어들지 않게 합니다.
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error("다른 원장 설치 작업이 진행 중입니다.");
  try {
    var spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
    if (!spreadsheet) throw new Error("바인딩된 Spreadsheet가 없습니다.");
    spreadsheet.rename("SOOPNOTICE 삼국지 운영원장");
    spreadsheet.setSpreadsheetLocale("ko_KR");
    spreadsheet.setSpreadsheetTimeZone("Asia/Seoul");

    var timestamp = Utilities.formatDate(new Date(), "Asia/Seoul", "yyyyMMdd_HHmmss");
    var prepared = {};
    var backups = [];
    SAMGUK_SETUP_SHEET_ORDER.forEach(function(name) {
      var result = samgukPrepareSheet_(spreadsheet, name, timestamp);
      prepared[name] = result.sheet;
      if (result.backup) backups.push(result.backup.getName());
    });
    backups = backups.concat(samgukArchiveLegacySheets_(spreadsheet, timestamp));

    samgukSeedStaticSheets_(spreadsheet, prepared);
    samgukSeedOperationalSheets_(prepared);
    samgukInstallOutputFormulas_(prepared);
    samgukConfigureAllSheets_(prepared);
    samgukApplyAllProtections_(prepared);
    samgukReorderSheets_(spreadsheet, prepared);

    var properties = PropertiesService.getDocumentProperties();
    properties.setProperty("SAMGUK_SETUP_VERSION", SAMGUK_SETUP_VERSION);
    properties.setProperty("SAMGUK_SETUP_AT", new Date().toISOString());
    properties.setProperty("SAMGUK_SETUP_SPREADSHEET_ID", spreadsheet.getId());
    // 웹 앱 실행에서는 active spreadsheet가 없을 수 있으므로 webhook 대상도 고정합니다.
    PropertiesService.getScriptProperties().setProperty("SAMGUK_SPREADSHEET_ID", spreadsheet.getId());
    spreadsheet.setActiveSheet(prepared["사용법"]);
    SpreadsheetApp.flush();
    spreadsheet.toast(
      "12개 운영 탭 설치 완료" + (backups.length ? " · 구형 탭 백업 " + backups.length + "개" : ""),
      "삼국지 원장",
      8
    );
    return { version: SAMGUK_SETUP_VERSION, sheets: SAMGUK_SETUP_SHEET_ORDER.slice(), backups: backups };
  } finally {
    lock.releaseLock();
  }
}

function reapplySamgukSheetProtections() {
  var spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  var sheets = {};
  SAMGUK_SETUP_SHEET_ORDER.forEach(function(name) {
    var sheet = spreadsheet.getSheetByName(name);
    if (!sheet) throw new Error("필수 탭이 없습니다: " + name);
    sheets[name] = sheet;
  });
  samgukApplyAllProtections_(sheets);
  spreadsheet.toast("보호 설정을 다시 적용했습니다.", "삼국지 원장", 5);
}

function samgukValidateSetupSeed_() {
  if (typeof SAMGUK_SETUP_SEED !== "object" || !SAMGUK_SETUP_SEED) {
    throw new Error("samguk-sheet-seed.generated.gs가 필요합니다.");
  }
  if (SAMGUK_SETUP_SEED.version !== 1
      || !Array.isArray(SAMGUK_SETUP_SEED.members)
      || SAMGUK_SETUP_SEED.members.length !== 90
      || !Array.isArray(SAMGUK_SETUP_SEED.territories)
      || SAMGUK_SETUP_SEED.territories.length !== 60) {
    throw new Error("설치 seed 계약이 올바르지 않습니다.");
  }
}

function samgukPrepareSheet_(spreadsheet, name, timestamp) {
  var headers = SAMGUK_SETUP_HEADERS[name];
  var spec = SAMGUK_SETUP_SPECS[name];
  var sheet = spreadsheet.getSheetByName(name);
  var backup = null;

  if (sheet && !samgukHeaderMatches_(sheet, headers)) {
    if (sheet.getLastRow() <= 1) {
      sheet.clear();
      sheet.getRange(1, 1, 1, sheet.getMaxColumns()).breakApart();
    } else {
      backup = sheet;
      backup.setName(samgukUniqueBackupName_(spreadsheet, timestamp, name));
      backup.setTabColor("#9E9E9E");
      sheet = spreadsheet.insertSheet(name);
      samgukMigrateCommonColumns_(backup, sheet, name);
      backup.hideSheet();
    }
  }

  if (!sheet) {
    var reusable = samgukFindReusableBlankSheet_(spreadsheet);
    sheet = reusable || spreadsheet.insertSheet();
    sheet.setName(name);
  }
  samgukEnsureDimensions_(sheet, spec.rows, headers.length);
  samgukWriteHeader_(sheet, name, headers);
  return { sheet: sheet, backup: backup };
}

function samgukHeaderMatches_(sheet, headers) {
  if (sheet.getLastRow() < 1 || sheet.getMaxColumns() < headers.length) return false;
  var actual = sheet.getRange(1, 1, 1, headers.length).getDisplayValues()[0];
  for (var index = 0; index < headers.length; index += 1) {
    if (String(actual[index] || "").trim() !== String(headers[index] || "").trim()) return false;
  }
  return true;
}

function samgukFindReusableBlankSheet_(spreadsheet) {
  var managed = {};
  SAMGUK_SETUP_SHEET_ORDER.forEach(function(name) { managed[name] = true; });
  var sheets = spreadsheet.getSheets();
  for (var index = 0; index < sheets.length; index += 1) {
    var sheet = sheets[index];
    if (!managed[sheet.getName()] && sheet.getLastRow() === 0 && sheet.getLastColumn() === 0) return sheet;
  }
  return null;
}

function samgukUniqueBackupName_(spreadsheet, timestamp, originalName) {
  var base = ("백업_" + timestamp + "_" + originalName).slice(0, 95);
  var candidate = base;
  var suffix = 2;
  while (spreadsheet.getSheetByName(candidate)) {
    candidate = (base.slice(0, 95 - String(suffix).length) + "_" + suffix).slice(0, 99);
    suffix += 1;
  }
  return candidate;
}

function samgukArchiveLegacySheets_(spreadsheet, timestamp) {
  var managed = {};
  SAMGUK_SETUP_SHEET_ORDER.forEach(function(name) { managed[name] = true; });
  var archived = [];
  spreadsheet.getSheets().forEach(function(sheet) {
    var name = sheet.getName();
    if (managed[name]) return;
    if (name.indexOf("백업_") !== 0) {
      name = samgukUniqueBackupName_(spreadsheet, timestamp, name);
      sheet.setName(name);
      archived.push(name);
    }
    sheet.setTabColor("#9E9E9E");
    if (!sheet.isSheetHidden()) sheet.hideSheet();
  });
  return archived;
}

function samgukMigrateCommonColumns_(source, target, name) {
  var expected = SAMGUK_SETUP_HEADERS[name];
  var sourceWidth = Math.max(1, source.getLastColumn());
  var sourceHeaders = source.getRange(1, 1, 1, sourceWidth).getDisplayValues()[0];
  var sourceIndexes = {};
  expected.forEach(function(header, targetIndex) {
    if (!header) return;
    var candidates = [header].concat(SAMGUK_SETUP_HEADER_ALIASES[header] || []);
    for (var index = 0; index < sourceHeaders.length; index += 1) {
      if (candidates.indexOf(String(sourceHeaders[index] || "").trim()) >= 0) {
        sourceIndexes[targetIndex] = index;
        break;
      }
    }
  });
  var keyHeader = SAMGUK_SETUP_MIGRATION_KEYS[name];
  if (!keyHeader || source.getLastRow() < 2) return;
  var keyTargetIndex = expected.indexOf(keyHeader);
  var keySourceIndex = sourceIndexes[keyTargetIndex];
  if (keySourceIndex === undefined) return;

  var rowCount = source.getLastRow() - 1;
  var values = source.getRange(2, 1, rowCount, sourceWidth).getValues();
  var formulas = source.getRange(2, 1, rowCount, sourceWidth).getFormulas();
  var migrated = [];
  for (var row = 0; row < rowCount; row += 1) {
    if (String(values[row][keySourceIndex] || "").trim() === "") continue;
    var output = new Array(expected.length).fill("");
    Object.keys(sourceIndexes).forEach(function(targetIndexText) {
      var targetIndex = Number(targetIndexText);
      var sourceIndex = sourceIndexes[targetIndex];
      output[targetIndex] = formulas[row][sourceIndex] || values[row][sourceIndex];
    });
    migrated.push(output);
  }
  if (!migrated.length) return;
  samgukEnsureDimensions_(target, migrated.length + 1, expected.length);
  target.getRange(2, 1, migrated.length, expected.length).setValues(migrated);
}

function samgukEnsureDimensions_(sheet, rows, columns) {
  if (sheet.getMaxRows() < rows) sheet.insertRowsAfter(sheet.getMaxRows(), rows - sheet.getMaxRows());
  if (sheet.getMaxColumns() < columns) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), columns - sheet.getMaxColumns());
  }
}

function samgukWriteHeader_(sheet, name, headers) {
  if (name === "사용법") {
    sheet.getRange("A1:H1").breakApart();
    sheet.getRange("A1:H1").merge();
    sheet.getRange("A1").setValue(headers[0]);
    sheet.getRange("A1:H1").setBackground("#172033").setFontColor("#FFFFFF").setFontWeight("bold");
    sheet.setRowHeight(1, 44);
    return;
  }
  sheet.getRange(1, 1, 1, headers.length).setValues([headers])
    .setBackground("#172033")
    .setFontColor("#FFFFFF")
    .setFontWeight("bold")
    .setHorizontalAlignment("center")
    .setVerticalAlignment("middle")
    .setWrap(true);
  sheet.setRowHeight(1, 31);
}

function samgukSeedStaticSheets_(spreadsheet, sheets) {
  samgukSeedGuide_(sheets["사용법"]);
  samgukSeedRules_(sheets["게임정보"]);
  samgukSeedReference_(spreadsheet, sheets["기준정보"]);
  samgukSeedOcr_(sheets["OCR설정"]);
  var logSheet = sheets["변경로그"];
  if (String(logSheet.getRange("A2").getDisplayValue() || "").trim() === "") {
    logSheet.getRange("A2").setValue("교차검증으로 최신값이 승격된 이벤트만 기록합니다.");
  }
}

function samgukSeedGuide_(sheet) {
  var instructions = [
    ["생성 기준", SAMGUK_SETUP_SEED.updatedAt],
    ["운영 원칙", "확인한 화면마다 완전한 스냅샷 한 행을 추가하며 기존 행을 덮어쓰거나 삭제하지 않습니다."],
    ["1. 시트", "Google Sheet 기준값은 초기 baseline으로 즉시 사용합니다."],
    ["2. 에펨코리아", "글에서 추출한 값은 근거 URL과 확인시각을 함께 수집합니다."],
    ["3. 방송", "방송 화면은 서로 다른 프레임 두 장 또는 다른 출처와 일치할 때 자동 승격합니다."],
    ["교차검증", "서로 다른 두 출처가 같은 값을 확인한 최신 스냅샷만 관측입력에 추가합니다."],
    ["현황/랭킹", "현재현황은 승인된 최신 스냅샷 한 행을 통째로 사용하고 무력랭킹은 별도 무력점수를 우선합니다."],
    ["영토", "영토 변화도 완전한 스냅샷을 영토입력에 추가합니다."],
    ["보호", "출력·수식 영역은 관리자 전용이며 입력 영역은 노란 경고 후 편집할 수 있습니다."],
    ["백업", "구형 헤더 탭은 백업_YYYYMMDD_HHmmss_이름으로 숨김 보존됩니다."]
  ];
  for (var index = 0; index < instructions.length; index += 1) {
    var row = index + 3;
    if (!sheet.getRange(row, 1).getValue()) sheet.getRange(row, 1).setValue(instructions[index][0]);
    if (!sheet.getRange(row, 2).getValue()) sheet.getRange(row, 2).setValue(instructions[index][1]);
    sheet.getRange(row, 2, 1, 7).breakApart().mergeAcross().setWrap(true);
    sheet.setRowHeight(row, 34);
  }
}

function samgukSeedRules_(sheet) {
  var rows = SAMGUK_SETUP_SEED.rules.map(function(raw) {
    var rule = samgukSeedObject_(raw, SAMGUK_SETUP_SEED.ruleFields);
    return [rule.category, rule.title, rule.description, rule.sourceUrl, rule.sourceDate, rule.reviewStatus];
  });
  samgukSeedRowsByKey_(sheet, rows, 2, 30);
}

function samgukSeedReference_(spreadsheet, sheet) {
  var groups = {
    1: ["국가", "위", "촉", "오"],
    3: ["활동상태", "활동", "휴식", "하차"],
    5: ["근거종류", "시트", "에펨코리아", "방송", "시트+에펨코리아", "시트+방송", "에펨코리아+방송", "시트+에펨코리아+방송"],
    7: ["검증상태", "기준값", "교차검증", "방송교차검증", "충돌"],
    9: ["모니터링상태", "대기", "수동확인", "OCR연결", "중지"],
    11: ["방송상태", "확인필요", "LIVE", "OFFLINE", "확인실패"],
    16: ["영토소유", "위", "촉", "오", "미점령"],
    18: ["예/아니오", "Y", "N"],
    20: ["시설", "없음", "병영", "성채", "장원"],
    22: ["점령상태", "미점령", "점령", "점령중", "교전", "확인필요"]
  };
  Object.keys(groups).forEach(function(columnText) {
    var column = Number(columnText);
    var values = groups[column].map(function(value) { return [value]; });
    sheet.getRange(1, column, values.length, 1).setValues(values);
  });
  var settings = [
    ["레벨 임시 상한", 10000], ["강화 임시 상한", 999], ["능력치 임시 상한", 1000000],
    ["OCR 신뢰도 상한", 100], ["현황 최신 기준(시간)", 1], ["재확인 기준(시간)", 6]
  ];
  sheet.getRange(2, 13, settings.length, 2).setValues(settings);
  sheet.getRange("M9:N10").setValues([
    ["운영 Google Sheet", spreadsheet.getUrl()],
    ["SOOPNOTICE", "https://soopnotice.com"]
  ]);
}

function samgukSeedOcr_(sheet) {
  var fields = [
    ["level", "레벨"], ["horse", "말"], ["horse_level", "말강화"], ["weapon", "무기강화"],
    ["helmet", "두갑강화"], ["armor", "흉갑강화"], ["shoes", "각갑강화"],
    ["strength", "무력"], ["agility", "기민"], ["vitality", "기력"],
    ["intelligence", "지모"], ["powerScore", "무력점수"]
  ];
  var rows = fields.map(function(field) {
    return ["default", field[1], "", "", "", "", "1920x1080", 1, "N", "", "OCR key: " + field[0]];
  });
  samgukSeedRowsByCompositeKey_(sheet, rows, [1, 2], 20);
}

function samgukSeedOperationalSheets_(sheets) {
  var participantRows = [];
  var monitoringRows = [];
  var observationRows = [];
  var seedDate = String(SAMGUK_SETUP_SEED.updatedAt).slice(0, 10).replace(/-/g, "");
  SAMGUK_SETUP_SEED.members.forEach(function(raw, index) {
    var member = samgukMemberFromSeed_(raw);
    var profileUrl = "https://www.sooplive.com/" + member.soopId;
    var liveUrl = "https://play.sooplive.com/" + member.soopId;
    participantRows.push([
      member.playerId, member.nation, member.crew, member.name, member.soopId, member.job,
      "활동", profileUrl, liveUrl, "설치 seed " + SAMGUK_SETUP_VERSION
    ]);
    monitoringRows.push([
      member.playerId, member.nation, member.crew, member.name, member.soopId, liveUrl,
      "확인필요", "", "", "대기", "", "", "default", member.observedAt, "", ""
    ]);
    observationRows.push([
      "INIT-" + seedDate + "-" + String(index + 1).padStart(3, "0"),
      member.playerId, samgukDateOrBlank_(member.observedAt), "시트", member.evidence,
      samgukBlankIfNull_(member.level), samgukBlankIfNull_(member.horse),
      samgukBlankIfNull_(member.horseLevel), samgukBlankIfNull_(member.weapon),
      samgukBlankIfNull_(member.helmet), samgukBlankIfNull_(member.armor),
      samgukBlankIfNull_(member.shoes), samgukBlankIfNull_(member.strength),
      samgukBlankIfNull_(member.agility), samgukBlankIfNull_(member.vitality),
      samgukBlankIfNull_(member.intelligence), samgukBlankIfNull_(member.powerScore),
      1, "기준값", "", "INIT-" + seedDate, "초기 1회 수집", "",
      "공개 현황의 설치 기준 스냅샷.", samgukDateOrBlank_(member.observedAt)
    ]);
  });
  samgukSeedRowsByKey_(sheets["참가자"], participantRows, 1, 91);
  samgukSeedRowsByKey_(sheets["방송모니터링"], monitoringRows, 1, 91);
  samgukClearBlankIdPrefill_(sheets["관측입력"], 2, SAMGUK_SETUP_MAX_INPUT_ROW);
  samgukSeedRowsByKey_(sheets["관측입력"], observationRows, 1, SAMGUK_SETUP_MAX_INPUT_ROW);

  var territoryRows = [];
  SAMGUK_SETUP_SEED.territories.forEach(function(raw, index) {
    var territory = samgukSeedObject_(raw, SAMGUK_SETUP_SEED.territoryFields);
    var captured = territory.owner === "미점령" ? "미점령" : "점령";
    territoryRows.push([
      "TINIT-" + seedDate + "-" + String(index + 1).padStart(3, "0"),
      territory.id, samgukDateOrBlank_(territory.observedAt), "시트", territory.evidence,
      territory.number, territory.x, territory.y, territory.owner, territory.capital ? "Y" : "N",
      territory.facility, territory.level, territory.number === 27 ? "Y" : "N", captured,
      "", "기준값", 1, "", "공개 지도 초기 기준 스냅샷.", samgukDateOrBlank_(territory.observedAt)
    ]);
  });
  samgukClearBlankIdPrefill_(sheets["영토입력"], 2, SAMGUK_SETUP_MAX_INPUT_ROW);
  samgukSeedRowsByKey_(sheets["영토입력"], territoryRows, 1, SAMGUK_SETUP_MAX_INPUT_ROW);
}

function samgukMemberFromSeed_(raw) {
  var member = samgukSeedObject_(raw.slice(1), SAMGUK_SETUP_SEED.memberFields);
  member.playerId = raw[0];
  return member;
}

function samgukSeedObject_(raw, fields) {
  var result = {};
  fields.forEach(function(field, index) { result[field] = raw[index]; });
  return result;
}

function samgukBlankIfNull_(value) {
  return value === null || value === undefined ? "" : value;
}

function samgukDateOrBlank_(value) {
  var timestamp = Date.parse(value);
  return isFinite(timestamp) ? new Date(timestamp) : "";
}

function samgukSeedRowsByKey_(sheet, seedRows, keyColumn, maxRow) {
  samgukSeedRowsByCompositeKey_(sheet, seedRows, [keyColumn], maxRow);
}

function samgukSeedRowsByCompositeKey_(sheet, seedRows, keyColumns, maxRow) {
  var width = SAMGUK_SETUP_HEADERS[sheet.getName()].length;
  var height = maxRow - 1;
  var range = sheet.getRange(2, 1, height, width);
  var values = range.getValues();
  var formulas = range.getFormulas();
  var rows = values.map(function(row, rowIndex) {
    return row.map(function(value, columnIndex) { return formulas[rowIndex][columnIndex] || value; });
  });
  var indexByKey = {};
  var emptyRows = [];
  rows.forEach(function(row, index) {
    var key = samgukCompositeKey_(row, keyColumns);
    if (key) indexByKey[key] = index;
    else emptyRows.push(index);
  });
  var emptyCursor = 0;
  seedRows.forEach(function(seed) {
    var key = samgukCompositeKey_(seed, keyColumns);
    var targetIndex = indexByKey[key];
    if (targetIndex === undefined) {
      if (emptyCursor >= emptyRows.length) throw new Error(sheet.getName() + " 입력 행이 부족합니다.");
      targetIndex = emptyRows[emptyCursor];
      emptyCursor += 1;
      indexByKey[key] = targetIndex;
    }
    for (var column = 0; column < width; column += 1) {
      if ((rows[targetIndex][column] === "" || rows[targetIndex][column] === null)
          && seed[column] !== null && seed[column] !== undefined) {
        rows[targetIndex][column] = seed[column];
      }
    }
  });
  range.setValues(rows);
}

function samgukCompositeKey_(row, oneBasedColumns) {
  var parts = oneBasedColumns.map(function(column) { return String(row[column - 1] || "").trim(); });
  return parts.some(Boolean) ? parts.join("\u0000") : "";
}

function samgukClearBlankIdPrefill_(sheet, keyColumn, maxRow) {
  var height = maxRow - 1;
  var ids = sheet.getRange(2, 1, height, 1).getValues();
  var idFormulas = sheet.getRange(2, 1, height, 1).getFormulas();
  var keys = sheet.getRange(2, keyColumn, height, 1).getDisplayValues();
  var output = [];
  for (var index = 0; index < height; index += 1) {
    output.push([String(keys[index][0] || "").trim() ? (idFormulas[index][0] || ids[index][0]) : ""]);
  }
  sheet.getRange(2, 1, height, 1).setValues(output);
}

function samgukInstallOutputFormulas_(sheets) {
  samgukInstallCurrentFormulas_(sheets["현재현황"]);
  samgukInstallRankingFormulas_(sheets["무력랭킹"]);
  samgukInstallTerritoryCurrentFormulas_(sheets["영토현황"]);
}

function samgukLatestSnapshotRowFormula_(sheetName, keyColumn, statusColumn, timestampColumn, row) {
  var keyRange = sheetName + "!$" + keyColumn + "$2:$" + keyColumn + "$" + SAMGUK_SETUP_MAX_INPUT_ROW;
  var statusRange = sheetName + "!$" + statusColumn + "$2:$" + statusColumn + "$" + SAMGUK_SETUP_MAX_INPUT_ROW;
  var timestampRange = sheetName + "!$" + timestampColumn + "$2:$" + timestampColumn + "$" + SAMGUK_SETUP_MAX_INPUT_ROW;
  var rowRange = "ROW(" + keyRange + ")";
  var accepted = "((" + statusRange + "=\"기준값\")+(" + statusRange + "=\"교차검증\")+(" + statusRange + "=\"방송교차검증\"))>0";
  var maximum = "MAX(FILTER(" + timestampRange + "," + keyRange + "=$A" + row + "," + accepted + "))";
  var filtered = "FILTER(" + rowRange + "," + keyRange + "=$A" + row + "," + accepted + "," + timestampRange + "=" + maximum + ")";
  return "=IFERROR(INDEX(" + filtered + ",ROWS(" + filtered + ")),\"\")";
}

function samgukSnapshotValueFormula_(row, selectedColumn, sheetName, sourceColumn) {
  var selected = "$" + selectedColumn + row;
  var value = "INDEX(" + sheetName + "!$" + sourceColumn + ":$" + sourceColumn + "," + selected + ")";
  return "=IF(" + selected + "=\"\",\"\",IF(" + value + "=\"\",\"\"," + value + "))";
}

function samgukInstallCurrentFormulas_(sheet) {
  var sourceColumns = {
    7: "F", 8: "G", 9: "H", 10: "I", 11: "J", 12: "K", 13: "L",
    15: "M", 16: "N", 17: "O", 18: "P", 19: "Q", 20: "C", 21: "E",
    22: "D", 23: "R", 24: "S"
  };
  var rows = [];
  for (var row = 2; row <= 91; row += 1) {
    var values = new Array(30).fill("");
    values[0] = "=IF(참가자!A" + row + "=\"\",\"\",참가자!A" + row + ")";
    for (var column = 2; column <= 6; column += 1) {
      var letter = String.fromCharCode(64 + column);
      values[column - 1] = "=IF(참가자!" + letter + row + "=\"\",\"\",참가자!" + letter + row + ")";
    }
    values[29] = samgukLatestSnapshotRowFormula_("관측입력", "B", "S", "C", row);
    Object.keys(sourceColumns).forEach(function(columnText) {
      var targetColumn = Number(columnText);
      values[targetColumn - 1] = samgukSnapshotValueFormula_(row, "AD", "관측입력", sourceColumns[targetColumn]);
    });
    values[13] = "=IF(COUNT(J" + row + ":M" + row + ")=0,\"\",SUM(J" + row + ":M" + row + "))";
    values[24] = "=IF(T" + row + "=\"\",\"미확인\",IF(NOW()-T" + row + "<=1/24,\"최신\",IF(NOW()-T" + row + "<=6/24,\"확인 필요\",\"오래됨\")))";
    values[25] = "=IF(COUNT(O" + row + ":R" + row + ")=0,\"\",SUM(O" + row + ":R" + row + "))";
    values[26] = "=IF(COUNT($S$2:$S$91)>0,S" + row + ",O" + row + ")";
    values[27] = "=IF(OR(AA" + row + "=\"\",AA" + row + "<=0),\"\",RANK.EQ(AA" + row + ",$AA$2:$AA$91,0))";
    values[28] = "=IF(OR(AA" + row + "=\"\",AA" + row + "<=0),\"\",RANK.EQ(AA" + row + ",$AA$2:$AA$91,0)+COUNTIF($AA$2:AA" + row + ",AA" + row + ")-1)";
    rows.push(values);
  }
  sheet.getRange(2, 1, 90, 30).setValues(rows);
}

function samgukInstallRankingFormulas_(sheet) {
  var sourceColumns = {
    1: "AB", 2: "A", 3: "B", 4: "C", 5: "D", 6: "F", 7: "G", 8: "AA",
    10: "S", 11: "O", 12: "P", 13: "Q", 14: "R", 15: "N", 16: "T",
    17: "V", 18: "W", 19: "X", 20: "U"
  };
  var rows = [];
  for (var row = 2; row <= 91; row += 1) {
    var values = new Array(21).fill("");
    values[20] = "=ROW()-1";
    Object.keys(sourceColumns).forEach(function(columnText) {
      var targetColumn = Number(columnText);
      var source = sourceColumns[targetColumn];
      values[targetColumn - 1] = "=IFERROR(INDEX(현재현황!$" + source + "$2:$" + source + "$91,MATCH($U" + row + ",현재현황!$AC$2:$AC$91,0)),\"\")";
    });
    values[8] = "=IF(COUNT(현재현황!$S$2:$S$91)>0,\"무력점수\",\"무력 스탯\")";
    rows.push(values);
  }
  sheet.getRange(2, 1, 90, 21).setValues(rows);
}

function samgukInstallTerritoryCurrentFormulas_(sheet) {
  var sourceColumns = {
    2: "F", 3: "G", 4: "H", 5: "I", 6: "J", 7: "K", 8: "L", 9: "M",
    10: "N", 11: "O", 12: "C", 13: "E", 14: "D", 15: "Q", 16: "P", 17: "S"
  };
  var rows = [];
  SAMGUK_SETUP_SEED.territories.forEach(function(raw, index) {
    var territory = samgukSeedObject_(raw, SAMGUK_SETUP_SEED.territoryFields);
    var row = index + 2;
    var values = new Array(18).fill("");
    values[0] = territory.id;
    values[17] = samgukLatestSnapshotRowFormula_("영토입력", "B", "P", "C", row);
    Object.keys(sourceColumns).forEach(function(columnText) {
      var targetColumn = Number(columnText);
      values[targetColumn - 1] = samgukSnapshotValueFormula_(row, "R", "영토입력", sourceColumns[targetColumn]);
    });
    rows.push(values);
  });
  sheet.getRange(2, 1, 60, 18).setValues(rows);
}

function samgukConfigureAllSheets_(sheets) {
  SAMGUK_SETUP_SHEET_ORDER.forEach(function(name) {
    var sheet = sheets[name];
    var spec = SAMGUK_SETUP_SPECS[name];
    sheet.setFrozenRows(spec.freezeRows || 0);
    sheet.setFrozenColumns(spec.freezeColumns || 0);
    sheet.setTabColor(spec.tabColor);
    sheet.getRange(1, 1, Math.min(spec.rows, sheet.getMaxRows()), SAMGUK_SETUP_HEADERS[name].length)
      .setFontFamily("Noto Sans CJK KR")
      .setVerticalAlignment("middle");
    if (spec.filter) samgukEnsureFilter_(sheet, spec.filter);
  });

  sheets["관측입력"].getRange("C2:C5001").setNumberFormat("yyyy-mm-dd hh:mm:ss");
  sheets["관측입력"].getRange("Y2:Y5001").setNumberFormat("yyyy-mm-dd hh:mm:ss");
  sheets["영토입력"].getRange("C2:C5001").setNumberFormat("yyyy-mm-dd hh:mm:ss");
  sheets["영토입력"].getRange("T2:T5001").setNumberFormat("yyyy-mm-dd hh:mm:ss");
  sheets["현재현황"].getRange("T2:T91").setNumberFormat("yyyy-mm-dd hh:mm:ss");
  sheets["무력랭킹"].getRange("P2:P91").setNumberFormat("yyyy-mm-dd hh:mm:ss");
  sheets["영토현황"].getRange("L2:L61").setNumberFormat("yyyy-mm-dd hh:mm:ss");

  sheets["현재현황"].hideColumns(29, 2);
  sheets["무력랭킹"].hideColumns(21);
  sheets["영토현황"].hideColumns(18);
  samgukApplyValidations_(sheets);
}

function samgukEnsureFilter_(sheet, a1Notation) {
  var filter = sheet.getFilter();
  if (filter && filter.getRange().getA1Notation() === a1Notation) return;
  if (filter) filter.remove();
  sheet.getRange(a1Notation).createFilter();
}

function samgukApplyValidations_(sheets) {
  var reference = sheets["기준정보"];
  samgukListValidation_(sheets["참가자"].getRange("B2:B91"), reference.getRange("A2:A4"));
  samgukListValidation_(sheets["참가자"].getRange("G2:G91"), reference.getRange("C2:C4"));
  samgukListValidation_(sheets["방송모니터링"].getRange("G2:G91"), reference.getRange("K2:K5"));
  samgukListValidation_(sheets["방송모니터링"].getRange("J2:J91"), reference.getRange("I2:I5"));
  samgukListValidation_(sheets["관측입력"].getRange("B2:B5001"), sheets["참가자"].getRange("A2:A91"));
  samgukListValidation_(sheets["관측입력"].getRange("D2:D5001"), reference.getRange("E2:E8"));
  samgukListValidation_(sheets["관측입력"].getRange("S2:S5001"), reference.getRange("G2:G5"));
  samgukNumberValidation_(sheets["관측입력"].getRange("F2:F5001"), 10000);
  samgukNumberValidation_(sheets["관측입력"].getRange("H2:L5001"), 999);
  samgukNumberValidation_(sheets["관측입력"].getRange("M2:Q5001"), 1000000);
  samgukNumberValidation_(sheets["관측입력"].getRange("R2:R5001"), 10);
  samgukNumberValidation_(sheets["관측입력"].getRange("W2:W5001"), 100);

  samgukListValidation_(sheets["영토입력"].getRange("B2:B5001"), sheets["영토현황"].getRange("A2:A61"));
  samgukListValidation_(sheets["영토입력"].getRange("D2:D5001"), reference.getRange("E2:E8"));
  samgukListValidation_(sheets["영토입력"].getRange("I2:I5001"), reference.getRange("P2:P5"));
  samgukListValidation_(sheets["영토입력"].getRange("J2:J5001"), reference.getRange("R2:R3"));
  samgukListValidation_(sheets["영토입력"].getRange("K2:K5001"), reference.getRange("T2:T5"));
  samgukListValidation_(sheets["영토입력"].getRange("M2:M5001"), reference.getRange("R2:R3"));
  samgukListValidation_(sheets["영토입력"].getRange("N2:N5001"), reference.getRange("V2:V6"));
  samgukListValidation_(sheets["영토입력"].getRange("P2:P5001"), reference.getRange("G2:G5"));
  samgukNumberValidation_(sheets["영토입력"].getRange("F2:F5001"), 60);
  samgukNumberValidation_(sheets["영토입력"].getRange("G2:H5001"), 10000);
  samgukNumberValidation_(sheets["영토입력"].getRange("L2:L5001"), 999);
  samgukNumberValidation_(sheets["영토입력"].getRange("O2:O5001"), 100);
  samgukNumberValidation_(sheets["영토입력"].getRange("Q2:Q5001"), 10);
  samgukListValidation_(sheets["OCR설정"].getRange("I2:I20"), reference.getRange("R2:R3"));
  samgukNumberValidation_(sheets["OCR설정"].getRange("C2:F20"), 10000);
}

function samgukListValidation_(targetRange, sourceRange) {
  var rule = SpreadsheetApp.newDataValidation()
    .requireValueInRange(sourceRange, true)
    .setAllowInvalid(false)
    .setHelpText("드롭다운 목록에서 선택하세요.")
    .build();
  targetRange.setDataValidation(rule);
}

function samgukNumberValidation_(targetRange, maximum) {
  var rule = SpreadsheetApp.newDataValidation()
    .requireNumberBetween(0, maximum)
    .setAllowInvalid(false)
    .setHelpText("0~" + maximum + " 범위의 숫자를 입력하세요.")
    .build();
  targetRange.setDataValidation(rule);
}

function samgukApplyAllProtections_(sheets) {
  SAMGUK_SETUP_SHEET_ORDER.forEach(function(name) { samgukRemoveManagedProtections_(sheets[name]); });

  ["사용법", "기준정보", "현재현황", "무력랭킹", "영토현황", "변경로그"].forEach(function(name) {
    samgukProtectAdminOnly_(sheets[name], []);
  });
  samgukProtectInputSheet_(sheets["게임정보"], ["A2:F30"]);

  samgukProtectInputSheet_(sheets["참가자"], ["B2:J91"]);
  samgukProtectInputSheet_(sheets["방송모니터링"], ["G2:P91"]);
  samgukProtectInputSheet_(sheets["관측입력"], ["B2:Q5001", "X2:X5001"]);
  samgukProtectInputSheet_(sheets["영토입력"], ["B2:O5001", "S2:S5001"]);
  samgukProtectInputSheet_(sheets["OCR설정"], ["C2:K20"]);
}

function samgukProtectInputSheet_(sheet, editableA1Ranges) {
  var editableRanges = editableA1Ranges.map(function(a1) { return sheet.getRange(a1); });
  samgukProtectAdminOnly_(sheet, editableRanges);
  editableRanges.forEach(function(range) {
    samgukProtectWarningOnly_(range, sheet.getName() + " 운영 입력 경고");
  });
}

function samgukProtectAdminOnly_(sheet, unprotectedRanges) {
  var protection = sheet.protect()
    .setDescription(SAMGUK_SETUP_PROTECTION_PREFIX + " 관리자 전용 " + sheet.getName())
    .setWarningOnly(false)
    .setUnprotectedRanges(unprotectedRanges || []);
  samgukRestrictProtectionEditors_(protection);
}

function samgukProtectWarningOnly_(range, description) {
  range.protect()
    .setDescription(SAMGUK_SETUP_PROTECTION_PREFIX + " warning-only " + description)
    .setWarningOnly(true);
}

function samgukRestrictProtectionEditors_(protection) {
  var configured = PropertiesService.getScriptProperties().getProperty("SAMGUK_SHEET_ADMIN_EMAILS") || "";
  var current = Session.getEffectiveUser().getEmail() || "";
  var admins = configured.split(",").map(function(value) { return value.trim(); }).filter(Boolean);
  if (current && admins.indexOf(current) < 0) admins.push(current);
  var editors = protection.getEditors();
  if (editors.length) protection.removeEditors(editors);
  if (admins.length) protection.addEditors(admins);
  if (protection.canDomainEdit()) protection.setDomainEdit(false);
}

function samgukRemoveManagedProtections_(sheet) {
  [SpreadsheetApp.ProtectionType.SHEET, SpreadsheetApp.ProtectionType.RANGE].forEach(function(type) {
    sheet.getProtections(type).forEach(function(protection) {
      if (String(protection.getDescription() || "").indexOf(SAMGUK_SETUP_PROTECTION_PREFIX) === 0) {
        protection.remove();
      }
    });
  });
}

function samgukReorderSheets_(spreadsheet, sheets) {
  SAMGUK_SETUP_SHEET_ORDER.forEach(function(name, index) {
    spreadsheet.setActiveSheet(sheets[name]);
    spreadsheet.moveActiveSheet(index + 1);
  });
}
