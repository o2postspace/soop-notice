/**
 * Gamcom 세력 페이지를 보조자료로 읽어 SOOPNOTICE 원장에 병합합니다.
 *
 * 정책
 * - 3개국 30명씩, 우리 원장 90명과 닉네임·국가가 모두 맞아야만 씁니다.
 * - 숫자는 우리 현재값과 외부값 중 큰 값을 채택합니다. 외부의 0도 관측값입니다.
 * - 세력/직업/말 문자열은 우리 값을 우선하고 우리 값이 비었을 때만 채웁니다.
 * - 원문에 갱신시각이 없으므로 외부수집시각과 별도로 표시합니다.
 */

var SAMGUK_GAMCOM_SYNC_VERSION = "2026.08.03.5";
var SAMGUK_GAMCOM_SPREADSHEET_ID = "1xC3leW9fFl4ytHI6i2UkQ8iViBFIwjLrug66lYmVckY";
var SAMGUK_GAMCOM_REFERENCE_SHEET = "외부참고";
var SAMGUK_GAMCOM_CURRENT_SHEET = "현재현황";
var SAMGUK_GAMCOM_OBSERVATION_SHEET = "관측입력";
var SAMGUK_GAMCOM_PARTICIPANT_SHEET = "참가자";
var SAMGUK_GAMCOM_TERRITORY_CURRENT_SHEET = "영토현황";
var SAMGUK_GAMCOM_TERRITORY_INPUT_SHEET = "영토입력";
var SAMGUK_GAMCOM_MAX_OBSERVATION_ROW = 5001;
var SAMGUK_GAMCOM_URLS = {
  "위나라": "https://gamcom-3kingdom.vercel.app/factions/%EC%9C%84",
  "촉나라": "https://gamcom-3kingdom.vercel.app/factions/%EC%B4%89",
  "오나라": "https://gamcom-3kingdom.vercel.app/factions/%EC%98%A4"
};
var SAMGUK_GAMCOM_TERRITORY_URL = "https://gamcom-3kingdom.vercel.app/api/castles?fresh=1";
var SAMGUK_GAMCOM_REFERENCE_HEADERS = [
  "player_id", "SOOP_ID", "국가", "세력/길드", "닉네임", "장수/직업",
  "말", "말강화", "무기강화", "두갑강화", "흉갑강화", "각갑강화",
  "무력", "기민", "기력", "지모", "채택필드", "우리값유지",
  "우리기준확인", "외부수집시각", "외부갱신시각", "출처URL", "적용정책", "주의"
];
var SAMGUK_GAMCOM_SNAPSHOT_FIELDS = [
  "level", "horse", "horseLevel", "weapon", "helmet", "armor", "shoes",
  "strength", "agility", "vitality", "intelligence", "powerScore",
  "maxHealth", "attackPower", "basicAttackDamage", "basicAttackSampleCount",
  "basicAttackTarget", "combatConditions", "healthStat", "activeGeneral", "defense",
  "attackPowerBonusPct", "damageReductionPct", "criticalChancePct", "criticalDamagePct",
  "skillCooldownReductionPct", "skillDamageBonusPct", "moveSpeedBonusPct", "horseMaxHealth",
  "strengthBonus", "agilityBonus", "vitalityBonus", "intelligenceBonus",
  "attackPowerIncrease", "moveSpeedIncrease", "healthIncrease", "skillHasteIncrease"
];
var SAMGUK_GAMCOM_FIELD_HEADERS = {
  level: "레벨", horse: "말", horseLevel: "말강화", weapon: "무기강화",
  helmet: "두갑강화", armor: "흉갑강화", shoes: "각갑강화", strength: "무력",
  agility: "기민", vitality: "기력", intelligence: "지모", powerScore: "무력점수",
    maxHealth: "최대체력", attackPower: "공격력", basicAttackDamage: "평타피해대표값",
    basicAttackSampleCount: "평타표본수", basicAttackTarget: "평타대상",
    combatConditions: "전투조건", healthStat: "체력", activeGeneral: "현재장수",
    defense: "방어력", attackPowerBonusPct: "공격력증가(%)", damageReductionPct: "피해감소(%)",
    criticalChancePct: "치명타확률(%)", criticalDamagePct: "치명타피해(%)",
    skillCooldownReductionPct: "스킬쿨타임감소(%)", skillDamageBonusPct: "스킬피해증가(%)",
    moveSpeedBonusPct: "이동속도증가(%)", horseMaxHealth: "말최대체력",
    strengthBonus: "무력보너스", agilityBonus: "기민보너스",
    vitalityBonus: "기력보너스", intelligenceBonus: "지모보너스",
    attackPowerIncrease: "공격력증가량", moveSpeedIncrease: "이동속도증가량",
    healthIncrease: "체력증가량", skillHasteIncrease: "절기가속증가량"
};
var SAMGUK_GAMCOM_NUMERIC_FIELDS = [
  "horseLevel", "weapon", "helmet", "armor", "shoes",
  "strength", "agility", "vitality", "intelligence"
];
var SAMGUK_GAMCOM_RAW_NUMERIC_FIELDS = {
  horse_level: ["horseLevel", 80], weapon: ["weapon", 15], helmet: ["helmet", 15],
  armor: ["armor", 15], shoes: ["shoes", 15], stat_strength: ["strength", 1000],
  stat_agility: ["agility", 1000], stat_vitality: ["vitality", 1000],
  stat_intelligence: ["intelligence", 1000]
};

