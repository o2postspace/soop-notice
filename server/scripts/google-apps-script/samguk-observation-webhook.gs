/**
 * SOOPNOTICE 삼국지 교차검증 스냅샷 수신기.
 *
 * 1. 운영 Google Sheet에 바인딩된 Apps Script 프로젝트에 이 파일을 붙여 넣습니다.
 * 2. 프로젝트 설정 > 스크립트 속성에 SAMGUK_WEBHOOK_SECRET(32자 이상)을 저장합니다.
 * 3. 웹 앱으로 배포한 /exec URL만 서버의 SAMGUK_SHEET_WEBHOOK_URL에 저장합니다.
 * 4. 같은 secret을 서버의 SAMGUK_SHEET_WEBHOOK_SECRET에 저장합니다.
 *
 * 후보값은 받지 않으며 교차검증으로 승격된 완전한 스냅샷만 관측입력에 append합니다.
 */

var SAMGUK_OBSERVATION_SHEET = "관측입력";
var SAMGUK_PARTICIPANT_SHEET = "참가자";
var SAMGUK_MAX_OBSERVATION_ROW = 5001;
var SAMGUK_MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
var SAMGUK_REQUIRED_FIELDS = [
  "level", "horse", "horseLevel", "weapon", "helmet", "armor", "shoes",
  "strength", "agility", "vitality", "intelligence", "powerScore", "maxHealth",
  "basicAttackDamage", "basicAttackSampleCount", "basicAttackTarget", "combatConditions"
];
var SAMGUK_NUMERIC_FIELD_MAXIMUMS = {
  level: 10000,
  horseLevel: 999,
  weapon: 999,
  helmet: 999,
  armor: 999,
  shoes: 999,
  strength: 1000000,
  agility: 1000000,
  vitality: 1000000,
  intelligence: 1000000,
  powerScore: 1000000,
  maxHealth: 1000000,
  basicAttackDamage: 1000000,
  basicAttackSampleCount: 10000
};

function doGet() {
  return samgukJsonResponse_({ ok: true, service: "samguk-observation-webhook", version: 1 });
}

function doPost(event) {
  try {
    if (!event || !event.postData || typeof event.postData.contents !== "string") {
      throw new Error("empty_request");
    }
    var envelope = JSON.parse(event.postData.contents);
    if (!envelope || typeof envelope.payload !== "string" || typeof envelope.signature !== "string") {
      throw new Error("invalid_envelope");
    }
    var secret = PropertiesService.getScriptProperties().getProperty("SAMGUK_WEBHOOK_SECRET");
    if (!secret || secret.length < 32) throw new Error("secret_not_configured");
    var expected = samgukHmacHex_(envelope.payload, secret);
    if (!samgukConstantTimeEqual_(expected, envelope.signature.toLowerCase())) {
      throw new Error("invalid_signature");
    }

    var request = JSON.parse(envelope.payload);
    if (!request || request.version !== 1 || !request.snapshot) throw new Error("invalid_payload");
    var issuedAt = Date.parse(request.issuedAt);
    if (!isFinite(issuedAt) || Math.abs(Date.now() - issuedAt) > SAMGUK_MAX_CLOCK_SKEW_MS) {
      throw new Error("expired_request");
    }
    var snapshot = samgukValidateSnapshot_(request.snapshot);

    var lock = LockService.getScriptLock();
    if (!lock.tryLock(10000)) throw new Error("sheet_busy");
    try {
      return samgukAppendSnapshot_(snapshot);
    } finally {
      lock.releaseLock();
    }
  } catch (error) {
    console.error("samguk webhook rejected", error && error.message);
    var errorCode = String(error && error.message || "unknown_error");
    return samgukJsonResponse_({ ok: false, status: samgukErrorStatus_(errorCode), error: errorCode });
  }
}

function samgukSpreadsheet_() {
  var configuredId = PropertiesService.getScriptProperties().getProperty("SAMGUK_SPREADSHEET_ID");
  var spreadsheet = configuredId
    ? SpreadsheetApp.openById(configuredId)
    : SpreadsheetApp.getActiveSpreadsheet();
  if (!spreadsheet) throw new Error("spreadsheet_not_configured");
  return spreadsheet;
}