function syncSamgukGamcom() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error("gamcom_sync_busy");
  try {
    var spreadsheet = SpreadsheetApp.openById(SAMGUK_GAMCOM_SPREADSHEET_ID);
    if (spreadsheet.getSpreadsheetTimeZone() !== "Asia/Seoul") throw new Error("invalid_sheet_timezone");
    var currentSheet = spreadsheet.getSheetByName(SAMGUK_GAMCOM_CURRENT_SHEET);
    var observationSheet = spreadsheet.getSheetByName(SAMGUK_GAMCOM_OBSERVATION_SHEET);
    var participantSheet = spreadsheet.getSheetByName(SAMGUK_GAMCOM_PARTICIPANT_SHEET);
    var territoryCurrentSheet = spreadsheet.getSheetByName(SAMGUK_GAMCOM_TERRITORY_CURRENT_SHEET);
    var territoryInputSheet = spreadsheet.getSheetByName(SAMGUK_GAMCOM_TERRITORY_INPUT_SHEET);
    if (!currentSheet || !observationSheet || !participantSheet || !territoryCurrentSheet || !territoryInputSheet) {
      throw new Error("required_sheet_missing");
    }

    var collectedAt = new Date();
    var external = samgukGamcomFetchAll_();
    var currentTerritories = samgukGamcomReadCurrentTerritories_(territoryCurrentSheet);
    var externalTerritories = samgukGamcomFetchTerritories_(currentTerritories);
    var current = samgukGamcomReadCurrent_(currentSheet);
    var merged = samgukGamcomMerge_(current, external, collectedAt);
    var referenceValues = samgukGamcomReferenceValues_(merged, collectedAt);
    var snapshotRows = samgukGamcomSnapshotRows_(spreadsheet, observationSheet, merged, collectedAt);
    var territoryResult = samgukGamcomTerritoryRows_(territoryInputSheet, currentTerritories, externalTerritories, collectedAt);

    samgukGamcomInstallSourceValidation_(spreadsheet, observationSheet);
    var participantFilled = samgukGamcomFillParticipantText_(participantSheet, merged);
    samgukGamcomWriteReference_(spreadsheet, referenceValues);
    var appended = samgukGamcomAppendRows_(observationSheet, snapshotRows);
    var territoryAppended = samgukGamcomAppendTerritoryRows_(territoryInputSheet, territoryResult.rows);
    SpreadsheetApp.flush();

    var properties = PropertiesService.getScriptProperties();
    properties.setProperty("SAMGUK_GAMCOM_LAST_SYNC", collectedAt.toISOString());
    properties.setProperty("SAMGUK_GAMCOM_LAST_SUMMARY", JSON.stringify({
      version: SAMGUK_GAMCOM_SYNC_VERSION,
      matched: merged.members.length,
      changedCells: merged.changedCount,
      appended: appended,
      participantFilled: participantFilled,
      retainedConflicts: merged.conflictCount,
      territories: externalTerritories.length,
      territoryChanged: territoryResult.rows.length,
      territoryAppended: territoryAppended,
      territorySourceUpdatedAt: null
    }));
    var summary = {
      ok: true,
      matched: merged.members.length,
      changedCells: merged.changedCount,
      appended: appended,
      participantFilled: participantFilled,
      retainedConflicts: merged.conflictCount,
      territories: externalTerritories.length,
      territoryChanged: territoryResult.rows.length,
      territoryAppended: territoryAppended,
      territorySourceUpdatedAt: null,
      collectedAt: collectedAt.toISOString()
    };
    properties.deleteProperty("SAMGUK_GAMCOM_LAST_ERROR");
    console.log(JSON.stringify(summary));
    return summary;
  } catch (error) {
    try {
      PropertiesService.getScriptProperties().setProperty("SAMGUK_GAMCOM_LAST_ERROR", JSON.stringify({
        at: new Date().toISOString(),
        message: String(error && error.message || error).slice(0, 500)
      }));
    } catch (_ignored) {}
    throw error;
  } finally {
    lock.releaseLock();
  }
}

function installSamgukGamcomSync() {
  var installLock = LockService.getUserLock();
  if (!installLock.tryLock(30000)) throw new Error("gamcom_install_busy");
  try {
    var result = syncSamgukGamcom();
    var spreadsheet = SpreadsheetApp.openById(SAMGUK_GAMCOM_SPREADSHEET_ID);
    var observationSheet = spreadsheet.getSheetByName(SAMGUK_GAMCOM_OBSERVATION_SHEET);
    samgukGamcomMigrateLegacyProvenance_(observationSheet);
    samgukGamcomInstallMonotonicFormulas_(spreadsheet.getSheetByName(SAMGUK_GAMCOM_CURRENT_SHEET));
    SpreadsheetApp.flush();

    ScriptApp.getProjectTriggers().forEach(function(trigger) {
      if (trigger.getHandlerFunction() === "syncSamgukGamcom") ScriptApp.deleteTrigger(trigger);
    });
    ScriptApp.newTrigger("syncSamgukGamcom").timeBased().everyMinutes(15).create();
    PropertiesService.getScriptProperties().setProperty("SAMGUK_GAMCOM_TRIGGER_INSTALLED_AT", new Date().toISOString());
    return result;
  } finally {
    installLock.releaseLock();
  }
}

function samgukGamcomFetchAll_() {
  var nations = Object.keys(SAMGUK_GAMCOM_URLS);
  var requests = nations.map(function(nation) {
    return {
      url: SAMGUK_GAMCOM_URLS[nation], method: "get", followRedirects: false,
      muteHttpExceptions: true,
      headers: { Accept: "text/html", "User-Agent": "SOOPNOTICE-data-sync/1.0" }
    };
  });
  var responses = UrlFetchApp.fetchAll(requests);
  var all = [];
  responses.forEach(function(response, index) {
    if (response.getResponseCode() !== 200) throw new Error("gamcom_http_" + response.getResponseCode());
    var headers = response.getAllHeaders();
    var contentType = String(headers["Content-Type"] || headers["content-type"] || "").toLowerCase();
    if (contentType.indexOf("text/html") < 0 && contentType.indexOf("text/x-component") < 0) {
      throw new Error("gamcom_invalid_content_type");
    }
    var payload = response.getContentText("UTF-8");
    if (payload.length < 2 || payload.length > 524288) throw new Error("gamcom_invalid_response_size");
    var rows = samgukGamcomParseFaction_(payload, nations[index]);
    rows.forEach(function(row) {
      row.sourceUrl = SAMGUK_GAMCOM_URLS[nations[index]];
      all.push(row);
    });
  });
  if (all.length !== 90) throw new Error("gamcom_roster_" + all.length + "_of_90");
  var names = {};
  all.forEach(function(row) {
    if (names[row.nickname]) throw new Error("gamcom_duplicate_name:" + row.nickname);
    names[row.nickname] = true;
  });
  return all;
}

function samgukGamcomFetchTerritories_(currentTerritories) {
  var response = UrlFetchApp.fetch(SAMGUK_GAMCOM_TERRITORY_URL, {
    method: "get",
    followRedirects: false,
    muteHttpExceptions: true,
    headers: { Accept: "application/json", "User-Agent": "SOOPNOTICE-data-sync/1.0" }
  });
  if (response.getResponseCode() !== 200) {
    throw new Error("gamcom_territory_http_" + response.getResponseCode());
  }
  var headers = response.getAllHeaders();
  var contentType = String(headers["Content-Type"] || headers["content-type"] || "").toLowerCase();
  if (contentType.indexOf("application/json") < 0) throw new Error("gamcom_territory_invalid_content_type");
  var payload = response.getContentText("UTF-8");
  if (payload.length < 2 || payload.length > 524288) throw new Error("gamcom_territory_invalid_response_size");
  return samgukGamcomParseTerritories_(payload, currentTerritories);
}

function samgukGamcomReadCurrentTerritories_(sheet) {
  var lastColumn = sheet.getLastColumn();
  var headers = sheet.getRange(1, 1, 1, lastColumn).getDisplayValues()[0];
  var columns = samgukGamcomHeaderMap_(headers);
  ["영토ID", "번호", "X", "Y", "소유국", "수도", "시설", "레벨"].forEach(function(header) {
    if (columns[header] === undefined) throw new Error("territory_current_missing_header:" + header);
  });
  var values = sheet.getRange(2, 1, 60, lastColumn).getValues();
  var territories = values.map(function(row, index) {
    var number = samgukGamcomRequiredInteger_(row[columns["번호"]], 1, 60, "territory_number");
    var territory = {
      id: samgukGamcomTerritoryId_(row[columns["영토ID"]], number),
      number: number,
      x: samgukGamcomRequiredInteger_(row[columns["X"]], 0, 1180, "territory_x"),
      y: samgukGamcomRequiredInteger_(row[columns["Y"]], 0, 720, "territory_y"),
      owner: samgukGamcomTerritoryOwner_(row[columns["소유국"]]),
      capital: samgukGamcomTerritoryBoolean_(row[columns["수도"]], number),
      facility: String(row[columns["시설"]] || "없음").normalize("NFKC").trim(),
      level: samgukGamcomRequiredInteger_(row[columns["레벨"]], 0, 999, "territory_level")
    };
    if (!territory.owner || ["없음", "병영", "성채", "장원"].indexOf(territory.facility) < 0) {
      throw new Error("territory_current_invalid_state:" + (index + 2));
    }
    if (territory.owner === "미점령" && (territory.capital || territory.facility !== "없음")) {
      throw new Error("territory_current_invalid_unclaimed:" + number);
    }
    return territory;
  });
  return samgukGamcomValidateTerritorySet_(territories, "territory_current");
}

function samgukGamcomParseTerritories_(payload, currentTerritories) {
  var parsed;
  try {
    parsed = JSON.parse(payload);
  } catch (_error) {
    throw new Error("gamcom_territory_invalid_json");
  }
  var forces = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed.forces : null;
  if (!forces || typeof forces !== "object" || Array.isArray(forces)) {
    throw new Error("gamcom_territory_forces_missing");
  }
  var groups = {
    "위": { start: 1, end: 20 },
    "촉": { start: 21, end: 40 },
    "오": { start: 41, end: 60 }
  };
  var keys = Object.keys(forces);
  if (keys.length !== 3 || Object.keys(groups).some(function(group) { return keys.indexOf(group) < 0; })) {
    throw new Error("gamcom_territory_invalid_groups");
  }
  var territories = [];
  Object.keys(groups).forEach(function(group) {
    var bounds = groups[group];
    var rows = forces[group];
    if (!Array.isArray(rows) || rows.length !== 20) {
      throw new Error("gamcom_territory_group_" + group + "_" + (Array.isArray(rows) ? rows.length : 0) + "_of_20");
    }
    rows.forEach(function(raw, index) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw new Error("gamcom_territory_invalid_row:" + group + ":" + index);
      }
      var number = Number(raw.name);
      samgukGamcomRequiredInteger_(number, bounds.start, bounds.end, "gamcom_territory_number");
      var localNumber = number - bounds.start + 1;
      var expectedId = group + "-" + ("00" + localNumber).slice(-3);
      var id = samgukGamcomTerritoryId_(raw.castleKey, number);
      if (id !== expectedId) throw new Error("gamcom_territory_id_mismatch:" + number);
      if (typeof raw.isCapital !== "boolean") throw new Error("gamcom_territory_invalid_capital:" + number);
      var owner = samgukGamcomTerritoryOwner_(raw.owner);
      var facility = String(raw.facilityType || "").normalize("NFKC").trim();
      if (!owner) throw new Error("gamcom_territory_invalid_owner:" + number);
      if (["없음", "병영", "성채", "장원"].indexOf(facility) < 0) {
        throw new Error("gamcom_territory_invalid_facility:" + number);
      }
      if (owner === "미점령" && (raw.isCapital || facility !== "없음")) {
        throw new Error("gamcom_territory_invalid_unclaimed:" + number);
      }
      territories.push({
        id: id,
        number: number,
        x: samgukGamcomRequiredInteger_(raw.x, 0, 1180, "gamcom_territory_x"),
        y: samgukGamcomRequiredInteger_(raw.y, 0, 720, "gamcom_territory_y"),
        owner: owner,
        capital: raw.isCapital,
        facility: facility,
        level: samgukGamcomRequiredInteger_(raw.level, 0, 999, "gamcom_territory_level")
      });
    });
  });
  var normalized = samgukGamcomValidateTerritorySet_(territories, "gamcom_territory");
  if (!Array.isArray(currentTerritories) || currentTerritories.length !== 60) {
    throw new Error("territory_current_0_of_60");
  }
  normalized.forEach(function(territory, index) {
    var current = currentTerritories[index];
    if (!current || territory.id !== current.id || territory.number !== current.number
        || territory.x !== current.x || territory.y !== current.y) {
      throw new Error("gamcom_territory_immutable_mismatch:" + territory.number);
    }
  });
  return normalized;
}