function samgukAppendSnapshot_(snapshot) {
  var spreadsheet = samgukSpreadsheet_();
  var sheet = spreadsheet.getSheetByName(SAMGUK_OBSERVATION_SHEET);
  var participants = spreadsheet.getSheetByName(SAMGUK_PARTICIPANT_SHEET);
  if (!sheet || !participants) throw new Error("required_sheet_missing");

  var participantIds = participants.getRange(2, 1, Math.max(1, participants.getLastRow() - 1), 1)
    .getDisplayValues().map(function(row) { return row[0]; });
  if (participantIds.indexOf(snapshot.playerId) < 0) throw new Error("unknown_player");

  var lastRow = Math.min(sheet.getLastRow(), SAMGUK_MAX_OBSERVATION_ROW);
  if (lastRow > 1) {
    var duplicate = sheet.getRange(2, 1, lastRow - 1, 1)
      .createTextFinder(snapshot.observationId).matchEntireCell(true).findNext();
    if (duplicate) {
      return samgukJsonResponse_({ ok: true, duplicate: true, appendedRow: duplicate.getRow() });
    }
  }

  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0];
  var values = new Array(headers.length).fill("");
  var sourceLabels = { sheet: "시트", fmkorea: "에펨코리아", broadcast: "방송" };
  var statusLabels = {
    "cross-source": "교차검증",
    "broadcast-repeat": "방송교차검증"
  };
  var fieldHeaders = {
    level: "레벨", horse: "말", horseLevel: "말강화", weapon: "무기강화",
    helmet: "두갑강화", armor: "흉갑강화", shoes: "각갑강화", strength: "무력",
    agility: "기민", vitality: "기력", intelligence: "지모", powerScore: "무력점수",
    maxHealth: "최대체력", basicAttackDamage: "평타피해대표값",
    basicAttackSampleCount: "평타표본수", basicAttackTarget: "평타대상",
    combatConditions: "전투조건"
  };
  var record = {
    observation_id: snapshot.observationId,
    player_id: snapshot.playerId,
    "확인시각": new Date(snapshot.observedAt),
    "근거종류": snapshot.sourceTypes.map(function(sourceType) {
      return sourceLabels[sourceType];
    }).join("+"),
    "근거(URL/타임코드)": snapshot.sourceUrls.join("\n"),
    "교차검증수": snapshot.sourceCount,
    "검증상태": statusLabels[snapshot.verification],
    "증거해시": snapshot.evidenceHash,
    "수집배치": snapshot.batchId,
    "기록자": "samguk-promoter",
    "OCR신뢰도": snapshot.ocrConfidence === null ? "" : Math.round(snapshot.ocrConfidence * 10000) / 100,
    "메모": snapshot.note || "자동 교차검증 승격",
    "입력시각": new Date()
  };
  SAMGUK_REQUIRED_FIELDS.forEach(function(key) {
    record[fieldHeaders[key]] = snapshot.fields[key] === null ? "" : snapshot.fields[key];
  });
  headers.forEach(function(header, index) {
    if (Object.prototype.hasOwnProperty.call(record, header)) {
      values[index] = samgukSafeCellValue_(record[header]);
    }
  });
  var requiredHeaders = ["observation_id", "player_id", "확인시각", "근거종류", "검증상태"];
  requiredHeaders.forEach(function(header) {
    if (headers.indexOf(header) < 0) throw new Error("missing_header:" + header);
  });

  var targetRow = samgukFindFirstEmptyObservationRow_(sheet, headers.length);
  var currentTarget = sheet.getRange(targetRow, 1, 1, headers.length).getDisplayValues()[0];
  if (currentTarget.some(function(value) { return String(value || "").trim() !== ""; })) {
    throw new Error("target_row_conflict");
  }
  sheet.getRange(targetRow, 1, 1, values.length).setValues([values]);
  SpreadsheetApp.flush();
  var written = sheet.getRange(targetRow, 1, 1, values.length).getValues()[0];
  if (String(written[0] || "") !== snapshot.observationId
      || String(written[1] || "") !== snapshot.playerId
      || String(written[19] || "").toLowerCase() !== snapshot.evidenceHash.toLowerCase()) {
    throw new Error("write_verification_failed");
  }
  return samgukJsonResponse_({ ok: true, duplicate: false, appendedRow: targetRow });
}

/**
 * 부분 작성 행이나 구형 수식이 남은 행을 덮지 않도록 A:AD 전체가 비어 있는 첫 행만 사용합니다.
 */
function samgukFindFirstEmptyObservationRow_(sheet, columnCount) {
  if (sheet.getMaxRows() < SAMGUK_MAX_OBSERVATION_ROW) {
    sheet.insertRowsAfter(
      sheet.getMaxRows(),
      SAMGUK_MAX_OBSERVATION_ROW - sheet.getMaxRows()
    );
  }
  var rows = sheet.getRange(2, 1, SAMGUK_MAX_OBSERVATION_ROW - 1, columnCount).getDisplayValues();
  for (var index = 0; index < rows.length; index += 1) {
    if (rows[index].every(function(value) { return String(value || "").trim() === ""; })) return index + 2;
  }
  throw new Error("observation_sheet_full");
}