function samgukGamcomValidateTerritorySet_(territories, label) {
  if (!Array.isArray(territories) || territories.length !== 60) {
    throw new Error(label + "_" + (Array.isArray(territories) ? territories.length : 0) + "_of_60");
  }
  var ids = {};
  var numbers = {};
  var coordinates = {};
  territories.forEach(function(territory) {
    var coordinate = territory.x + "," + territory.y;
    if (ids[territory.id] || numbers[territory.number] || coordinates[coordinate]) {
      throw new Error(label + "_duplicate_identity");
    }
    ids[territory.id] = true;
    numbers[territory.number] = true;
    coordinates[coordinate] = true;
  });
  for (var number = 1; number <= 60; number += 1) {
    if (!numbers[number]) throw new Error(label + "_missing_number:" + number);
  }
  ["위", "촉", "오"].forEach(function(owner) {
    var capitalCount = territories.filter(function(territory) {
      return territory.owner === owner && territory.capital;
    }).length;
    if (capitalCount !== 1) throw new Error(label + "_capital_count:" + owner + ":" + capitalCount);
    var manorCount = territories.filter(function(territory) {
      return territory.owner === owner && territory.facility === "장원";
    }).length;
    if (manorCount > 10) throw new Error(label + "_manor_limit:" + owner + ":" + manorCount);
  });
  return territories.sort(function(left, right) { return left.number - right.number; });
}

function samgukGamcomTerritoryRows_(sheet, currentTerritories, externalTerritories, collectedAt) {
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0];
  var required = [
    "territory_observation_id", "영토ID", "확인시각", "근거종류", "근거(URL/타임코드)",
    "번호", "X", "Y", "소유국", "수도", "시설", "레벨", "특수지", "점령상태",
    "점령률", "검증상태", "교차검증수", "증거해시", "메모", "입력시각"
  ];
  required.forEach(function(header) {
    if (headers.indexOf(header) < 0) throw new Error("territory_input_missing_header:" + header);
  });
  var snapshotMaterial = JSON.stringify(externalTerritories.map(function(territory) {
    return {
      id: territory.id, number: territory.number, x: territory.x, y: territory.y,
      owner: territory.owner, capital: territory.capital, facility: territory.facility, level: territory.level
    };
  }));
  var snapshotHash = samgukGamcomSha256_(snapshotMaterial);
  var currentById = {};
  currentTerritories.forEach(function(territory) { currentById[territory.id] = territory; });
  var labels = { owner: "소유국", capital: "수도", facility: "시설", level: "레벨" };
  var rows = externalTerritories.map(function(territory) {
    var previous = currentById[territory.id];
    if (!previous || previous.number !== territory.number || previous.x !== territory.x || previous.y !== territory.y) {
      throw new Error("gamcom_territory_immutable_mismatch:" + territory.number);
    }
    var changedFields = ["owner", "capital", "facility", "level"].filter(function(field) {
      return previous[field] !== territory[field];
    });
    if (!changedFields.length) return null;
    var transitionHash = samgukGamcomSha256_(JSON.stringify({
      snapshotHash: snapshotHash,
      observedAt: collectedAt.toISOString(),
      id: territory.id,
      previous: changedFields.reduce(function(result, field) { result[field] = previous[field]; return result; }, {}),
      next: changedFields.reduce(function(result, field) { result[field] = territory[field]; return result; }, {})
    }));
    var record = {
      territory_observation_id: "TERR-GAMCOM-" + transitionHash.slice(0, 24).toUpperCase(),
      "영토ID": territory.id,
      "확인시각": collectedAt,
      "근거종류": "Gamcom",
      "근거(URL/타임코드)": SAMGUK_GAMCOM_TERRITORY_URL,
      "번호": territory.number,
      "X": territory.x,
      "Y": territory.y,
      "소유국": territory.owner,
      "수도": territory.capital ? "Y" : "N",
      "시설": territory.facility,
      "레벨": territory.level,
      "특수지": territory.number === 27 ? "Y" : "N",
      "점령상태": territory.owner === "미점령" ? "미점령" : "점령",
      "점령률": "",
      "검증상태": "기준값",
      "교차검증수": 1,
      "증거해시": snapshotHash,
      "메모": "Gamcom 60칸 전체 응답에서 " + changedFields.map(function(field) { return labels[field]; }).join(", ")
        + " 변경 감지; 원문 갱신시각 미제공",
      "입력시각": collectedAt
    };
    return headers.map(function(header) {
      return Object.prototype.hasOwnProperty.call(record, header) ? samgukGamcomSafeCell_(record[header]) : "";
    });
  }).filter(function(row) { return row !== null; });
  return { rows: rows, snapshotHash: snapshotHash, observedAt: collectedAt, sourceUpdatedAt: null };
}

function samgukGamcomParseFaction_(payload, expectedNation) {
  var flight = payload;
  if (payload.indexOf("self.__next_f.push") >= 0) {
    flight = "";
    var pattern = /self\.__next_f\.push\((\[[\s\S]*?\])\)<\/script>/g;
    var match;
    while ((match = pattern.exec(payload)) !== null) {
      var frame = JSON.parse(match[1]);
      if (frame[0] === 1 && typeof frame[1] === "string") flight += frame[1];
    }
  }
  var marker = flight.indexOf('"rows":');
  if (marker < 0) throw new Error("gamcom_rows_missing");
  var start = flight.indexOf("[", marker + 7);
  var text = samgukGamcomJsonArrayAt_(flight, start);
  if (!text) throw new Error("gamcom_rows_invalid");
  var rawRows = JSON.parse(text);
  if (!Array.isArray(rawRows) || rawRows.length !== 30) {
    throw new Error("gamcom_faction_" + rawRows.length + "_of_30");
  }
  var names = {};
  return rawRows.map(function(raw, index) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("gamcom_invalid_row:" + index);
    var nation = samgukGamcomNation_(raw.nation);
    if (nation !== expectedNation) throw new Error("gamcom_nation_mismatch:" + index);
    var row = {
      nation: nation,
      crewName: samgukGamcomText_(raw.crew_name, "crew"),
      nickname: samgukGamcomText_(raw.nickname, "nickname"),
      job: samgukGamcomText_(raw.job, "job"),
      horse: samgukGamcomText_(raw.horse, "horse", true)
    };
    if (names[row.nickname]) throw new Error("gamcom_duplicate_name:" + row.nickname);
    names[row.nickname] = true;
    Object.keys(SAMGUK_GAMCOM_RAW_NUMERIC_FIELDS).forEach(function(rawField) {
      var config = SAMGUK_GAMCOM_RAW_NUMERIC_FIELDS[rawField];
      row[config[0]] = samgukGamcomInteger_(raw[rawField], config[1], config[0]);
    });
    return row;
  });
}

function samgukGamcomJsonArrayAt_(text, start) {
  if (start < 0 || text.charAt(start) !== "[") return null;
  var depth = 0;
  var quoted = false;
  var escaped = false;
  for (var index = start; index < text.length; index += 1) {
    var character = text.charAt(index);
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
    } else if (character === '"') quoted = true;
    else if (character === "[") depth += 1;
    else if (character === "]") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return null;
}

function samgukGamcomReadCurrent_(sheet) {
  var lastColumn = sheet.getLastColumn();
  var headers = sheet.getRange(1, 1, 1, lastColumn).getDisplayValues()[0];
  var columns = samgukGamcomHeaderMap_(headers);
  var required = ["player_id", "국가", "닉네임", "SOOP_ID", "세력/길드", "장수/직업"];
  required.concat(Object.keys(SAMGUK_GAMCOM_FIELD_HEADERS).map(function(key) {
    return SAMGUK_GAMCOM_FIELD_HEADERS[key];
  })).forEach(function(header) {
    if (columns[header] === undefined) throw new Error("current_missing_header:" + header);
  });
  var values = sheet.getRange(2, 1, 90, lastColumn).getValues();
  var names = {};
  return values.map(function(row, index) {
    var member = {
      playerId: String(row[columns["player_id"]] || "").trim(),
      nation: String(row[columns["국가"]] || "").trim(),
      crew: String(row[columns["세력/길드"]] || "").trim(),
      name: String(row[columns["닉네임"]] || "").trim(),
      soopId: String(row[columns["SOOP_ID"]] || "").trim(),
      job: String(row[columns["장수/직업"]] || "").trim()
    };
    Object.keys(SAMGUK_GAMCOM_FIELD_HEADERS).forEach(function(field) {
      var value = row[columns[SAMGUK_GAMCOM_FIELD_HEADERS[field]]];
      member[field] = value === "" || value === null ? null : value;
    });
    if (!/^P\d{3}$/.test(member.playerId) || !member.name || names[member.name]) {
      throw new Error("current_invalid_roster:" + (index + 2));
    }
    names[member.name] = true;
    var observed = row[columns["최종확인"]];
    member.observedAt = observed instanceof Date && isFinite(observed.getTime()) ? observed : null;
    return member;
  });
}

function samgukGamcomFillParticipantText_(sheet, merged) {
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0];
  var columns = samgukGamcomHeaderMap_(headers);
  ["player_id", "세력/길드", "장수/직업"].forEach(function(header) {
    if (columns[header] === undefined) throw new Error("participant_missing_header:" + header);
  });
  var memberById = {};
  merged.members.forEach(function(member) { memberById[member.playerId] = member; });
  var rows = sheet.getRange(2, 1, 90, sheet.getLastColumn()).getDisplayValues();
  var pending = [];
  var seen = {};
  rows.forEach(function(row, index) {
    var playerId = String(row[columns["player_id"]] || "").trim();
    var member = memberById[playerId];
    if (!member || seen[playerId]) throw new Error("participant_roster_mismatch:" + (index + 2));
    seen[playerId] = true;
    [["crew", "세력/길드"], ["job", "장수/직업"]].forEach(function(pair) {
      var column = columns[pair[1]] + 1;
      if (!String(row[column - 1] || "").trim() && samgukGamcomPresent_(member[pair[0]])) {
        pending.push({ row: index + 2, column: column, value: samgukGamcomSafeCell_(member[pair[0]]) });
      }
    });
  });
  if (Object.keys(seen).length !== 90) throw new Error("participant_roster_mismatch");
  var written = 0;
  pending.forEach(function(item) {
    var target = sheet.getRange(item.row, item.column);
    if (String(target.getDisplayValue() || "").trim()) return;
    target.setValue(item.value);
    written += 1;
  });
  return written;
}

function samgukGamcomMerge_(current, external, collectedAt) {
  if (current.length !== 90 || external.length !== 90) throw new Error("merge_requires_90");
  var externalByName = {};
  external.forEach(function(row) { externalByName[row.nickname] = row; });
  var seen = {};
  var changedCount = 0;
  var conflictCount = 0;
  var members = current.map(function(source) {
    var externalRow = externalByName[source.name];
    if (!externalRow || seen[source.name]) throw new Error("merge_name_mismatch:" + source.name);
    seen[source.name] = true;
    if (samgukGamcomNation_(source.nation) !== externalRow.nation) throw new Error("merge_nation_mismatch:" + source.name);
    var member = {};
    Object.keys(source).forEach(function(key) { member[key] = source[key]; });
    var changed = [];
    var retained = [];
    [["crew", "crewName"], ["job", "job"], ["horse", "horse"]].forEach(function(pair) {
      var currentValue = samgukGamcomPresent_(source[pair[0]]) ? String(source[pair[0]]).trim() : null;
      var externalValue = samgukGamcomPresent_(externalRow[pair[1]]) ? String(externalRow[pair[1]]).trim() : null;
      if (!currentValue && externalValue) {
        member[pair[0]] = externalValue;
        changed.push(pair[0]);
        changedCount += 1;
      } else if (currentValue && externalValue && currentValue !== externalValue) {
        retained.push(pair[0]);
        conflictCount += 1;
      }
    });
    SAMGUK_GAMCOM_NUMERIC_FIELDS.forEach(function(field) {
      var currentValue = samgukGamcomPresent_(source[field]) ? Number(source[field]) : null;
      var externalValue = samgukGamcomPresent_(externalRow[field]) ? Number(externalRow[field]) : null;
      if (currentValue !== null && !isFinite(currentValue)) throw new Error("current_invalid_number:" + source.name + ":" + field);
      if (externalValue === null) return;
      var selected = currentValue === null ? externalValue : Math.max(currentValue, externalValue);
      member[field] = selected;
      if (currentValue === null || selected !== currentValue) {
        changed.push(field);
        changedCount += 1;
      } else if (currentValue > externalValue) {
        retained.push(field);
        conflictCount += 1;
      }
    });
    member.gamcom = externalRow;
    member.changedFields = changed;
    member.retainedFields = retained;
    member.collectedAt = collectedAt;
    return member;
  });
  if (Object.keys(seen).length !== 90 || Object.keys(externalByName).some(function(name) { return !seen[name]; })) {
    throw new Error("merge_roster_mismatch");
  }
  return { members: members, changedCount: changedCount, conflictCount: conflictCount };
}