function samgukValidateSnapshot_(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) throw new Error("invalid_snapshot");
  if (!/^OBS-[A-Z0-9-]{8,120}$/.test(String(snapshot.observationId || ""))) throw new Error("invalid_observation_id");
  if (!/^P\d{3}$/.test(String(snapshot.playerId || ""))) throw new Error("invalid_player_id");
  if (["cross-source", "broadcast-repeat"].indexOf(snapshot.verification) < 0) throw new Error("not_cross_verified");
  if (["sheet", "fmkorea", "broadcast"].indexOf(snapshot.primarySourceType) < 0) throw new Error("invalid_source");
  if (!Array.isArray(snapshot.sourceTypes) || snapshot.sourceTypes.length < 1 || snapshot.sourceTypes.length > 3) {
    throw new Error("invalid_source_types");
  }
  snapshot.sourceTypes.forEach(function(sourceType) {
    if (["sheet", "fmkorea", "broadcast"].indexOf(sourceType) < 0) throw new Error("invalid_source_types");
  });
  if (snapshot.sourceTypes.filter(function(value, index, values) {
    return values.indexOf(value) === index;
  }).length !== snapshot.sourceTypes.length) throw new Error("duplicate_source_types");
  if (snapshot.sourceTypes.indexOf(snapshot.primarySourceType) < 0) throw new Error("primary_source_missing");
  if (!Number.isInteger(snapshot.sourceCount) || snapshot.sourceCount < 2 || snapshot.sourceCount > 10) throw new Error("invalid_source_count");
  if (snapshot.verification === "cross-source" && snapshot.sourceTypes.length < 2) throw new Error("invalid_cross_source");
  if (snapshot.verification === "broadcast-repeat"
      && (snapshot.sourceTypes.length !== 1 || snapshot.sourceTypes[0] !== "broadcast")) {
    throw new Error("invalid_broadcast_repeat");
  }
  if (!snapshot.fields || typeof snapshot.fields !== "object" || Array.isArray(snapshot.fields)) throw new Error("invalid_fields");
  SAMGUK_REQUIRED_FIELDS.forEach(function(key) {
    if (!Object.prototype.hasOwnProperty.call(snapshot.fields, key)) throw new Error("incomplete_snapshot:" + key);
    var value = snapshot.fields[key];
    if (value === null) return;
    if (["horse", "basicAttackTarget", "combatConditions"].indexOf(key) >= 0) {
      var maximumLength = key === "horse" ? 80 : key === "basicAttackTarget" ? 120 : 240;
      if (typeof value !== "string" || value.length > maximumLength) throw new Error("invalid_field:" + key);
    } else if (typeof value !== "number" || !isFinite(value) || value < 0
        || value > SAMGUK_NUMERIC_FIELD_MAXIMUMS[key]
        || (["powerScore", "basicAttackDamage"].indexOf(key) < 0 && !Number.isInteger(value))) {
      throw new Error("invalid_field:" + key);
    }
  });
  if (!Array.isArray(snapshot.sourceUrls) || snapshot.sourceUrls.length < 1 || snapshot.sourceUrls.length > 10) throw new Error("invalid_sources");
  snapshot.sourceUrls = snapshot.sourceUrls.map(function(value) {
    var url = String(value || "");
    if (!samgukAllowedSourceUrl_(url) || url.length > 2048) throw new Error("invalid_source_url");
    return url;
  });
  if (!/^[a-f0-9]{64}$/i.test(String(snapshot.evidenceHash || ""))) throw new Error("invalid_evidence_hash");
  if (!snapshot.batchId || String(snapshot.batchId).length > 80) throw new Error("invalid_batch_id");
  var observedAt = Date.parse(snapshot.observedAt);
  if (!isFinite(observedAt)) throw new Error("invalid_observed_at");
  if (new Date(observedAt).getUTCFullYear() < 2000) throw new Error("invalid_observed_at");
  if (observedAt > Date.now() + SAMGUK_MAX_CLOCK_SKEW_MS) throw new Error("future_observed_at");
  if (snapshot.ocrConfidence !== null && snapshot.ocrConfidence !== undefined
      && (typeof snapshot.ocrConfidence !== "number" || snapshot.ocrConfidence < 0 || snapshot.ocrConfidence > 1)) {
    throw new Error("invalid_ocr_confidence");
  }
  snapshot.ocrConfidence = snapshot.ocrConfidence === undefined ? null : snapshot.ocrConfidence;
  return snapshot;
}

/** ContentService는 HTTP status setter가 없어 JSON status로 호출자에게 분류를 전달합니다. */
function samgukErrorStatus_(errorCode) {
  if (errorCode === "sheet_busy") return 503;
  if (errorCode === "secret_not_configured" || errorCode === "spreadsheet_not_configured") return 500;
  return 400;
}

function samgukSafeCellValue_(value) {
  if (typeof value === "string" && /^\s*[=+\-@]/.test(value)) return "'" + value;
  return value;
}

function samgukAllowedSourceUrl_(value) {
  return /^https:\/\/(?:[a-z0-9-]+\.)?(?:docs\.google\.com|fmkorea\.com|sooplive\.com|sooplive\.co\.kr)(?:[\/:?#]|$)/i.test(value);
}

function samgukHmacHex_(payload, secret) {
  var bytes = Utilities.computeHmacSha256Signature(payload, secret, Utilities.Charset.UTF_8);
  return bytes.map(function(value) {
    var normalized = value < 0 ? value + 256 : value;
    return ("0" + normalized.toString(16)).slice(-2);
  }).join("");
}

function samgukConstantTimeEqual_(left, right) {
  if (typeof left !== "string" || typeof right !== "string" || left.length !== right.length) return false;
  var mismatch = 0;
  for (var index = 0; index < left.length; index += 1) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return mismatch === 0;
}

function samgukJsonResponse_(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}