function samgukGamcomReferenceValues_(merged, collectedAt) {
  return [SAMGUK_GAMCOM_REFERENCE_HEADERS].concat(merged.members.map(function(member) {
    var external = member.gamcom;
    return [
      member.playerId, member.soopId, external.nation, external.crewName, external.nickname, external.job,
      external.horse || "", samgukGamcomBlank_(external.horseLevel), samgukGamcomBlank_(external.weapon),
      samgukGamcomBlank_(external.helmet), samgukGamcomBlank_(external.armor), samgukGamcomBlank_(external.shoes),
      samgukGamcomBlank_(external.strength), samgukGamcomBlank_(external.agility),
      samgukGamcomBlank_(external.vitality), samgukGamcomBlank_(external.intelligence),
      member.changedFields.join(", "), member.retainedFields.join(", "), member.observedAt || "", collectedAt,
      "", external.sourceUrl, "숫자 MAX · 텍스트 우리 원장 우선",
      "보조자료 · 원문 갱신시각 미제공 · 낮은 값 자동 반영 안 함"
    ].map(samgukGamcomSafeCell_);
  }));
}

function samgukGamcomSnapshotRows_(spreadsheet, sheet, merged, collectedAt) {
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0];
  var requiredHeaders = [
    "observation_id", "player_id", "확인시각", "근거종류", "근거(URL/타임코드)",
    "교차검증수", "검증상태", "증거해시", "수집배치", "기록자", "메모", "입력시각"
  ].concat(SAMGUK_GAMCOM_SNAPSHOT_FIELDS.map(function(field) {
    return SAMGUK_GAMCOM_FIELD_HEADERS[field];
  }));
  requiredHeaders.forEach(function(header) {
    if (headers.indexOf(header) < 0) throw new Error("observation_missing_header:" + header);
  });
  return merged.members.filter(function(member) {
    return member.changedFields.some(function(field) {
      return SAMGUK_GAMCOM_SNAPSHOT_FIELDS.indexOf(field) >= 0;
    });
  }).map(function(member) {
    var snapshotChangedFields = member.changedFields.filter(function(field) {
      return SAMGUK_GAMCOM_SNAPSHOT_FIELDS.indexOf(field) >= 0;
    });
    var fields = {};
    SAMGUK_GAMCOM_SNAPSHOT_FIELDS.forEach(function(field) {
      fields[field] = member[field] === undefined || member[field] === "" ? null : member[field];
    });
    var material = JSON.stringify({
      playerId: member.playerId,
      fields: fields,
      sourceUrl: member.gamcom.sourceUrl
    });
    var digest = samgukGamcomSha256_(material);
    var record = {
      observation_id: "OBS-GAMCOM-" + digest.slice(0, 24).toUpperCase(),
      player_id: member.playerId,
      "확인시각": collectedAt,
      "근거종류": "시트+Gamcom",
      "근거(URL/타임코드)": spreadsheet.getUrl() + "\n" + member.gamcom.sourceUrl,
      "교차검증수": 2,
      "검증상태": "기준값",
      "증거해시": digest,
      "수집배치": "GAMCOM-" + Utilities.formatDate(collectedAt, "Asia/Seoul", "yyyyMMdd-HHmm"),
      "기록자": "samguk-gamcom-sync",
      "OCR신뢰도": "",
      "메모": "Gamcom 보조자료와 우리 원장 숫자 최고값 병합 (" + snapshotChangedFields.join(", ") + "); 값 일치 교차검증 아님 · 원문 갱신시각 미제공",
      "입력시각": new Date()
    };
    SAMGUK_GAMCOM_SNAPSHOT_FIELDS.forEach(function(field) {
      record[SAMGUK_GAMCOM_FIELD_HEADERS[field]] = fields[field] === null ? "" : fields[field];
    });
    return headers.map(function(header) {
      return Object.prototype.hasOwnProperty.call(record, header) ? samgukGamcomSafeCell_(record[header]) : "";
    });
  });
}

function samgukGamcomInstallSourceValidation_(spreadsheet, observationSheet) {
  var reference = spreadsheet.getSheetByName("기준정보");
  if (!reference) throw new Error("reference_sheet_missing");
  var sources = [
    "시트", "Gamcom", "에펨코리아", "방송", "시트+Gamcom", "시트+에펨코리아", "시트+방송",
    "Gamcom+에펨코리아", "Gamcom+방송", "에펨코리아+방송", "시트+Gamcom+에펨코리아",
    "시트+Gamcom+방송", "시트+에펨코리아+방송", "Gamcom+에펨코리아+방송",
    "시트+Gamcom+에펨코리아+방송"
  ];
  reference.getRange(1, 5, 20, 1).clearContent();
  reference.getRange(1, 5, sources.length + 1, 1).setValues([["근거종류"]].concat(sources.map(function(value) { return [value]; })));
  var rule = SpreadsheetApp.newDataValidation()
    .requireValueInRange(reference.getRange(2, 5, sources.length, 1), true)
    .setAllowInvalid(false)
    .setHelpText("드롭다운 목록에서 선택하세요.")
    .build();
  observationSheet.getRange("D2:D5001").setDataValidation(rule);
  var territory = spreadsheet.getSheetByName("영토입력");
  if (territory) territory.getRange("D2:D5001").setDataValidation(rule);
}

function samgukGamcomMigrateLegacyProvenance_(sheet) {
  if (!sheet) throw new Error("observation_sheet_missing");
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0];
  var columns = samgukGamcomHeaderMap_(headers);
  ["observation_id", "근거종류", "검증상태"].forEach(function(header) {
    if (columns[header] === undefined) throw new Error("observation_missing_header:" + header);
  });
  var rowCount = Math.max(0, Math.min(sheet.getLastRow(), SAMGUK_GAMCOM_MAX_OBSERVATION_ROW) - 1);
  if (!rowCount) return 0;
  var values = sheet.getRange(2, 1, rowCount, sheet.getLastColumn()).getDisplayValues();
  var statusRange = sheet.getRange(2, columns["검증상태"] + 1, rowCount, 1);
  var statuses = statusRange.getValues();
  var changed = 0;
  values.forEach(function(row, index) {
    var observationId = String(row[columns["observation_id"]] || "");
    var source = String(row[columns["근거종류"]] || "");
    if (observationId.indexOf("OBS-GAMCOM-") === 0 && source.indexOf("Gamcom") >= 0
        && String(statuses[index][0] || "") !== "기준값") {
      statuses[index][0] = "기준값";
      changed += 1;
    }
  });
  if (changed) statusRange.setValues(statuses);
  return changed;
}

function samgukGamcomInstallMonotonicFormulas_(sheet) {
  if (!sheet) throw new Error("current_sheet_missing");
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0];
  var columns = samgukGamcomHeaderMap_(headers);
  var sourceColumns = {
    "레벨": "F", "말강화": "H", "무기강화": "I", "두갑강화": "J",
    "흉갑강화": "K", "각갑강화": "L", "무력": "M", "기민": "N",
    "기력": "O", "지모": "P", "무력점수": "Q", "최대체력": "Y", "공격력": "AE"
  };
  if (columns["player_id"] === undefined) throw new Error("current_missing_header:player_id");
  Object.keys(sourceColumns).forEach(function(header) {
    if (columns[header] === undefined) throw new Error("current_missing_header:" + header);
    var formulas = [];
    for (var row = 2; row <= 91; row += 1) {
      formulas.push([samgukGamcomMaxAcceptedFormula_(row, sourceColumns[header])]);
    }
    sheet.getRange(2, columns[header] + 1, 90, 1).setFormulas(formulas);
  });
}

function samgukGamcomMaxAcceptedFormula_(row, sourceColumn) {
  var keyRange = "관측입력!$B$2:$B$" + SAMGUK_GAMCOM_MAX_OBSERVATION_ROW;
  var statusRange = "관측입력!$S$2:$S$" + SAMGUK_GAMCOM_MAX_OBSERVATION_ROW;
  var valueRange = "관측입력!$" + sourceColumn + "$2:$" + sourceColumn + "$" + SAMGUK_GAMCOM_MAX_OBSERVATION_ROW;
  var accepted = "((" + statusRange + "=\"기준값\")+(" + statusRange + "=\"교차검증\")+(" + statusRange + "=\"방송교차검증\"))>0";
  return "=IFERROR(MAX(FILTER(" + valueRange + "," + keyRange + "=$A" + row + "," + accepted + "," + valueRange + "<>\"\")),\"\")";
}

function samgukGamcomWriteReference_(spreadsheet, values) {
  var sheet = spreadsheet.getSheetByName(SAMGUK_GAMCOM_REFERENCE_SHEET);
  var created = false;
  if (!sheet) {
    sheet = spreadsheet.insertSheet(SAMGUK_GAMCOM_REFERENCE_SHEET);
    created = true;
  }
  if (sheet.getMaxRows() < 91) sheet.insertRowsAfter(sheet.getMaxRows(), 91 - sheet.getMaxRows());
  if (sheet.getMaxColumns() < SAMGUK_GAMCOM_REFERENCE_HEADERS.length) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), SAMGUK_GAMCOM_REFERENCE_HEADERS.length - sheet.getMaxColumns());
  }
  sheet.getRange(1, 1, 91, SAMGUK_GAMCOM_REFERENCE_HEADERS.length).clearContent();
  sheet.getRange(1, 1, values.length, SAMGUK_GAMCOM_REFERENCE_HEADERS.length).setValues(values);
  sheet.setFrozenRows(1);
  sheet.setFrozenColumns(3);
  sheet.setTabColor("#5B9BD5");
  sheet.getRange(1, 1, 1, SAMGUK_GAMCOM_REFERENCE_HEADERS.length)
    .setBackground("#172033").setFontColor("#FFFFFF").setFontWeight("bold")
    .setHorizontalAlignment("center").setWrap(true);
  sheet.getRange(2, 19, 90, 2).setNumberFormat("yyyy-mm-dd hh:mm:ss");
  var filter = sheet.getFilter();
  if (filter) filter.remove();
  sheet.getRange(1, 1, 91, SAMGUK_GAMCOM_REFERENCE_HEADERS.length).createFilter();
  sheet.autoResizeColumns(1, SAMGUK_GAMCOM_REFERENCE_HEADERS.length);
  sheet.setColumnWidths(17, 2, 180);
  sheet.setColumnWidth(22, 300);
  sheet.setColumnWidth(24, 340);
  if (created) {
    sheet.protect().setDescription("[SOOPNOTICE_GAMCOM] 자동 동기화 참고자료").setWarningOnly(true);
  }
}

function samgukGamcomAppendRows_(sheet, rows) {
  if (rows.length === 0) return 0;
  var width = sheet.getLastColumn();
  var existing = sheet.getRange(2, 1, SAMGUK_GAMCOM_MAX_OBSERVATION_ROW - 1, width).getDisplayValues();
  var existingIds = {};
  var emptyRows = [];
  existing.forEach(function(row, index) {
    if (row[0]) existingIds[row[0]] = true;
    if (row.every(function(value) { return String(value || "").trim() === ""; })) emptyRows.push(index + 2);
  });
  var pending = rows.filter(function(row) { return !existingIds[String(row[0] || "")]; });
  if (pending.length > emptyRows.length) throw new Error("observation_sheet_full");
  var groups = [];
  pending.forEach(function(row, index) {
    var targetRow = emptyRows[index];
    var last = groups.length ? groups[groups.length - 1] : null;
    if (last && last.start + last.rows.length === targetRow) last.rows.push(row);
    else groups.push({ start: targetRow, rows: [row] });
  });
  groups.forEach(function(group) {
    var before = sheet.getRange(group.start, 1, group.rows.length, width).getDisplayValues();
    if (before.some(function(row) { return row.some(function(value) { return String(value || "").trim() !== ""; }); })) {
      throw new Error("target_row_conflict");
    }
  });
  groups.forEach(function(group) {
    sheet.getRange(group.start, 1, group.rows.length, width).setValues(group.rows);
  });
  SpreadsheetApp.flush();
  groups.forEach(function(group) {
    var written = sheet.getRange(group.start, 1, group.rows.length, 2).getDisplayValues();
    written.forEach(function(row, index) {
      if (row[0] !== String(group.rows[index][0]) || row[1] !== String(group.rows[index][1])) {
        throw new Error("write_verification_failed");
      }
    });
  });
  return pending.length;
}

function samgukGamcomAppendTerritoryRows_(sheet, rows) {
  if (rows.length === 0) return 0;
  var width = sheet.getLastColumn();
  var existing = sheet.getRange(2, 1, SAMGUK_GAMCOM_MAX_OBSERVATION_ROW - 1, width).getDisplayValues();
  var existingIds = {};
  existing.forEach(function(row) {
    var id = String(row[0] || "").trim();
    if (id) existingIds[id] = true;
  });
  var pendingIds = {};
  var pending = rows.filter(function(row) {
    var id = String(row[0] || "").trim();
    if (!id || row.length !== width) throw new Error("territory_invalid_pending_row");
    if (pendingIds[id]) throw new Error("territory_duplicate_pending_id:" + id);
    pendingIds[id] = true;
    return !existingIds[id];
  });
  if (!pending.length) return 0;

  var runStart = -1;
  var runLength = 0;
  for (var index = 0; index < existing.length; index += 1) {
    var empty = existing[index].every(function(value) { return String(value || "").trim() === ""; });
    if (empty) {
      if (runLength === 0) runStart = index + 2;
      runLength += 1;
      if (runLength >= pending.length) break;
    } else {
      runStart = -1;
      runLength = 0;
    }
  }
  if (runStart < 0 || runLength < pending.length) throw new Error("territory_input_no_contiguous_space");
  var target = sheet.getRange(runStart, 1, pending.length, width);
  var before = target.getDisplayValues();
  if (before.some(function(row) {
    return row.some(function(value) { return String(value || "").trim() !== ""; });
  })) {
    throw new Error("territory_target_row_conflict");
  }
  target.setValues(pending);
  SpreadsheetApp.flush();
  var written = sheet.getRange(runStart, 1, pending.length, 2).getDisplayValues();
  written.forEach(function(row, index) {
    if (row[0] !== String(pending[index][0]) || row[1] !== String(pending[index][1])) {
      throw new Error("territory_write_verification_failed");
    }
  });
  return pending.length;
}

function samgukGamcomHeaderMap_(headers) {
  var result = {};
  headers.forEach(function(header, index) { result[String(header || "").trim()] = index; });
  return result;
}

function samgukGamcomNation_(value) {
  var raw = String(value || "").trim();
  if (["위", "위나라", "魏"].indexOf(raw) >= 0) return "위나라";
  if (["촉", "촉나라", "蜀"].indexOf(raw) >= 0) return "촉나라";
  if (["오", "오나라", "吳"].indexOf(raw) >= 0) return "오나라";
  return null;
}

function samgukGamcomTerritoryOwner_(value) {
  var raw = String(value || "").normalize("NFKC").trim();
  if (["위", "위나라", "魏"].indexOf(raw) >= 0) return "위";
  if (["촉", "촉나라", "蜀"].indexOf(raw) >= 0) return "촉";
  if (["오", "오나라", "吳"].indexOf(raw) >= 0) return "오";
  if (["미점령", "없음"].indexOf(raw) >= 0) return "미점령";
  return null;
}

function samgukGamcomTerritoryId_(value, number) {
  if (typeof value !== "string" || value.length < 5 || value.length > 24
      || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error("gamcom_territory_invalid_id:" + number);
  }
  var normalized = value.normalize("NFKC").trim();
  if (!normalized) throw new Error("gamcom_territory_invalid_id:" + number);
  return normalized;
}

function samgukGamcomTerritoryBoolean_(value, number) {
  if (typeof value === "boolean") return value;
  var raw = String(value || "").normalize("NFKC").trim().toLowerCase();
  if (["y", "yes", "true", "1", "예", "수도", "o", "○"].indexOf(raw) >= 0) return true;
  if (["n", "no", "false", "0", "아니오", "없음", "x", "×"].indexOf(raw) >= 0) return false;
  throw new Error("territory_current_invalid_capital:" + number);
}

function samgukGamcomRequiredInteger_(value, minimum, maximum, label) {
  if (typeof value !== "number" || !isFinite(value) || Math.floor(value) !== value
      || value < minimum || value > maximum) {
    throw new Error(label + "_invalid");
  }
  return value;
}

function samgukGamcomText_(value, label, nullable) {
  if (value === null || value === undefined || value === "") {
    if (nullable) return null;
    throw new Error("gamcom_empty_text:" + label);
  }
  if (typeof value !== "string" || value.length > 120 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error("gamcom_invalid_text:" + label);
  }
  var normalized = value.trim();
  if (!normalized && !nullable) throw new Error("gamcom_empty_text:" + label);
  return normalized || null;
}

function samgukGamcomInteger_(value, maximum, label) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "number" || !isFinite(value) || Math.floor(value) !== value || value < 0 || value > maximum) {
    throw new Error("gamcom_invalid_number:" + label);
  }
  return value;
}

function samgukGamcomPresent_(value) {
  return value !== null && value !== undefined && value !== "";
}

function samgukGamcomBlank_(value) {
  return samgukGamcomPresent_(value) ? value : "";
}

function samgukGamcomSafeCell_(value) {
  if (typeof value === "string" && /^\s*[=+\-@]/.test(value)) return "'" + value;
  return value === undefined || value === null ? "" : value;
}

function samgukGamcomSha256_(value) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, value, Utilities.Charset.UTF_8);
  return bytes.map(function(byte) {
    var normalized = byte < 0 ? byte + 256 : byte;
    return ("0" + normalized.toString(16)).slice(-2);
  }).join("");
}
