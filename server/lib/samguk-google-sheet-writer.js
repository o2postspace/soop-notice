"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  NUMERIC_FIELD_MAXIMUMS,
  acquireObservationQueueLock,
} = require("./samguk-observations");

const GOOGLE_TOKEN_URI = "https://oauth2.googleapis.com/token";
const GOOGLE_SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const GOOGLE_SHEETS_API_ROOT = "https://sheets.googleapis.com/v4/spreadsheets";
const OBSERVATION_SHEET = "관측입력";
const PARTICIPANT_SHEET = "참가자";
const OBSERVATION_LAST_COLUMN = "AE";
const MAX_OBSERVATION_ROW = 5001;
const MAX_SNAPSHOT_BATCH = 100;
const MAX_TOKEN_BYTES = 32 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 512 * 1024;
const KST_OFFSET_DAYS = 9 / 24;
const SHEET_EPOCH_DAYS = 25_569;
const MIN_OBSERVED_AT_MS = Date.UTC(2000, 0, 1);
const FIELD_HEADERS = Object.freeze({
  level: "레벨",
  horse: "말",
  horseLevel: "말강화",
  weapon: "무기강화",
  helmet: "두갑강화",
  armor: "흉갑강화",
  shoes: "각갑강화",
  strength: "무력",
  agility: "기민",
  vitality: "기력",
  intelligence: "지모",
  powerScore: "무력점수",
  maxHealth: "최대체력",
  attackPower: "공격력",
  basicAttackDamage: "평타피해대표값",
  basicAttackSampleCount: "평타표본수",
  basicAttackTarget: "평타대상",
  combatConditions: "전투조건",
});
const FIELD_NAMES = Object.freeze(Object.keys(FIELD_HEADERS));
const EXPECTED_HEADERS = Object.freeze([
  "observation_id", "player_id", "확인시각", "근거종류", "근거(URL/타임코드)",
  "레벨", "말", "말강화", "무기강화", "두갑강화", "흉갑강화", "각갑강화",
  "무력", "기민", "기력", "지모", "무력점수", "교차검증수", "검증상태",
  "증거해시", "수집배치", "기록자", "OCR신뢰도", "메모",
  "최대체력", "평타피해대표값", "평타표본수", "평타대상", "전투조건", "입력시각", "공격력",
]);
const INPUT_TIME_COLUMN_INDEX = EXPECTED_HEADERS.indexOf("입력시각");
const SOURCE_LABELS = Object.freeze({
  sheet: "시트",
  gamcom: "Gamcom",
  fmkorea: "에펨코리아",
  broadcast: "방송",
});
const STATUS_LABELS = Object.freeze({
  "cross-source": "교차검증",
  "broadcast-repeat": "방송교차검증",
  "gamcom-max": "기준값",
});

class SamgukGoogleSheetWriterError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SamgukGoogleSheetWriterError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new SamgukGoogleSheetWriterError(code, message);
}

function positiveInteger(value, fallback, maximum, label) {
  const parsed = Number.parseInt(value, 10);
  const candidate = Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
  if (candidate > maximum) fail("invalid_config", `${label} 상한을 확인하세요.`);
  return candidate;
}

function safeText(value, maximum, label) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) {
    fail("invalid_snapshot", `${label} 형식이 올바르지 않습니다.`);
  }
  const normalized = value.normalize("NFKC").trim();
  return /^\s*[=+\-@]/.test(normalized) ? `'${normalized}` : normalized;
}

function sheetSerial(value, label) {
  const timestamp = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(timestamp)) fail("invalid_snapshot", `${label} 시각이 올바르지 않습니다.`);
  return timestamp / 86_400_000 + SHEET_EPOCH_DAYS + KST_OFFSET_DAYS;
}

function allowedSourceUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return false;
    const host = url.hostname.toLowerCase();
    return ["docs.google.com", "gamcom-3kingdom.vercel.app", "fmkorea.com", "sooplive.com", "sooplive.co.kr"]
      .some(root => host === root || host.endsWith(`.${root}`));
  } catch {
    return false;
  }
}

function normalizeNumericField(field, value) {
  const maximum = NUMERIC_FIELD_MAXIMUMS[field];
  const isValidNumber = typeof value === "number" && Number.isFinite(value)
    && value >= 0 && value <= maximum;
  const isValidInteger = ["powerScore", "basicAttackDamage"].includes(field) || Number.isSafeInteger(value);
  if (!Number.isSafeInteger(maximum) || !isValidNumber || !isValidInteger) {
    fail("invalid_snapshot", `${field} 값이 올바르지 않습니다.`);
  }
  return Object.is(value, -0) ? 0 : value;
}

function normalizeSnapshot(snapshot, now = Date.now()) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    fail("invalid_snapshot", "승격할 snapshot이 필요합니다.");
  }
  const observationId = safeText(snapshot.observationId, 128, "observationId");
  if (!/^OBS-[A-Z0-9-]{8,120}$/.test(observationId)) fail("invalid_snapshot", "observationId 형식이 올바르지 않습니다.");
  const playerId = safeText(snapshot.playerId, 16, "playerId");
  if (!/^P\d{3}$/.test(playerId)) fail("invalid_snapshot", "playerId 형식이 올바르지 않습니다.");
  if (!Object.prototype.hasOwnProperty.call(STATUS_LABELS, snapshot.verification)) {
    fail("invalid_snapshot", "교차검증 상태가 올바르지 않습니다.");
  }
  if (!Array.isArray(snapshot.sourceTypes) || snapshot.sourceTypes.length < 1 || snapshot.sourceTypes.length > 4
      || snapshot.sourceTypes.some(value => !Object.prototype.hasOwnProperty.call(SOURCE_LABELS, value))) {
    fail("invalid_snapshot", "근거 출처가 올바르지 않습니다.");
  }
  const sourceTypes = new Set(snapshot.sourceTypes);
  if (sourceTypes.size !== snapshot.sourceTypes.length) {
    fail("invalid_snapshot", "중복 근거 출처는 사용할 수 없습니다.");
  }
  if (!Object.prototype.hasOwnProperty.call(SOURCE_LABELS, snapshot.primarySourceType)
      || !sourceTypes.has(snapshot.primarySourceType)) {
    fail("invalid_snapshot", "대표 근거 출처가 올바르지 않습니다.");
  }
  if (!Array.isArray(snapshot.sourceUrls) || snapshot.sourceUrls.length < 1 || snapshot.sourceUrls.length > 10
      || snapshot.sourceUrls.some(value => typeof value !== "string" || value.length > 2048 || !allowedSourceUrl(value))) {
    fail("invalid_snapshot", "근거 URL이 올바르지 않습니다.");
  }
  if (!Number.isSafeInteger(snapshot.sourceCount) || snapshot.sourceCount < 2 || snapshot.sourceCount > 10) {
    fail("invalid_snapshot", "교차검증 수가 올바르지 않습니다.");
  }
  if (snapshot.verification === "cross-source"
      && (sourceTypes.size < 2 || snapshot.sourceCount > sourceTypes.size)) {
    fail("invalid_snapshot", "교차검증 근거 수가 출처와 일치하지 않습니다.");
  }
  if (snapshot.verification === "broadcast-repeat"
      && (sourceTypes.size !== 1 || !sourceTypes.has("broadcast")
        || snapshot.primarySourceType !== "broadcast")) {
    fail("invalid_snapshot", "방송 반복검증은 방송 근거만 사용할 수 있습니다.");
  }
  if (snapshot.verification === "gamcom-max"
      && (sourceTypes.size !== 2 || !sourceTypes.has("sheet") || !sourceTypes.has("gamcom")
        || snapshot.primarySourceType !== "gamcom" || snapshot.sourceCount !== 2)) {
    fail("invalid_snapshot", "Gamcom 최고값 병합 근거가 올바르지 않습니다.");
  }
  if (!snapshot.fields || typeof snapshot.fields !== "object" || Array.isArray(snapshot.fields)
      || FIELD_NAMES.some(field => !Object.prototype.hasOwnProperty.call(snapshot.fields, field))) {
    fail("invalid_snapshot", `완전한 ${FIELD_NAMES.length}개 field snapshot이 필요합니다.`);
  }
  const fields = {};
  for (const field of FIELD_NAMES) {
    const value = snapshot.fields[field];
    if (value === null) {
      fields[field] = "";
    } else if (["horse", "basicAttackTarget", "combatConditions"].includes(field)) {
      const maximum = field === "horse" ? 80 : field === "basicAttackTarget" ? 120 : 240;
      fields[field] = safeText(value, maximum, field);
    } else {
      fields[field] = normalizeNumericField(field, value);
    }
  }
  const evidenceHash = safeText(snapshot.evidenceHash, 64, "evidenceHash").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(evidenceHash)) fail("invalid_snapshot", "evidenceHash 형식이 올바르지 않습니다.");
  const batchId = safeText(snapshot.batchId, 80, "batchId");
  const confidence = snapshot.ocrConfidence === null || snapshot.ocrConfidence === undefined
    ? ""
    : snapshot.ocrConfidence;
  if (confidence !== "" && (typeof confidence !== "number" || !Number.isFinite(confidence)
      || confidence < 0 || confidence > 1)) {
    fail("invalid_snapshot", "OCR confidence가 올바르지 않습니다.");
  }
  const observedAtMs = typeof snapshot.observedAt === "number"
    ? snapshot.observedAt
    : Date.parse(snapshot.observedAt);
  if (!Number.isFinite(observedAtMs) || observedAtMs < MIN_OBSERVED_AT_MS) {
    fail("invalid_snapshot", "observedAt 시각 범위를 확인하세요.");
  }
  const observedSerial = sheetSerial(observedAtMs, "observedAt");
  if (observedSerial > sheetSerial(now + 5 * 60_000, "현재")) {
    fail("invalid_snapshot", "미래 관측값은 쓸 수 없습니다.");
  }
  return Object.freeze({
    observationId,
    playerId,
    verification: snapshot.verification,
    sourceTypes: [...sourceTypes],
    sourceUrls: [...new Set(snapshot.sourceUrls)],
    sourceCount: snapshot.sourceCount,
    fields,
    evidenceHash,
    batchId,
    ocrConfidence: confidence,
    observedSerial,
    inputSerial: sheetSerial(now, "입력"),
    note: snapshot.note ? safeText(snapshot.note, 500, "note") : "자동 교차검증 승격",
  });
}

function snapshotRow(snapshot) {
  const record = {
    observation_id: snapshot.observationId,
    player_id: snapshot.playerId,
    "확인시각": snapshot.observedSerial,
    "근거종류": snapshot.sourceTypes.map(value => SOURCE_LABELS[value]).join("+"),
    "근거(URL/타임코드)": snapshot.sourceUrls.join("\n"),
    "교차검증수": snapshot.sourceCount,
    "검증상태": STATUS_LABELS[snapshot.verification],
    "증거해시": snapshot.evidenceHash,
    "수집배치": snapshot.batchId,
    "기록자": "samguk-promoter",
    "OCR신뢰도": snapshot.ocrConfidence === "" ? "" : Math.round(snapshot.ocrConfidence * 10_000) / 100,
    "메모": snapshot.note,
    "입력시각": snapshot.inputSerial,
  };
  for (const field of FIELD_NAMES) record[FIELD_HEADERS[field]] = snapshot.fields[field];
  return EXPECTED_HEADERS.map(header => record[header] ?? "");
}

function sameFileIdentity(left, right, { includeSize = false } = {}) {
  return left.dev === right.dev && left.ino === right.ino && left.uid === right.uid
    && left.mode === right.mode && (!includeSize || left.size === right.size);
}

function readPrivateTokenFile(filePath) {
  if (typeof filePath !== "string" || !path.isAbsolute(filePath)) {
    fail("invalid_config", "OAuth token은 절대 경로로 지정해야 합니다.");
  }
  let descriptor;
  try {
    const directoryPath = path.dirname(filePath);
    const directoryInitial = fs.lstatSync(directoryPath);
    if (!directoryInitial.isDirectory() || directoryInitial.isSymbolicLink()
        || (typeof process.getuid === "function" && directoryInitial.uid !== process.getuid())
        || (directoryInitial.mode & 0o777) !== 0o700) {
      fail("invalid_config", "OAuth token 디렉터리는 현재 사용자 소유의 0700 일반 디렉터리여야 합니다.");
    }
    const initial = fs.lstatSync(filePath);
    if (!initial.isFile() || initial.isSymbolicLink() || initial.size < 2 || initial.size > MAX_TOKEN_BYTES
        || (typeof process.getuid === "function" && initial.uid !== process.getuid())
        || (initial.mode & 0o777) !== 0o600) {
      fail("invalid_config", "OAuth token은 현재 사용자 소유의 0600 일반 파일이어야 합니다.");
    }
    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const openedBefore = fs.fstatSync(descriptor);
    if (!sameFileIdentity(initial, openedBefore, { includeSize: true })) {
      fail("invalid_config", "OAuth token 파일이 읽는 중 변경되었습니다.");
    }
    const buffer = Buffer.alloc(openedBefore.size);
    let offset = 0;
    while (offset < buffer.length) {
      const count = fs.readSync(descriptor, buffer, offset, buffer.length - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    const openedAfter = fs.fstatSync(descriptor);
    const final = fs.lstatSync(filePath);
    const directoryFinal = fs.lstatSync(directoryPath);
    if (offset !== buffer.length
        || !sameFileIdentity(openedBefore, openedAfter, { includeSize: true })
        || !sameFileIdentity(openedAfter, final, { includeSize: true })
        || !sameFileIdentity(directoryInitial, directoryFinal)) {
      fail("invalid_config", "OAuth token 파일이 읽는 중 변경되었습니다.");
    }
    const token = JSON.parse(buffer.subarray(0, offset).toString("utf8"));
    const keys = Object.keys(token || {}).sort();
    const expected = ["client_id", "client_secret", "refresh_token", "scope", "token_uri", "version"];
    if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])
        || token.version !== 1 || token.scope !== GOOGLE_SHEETS_SCOPE || token.token_uri !== GOOGLE_TOKEN_URI
        || typeof token.client_id !== "string" || !token.client_id.endsWith(".apps.googleusercontent.com")
        || typeof token.client_secret !== "string" || token.client_secret.length < 8 || token.client_secret.length > 512
        || typeof token.refresh_token !== "string" || token.refresh_token.length < 20 || token.refresh_token.length > 2048) {
      fail("invalid_config", "OAuth token 내용이 올바르지 않습니다.");
    }
    return Object.freeze({ ...token });
  } catch (error) {
    if (error instanceof SamgukGoogleSheetWriterError) throw error;
    fail("invalid_config", "OAuth token을 안전하게 읽지 못했습니다.");
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

async function readResponse(response, maxBytes) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    fail("response_too_large", "Google API 응답이 너무 큽니다.");
  }
  const chunks = [];
  let total = 0;
  if (response.body) {
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        fail("response_too_large", "Google API 응답이 너무 큽니다.");
      }
      chunks.push(Buffer.from(value));
    }
  }
  const buffer = Buffer.concat(chunks, total);
  try {
    return JSON.parse(buffer.toString("utf8"));
  } catch {
    fail("invalid_response", "Google API 응답이 JSON이 아닙니다.");
  }
}

function createSamgukGoogleSheetWriter(options = {}) {
  const tokenPath = options.tokenPath || process.env.SAMGUK_GOOGLE_OAUTH_TOKEN_PATH || "";
  const credentials = readPrivateTokenFile(tokenPath);
  const sheetId = String(options.sheetId || process.env.SAMGUK_SHEET_ID || "").trim();
  if (!/^[A-Za-z0-9_-]{20,128}$/.test(sheetId)) fail("invalid_config", "Google Sheet ID가 올바르지 않습니다.");
  const queuePath = String(options.queuePath || process.env.SAMGUK_OBSERVATION_QUEUE_PATH || "").trim();
  const lockPath = String(options.lockPath || process.env.SAMGUK_SHEET_WRITER_LOCK_PATH
    || (path.isAbsolute(queuePath) ? path.join(path.dirname(queuePath), ".sheet-writer.guard") : ""));
  if (!path.isAbsolute(lockPath)) fail("invalid_config", "Sheet writer lock 절대 경로가 필요합니다.");
  const fetchImpl = options.fetchImpl || ((...args) => fetch(...args));
  const acquireLock = options.acquireLock || acquireObservationQueueLock;
  const timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, 60_000, "timeout");
  const maxResponseBytes = positiveInteger(
    options.maxResponseBytes,
    DEFAULT_MAX_RESPONSE_BYTES,
    2 * 1024 * 1024,
    "response",
  );
  const now = options.now || Date.now;
  let accessToken = null;
  let accessTokenExpiresAt = 0;

  function retryableStatus(status) {
    return status === 429 || status >= 500;
  }

  async function waitBeforeRetry(attempt) {
    await new Promise(resolve => setTimeout(resolve, 250 * (2 ** attempt)));
  }

  async function request(url, init = {}, { authorized = true, retry = true } = {}) {
    const attempts = retry ? 3 : 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (authorized && (!accessToken || accessTokenExpiresAt <= now() + 60_000)) {
        const form = new URLSearchParams({
          client_id: credentials.client_id,
          client_secret: credentials.client_secret,
          refresh_token: credentials.refresh_token,
          grant_type: "refresh_token",
        });
        const tokenResponse = await request(GOOGLE_TOKEN_URI, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: form.toString(),
        }, { authorized: false, retry: false });
        if (!tokenResponse.ok || typeof tokenResponse.body.access_token !== "string") {
          const code = tokenResponse.body?.error === "invalid_grant" ? "oauth_invalid_grant" : "oauth_failed";
          fail(code, "Google OAuth token 갱신에 실패했습니다.");
        }
        accessToken = tokenResponse.body.access_token;
        const expiresIn = Number(tokenResponse.body.expires_in);
        accessTokenExpiresAt = now() + (Number.isFinite(expiresIn) ? expiresIn * 1000 : 3_600_000);
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response;
      let body;
      try {
        response = await fetchImpl(url, {
          ...init,
          headers: {
            ...(init.headers || {}),
            ...(authorized ? { Authorization: `Bearer ${accessToken}` } : {}),
          },
          signal: controller.signal,
        });
        body = await readResponse(response, maxResponseBytes);
      } catch (error) {
        const timedOut = error?.name === "AbortError";
        const invalidRetryableResponse = error instanceof SamgukGoogleSheetWriterError
          && error.code === "invalid_response" && retryableStatus(response?.status);
        const transientTransportError = !(error instanceof SamgukGoogleSheetWriterError);
        if (attempt + 1 < attempts
            && (timedOut || invalidRetryableResponse || transientTransportError)) {
          await waitBeforeRetry(attempt);
          continue;
        }
        if (timedOut) fail("upstream_timeout", "Google API 시간이 초과되었습니다.");
        throw error;
      } finally {
        clearTimeout(timer);
      }
      if (authorized && response.status === 401 && attempt === 0) {
        accessToken = null;
        accessTokenExpiresAt = 0;
        continue;
      }
      if (retryableStatus(response.status) && attempt + 1 < attempts) {
        await waitBeforeRetry(attempt);
        continue;
      }
      return { ok: response.ok, status: response.status, body };
    }
    fail("upstream_error", "Google API 요청에 실패했습니다.");
  }

  function apiUrl(suffix, query = null) {
    const base = `${GOOGLE_SHEETS_API_ROOT}/${encodeURIComponent(sheetId)}${suffix}`;
    return query ? `${base}?${query.toString()}` : base;
  }

  async function getRow(rowNumber, { valueRenderOption = "UNFORMATTED_VALUE" } = {}) {
    const range = `'${OBSERVATION_SHEET}'!A${rowNumber}:${OBSERVATION_LAST_COLUMN}${rowNumber}`;
    const query = new URLSearchParams({ valueRenderOption });
    if (valueRenderOption === "UNFORMATTED_VALUE") {
      query.set("dateTimeRenderOption", "SERIAL_NUMBER");
    }
    const result = await request(apiUrl(`/values/${encodeURIComponent(range)}`, query));
    if (!result.ok) fail("upstream_error", `Google Sheet 행 조회에 실패했습니다 (${result.status}).`);
    if (result.body.values !== undefined && !Array.isArray(result.body.values)) {
      fail("invalid_sheet", "Google Sheet 행 응답이 올바르지 않습니다.");
    }
    const row = result.body.values?.[0] || [];
    if (!Array.isArray(row) || row.length > EXPECTED_HEADERS.length) {
      fail("invalid_sheet", "Google Sheet 행 응답이 올바르지 않습니다.");
    }
    return row;
  }

  function rowIsEmpty(row) {
    return row.every(value => value === null || value === undefined
      || value === "");
  }

  function cellsEqual(left, right) {
    if ((left === undefined || left === null || left === "")
        && (right === undefined || right === null || right === "")) return true;
    if (typeof left === "number" && typeof right === "number") return Math.abs(left - right) < 1e-8;
    return String(left) === String(right);
  }

  function assertMatchingRow(actual, expected, { ignoreInputTime = false } = {}) {
    for (let index = 0; index < EXPECTED_HEADERS.length; index += 1) {
      if (ignoreInputTime && index === INPUT_TIME_COLUMN_INDEX) continue;
      if (!cellsEqual(actual[index], expected[index])) {
        fail("observation_id_conflict", "같은 observationId의 Sheet 내용이 다릅니다.");
      }
    }
  }

  async function appendSnapshotUnlocked(input) {
    const snapshot = normalizeSnapshot(input, now());
    const expectedRow = snapshotRow(snapshot);
    const metadataQuery = new URLSearchParams({ fields: "properties(timeZone)" });
    const metadata = await request(apiUrl("", metadataQuery));
    if (!metadata.ok || metadata.body?.properties?.timeZone !== "Asia/Seoul") {
      fail("invalid_sheet", "Google Sheet timezone은 Asia/Seoul이어야 합니다.");
    }

    const query = new URLSearchParams({
      majorDimension: "ROWS",
      valueRenderOption: "FORMULA",
    });
    query.append("ranges", `'${OBSERVATION_SHEET}'!A1:${OBSERVATION_LAST_COLUMN}1`);
    query.append("ranges", `'${OBSERVATION_SHEET}'!A2:${OBSERVATION_LAST_COLUMN}${MAX_OBSERVATION_ROW}`);
    query.append("ranges", `'${PARTICIPANT_SHEET}'!A2:A91`);
    const state = await request(apiUrl("/values:batchGet", query));
    if (!state.ok || !Array.isArray(state.body?.valueRanges) || state.body.valueRanges.length !== 3) {
      fail("invalid_sheet", "Google Sheet 구조를 읽지 못했습니다.");
    }
    const headers = state.body.valueRanges[0].values?.[0] || [];
    if (headers.length !== EXPECTED_HEADERS.length
        || headers.some((header, index) => header !== EXPECTED_HEADERS[index])) {
      fail("invalid_sheet", "관측입력 헤더가 예상 구조와 다릅니다.");
    }
    const roster = new Set((state.body.valueRanges[2].values || []).map(row => String(row[0] || "").trim()));
    if (!roster.has(snapshot.playerId)) fail("unknown_player", "참가자에 없는 playerId입니다.");

    const indexRows = state.body.valueRanges[1].values || [];
    if (!Array.isArray(indexRows)
        || indexRows.some(row => !Array.isArray(row) || row.length > EXPECTED_HEADERS.length)) {
      fail("invalid_sheet", "관측입력 행 구조가 올바르지 않습니다.");
    }
    let targetRow = null;
    for (let index = 0; index < MAX_OBSERVATION_ROW - 1; index += 1) {
      const row = indexRows[index] || [];
      if (String(row[0] || "") === snapshot.observationId) {
        const existing = await getRow(index + 2);
        assertMatchingRow(existing, expectedRow, { ignoreInputTime: true });
        return { ok: true, duplicate: true, appendedRow: index + 2 };
      }
      if (targetRow === null && rowIsEmpty(row)) targetRow = index + 2;
    }
    if (targetRow === null) fail("observation_sheet_full", "관측입력 5000행이 모두 사용 중입니다.");

    const range = `'${OBSERVATION_SHEET}'!A${targetRow}:${OBSERVATION_LAST_COLUMN}${targetRow}`;
    const rowBeforeWrite = await getRow(targetRow, { valueRenderOption: "FORMULA" });
    if (!rowIsEmpty(rowBeforeWrite)) {
      fail("target_row_conflict", "저장 직전 대상 행이 사용되어 쓰기를 중단했습니다.");
    }
    const updateQuery = new URLSearchParams({ valueInputOption: "RAW" });
    const update = await request(apiUrl(`/values/${encodeURIComponent(range)}`, updateQuery), {
      method: "PUT",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ range, majorDimension: "ROWS", values: [expectedRow] }),
    });
    if (!update.ok || update.body?.updatedRows !== 1) {
      fail("upstream_error", `Google Sheet 저장에 실패했습니다 (${update.status}).`);
    }
    const readback = await getRow(targetRow);
    assertMatchingRow(readback, expectedRow);
    return { ok: true, duplicate: false, appendedRow: targetRow };
  }

  async function appendSnapshot(snapshot) {
    const lock = acquireLock(lockPath);
    try {
      return await appendSnapshotUnlocked(snapshot);
    } finally {
      lock.release();
    }
  }

  async function appendSnapshotsUnlocked(inputs) {
    const snapshots = inputs.map(input => normalizeSnapshot(input, now()));
    const observationIds = new Set();
    for (const snapshot of snapshots) {
      if (observationIds.has(snapshot.observationId)) {
        fail("duplicate_observation_id", "batch 안에 중복 observationId가 있습니다.");
      }
      observationIds.add(snapshot.observationId);
    }

    const metadataQuery = new URLSearchParams({ fields: "properties(timeZone)" });
    const metadata = await request(apiUrl("", metadataQuery));
    if (!metadata.ok || metadata.body?.properties?.timeZone !== "Asia/Seoul") {
      fail("invalid_sheet", "Google Sheet timezone은 Asia/Seoul이어야 합니다.");
    }

    const stateQuery = new URLSearchParams({
      majorDimension: "ROWS",
      valueRenderOption: "FORMULA",
    });
    stateQuery.append("ranges", `'${OBSERVATION_SHEET}'!A1:${OBSERVATION_LAST_COLUMN}1`);
    stateQuery.append("ranges", `'${OBSERVATION_SHEET}'!A2:${OBSERVATION_LAST_COLUMN}${MAX_OBSERVATION_ROW}`);
    stateQuery.append("ranges", `'${PARTICIPANT_SHEET}'!A2:A91`);
    const state = await request(apiUrl("/values:batchGet", stateQuery));
    if (!state.ok || !Array.isArray(state.body?.valueRanges) || state.body.valueRanges.length !== 3) {
      fail("invalid_sheet", "Google Sheet 구조를 읽지 못했습니다.");
    }
    const headers = state.body.valueRanges[0].values?.[0] || [];
    if (headers.length !== EXPECTED_HEADERS.length
        || headers.some((header, index) => header !== EXPECTED_HEADERS[index])) {
      fail("invalid_sheet", "관측입력 헤더가 예상 구조와 다릅니다.");
    }
    const roster = new Set((state.body.valueRanges[2].values || []).map(row => String(row[0] || "").trim()));
    const indexRows = state.body.valueRanges[1].values || [];
    if (!Array.isArray(indexRows)
        || indexRows.some(row => !Array.isArray(row) || row.length > EXPECTED_HEADERS.length)) {
      fail("invalid_sheet", "관측입력 행 구조가 올바르지 않습니다.");
    }

    const existingById = new Map();
    const emptyRows = [];
    for (let index = 0; index < MAX_OBSERVATION_ROW - 1; index += 1) {
      const row = indexRows[index] || [];
      const observationId = String(row[0] || "");
      if (observationId && !existingById.has(observationId)) existingById.set(observationId, { row, rowNumber: index + 2 });
      if (rowIsEmpty(row)) emptyRows.push(index + 2);
    }

    const results = [];
    const writes = [];
    let emptyCursor = 0;
    for (const snapshot of snapshots) {
      if (!roster.has(snapshot.playerId)) fail("unknown_player", `참가자에 없는 playerId입니다: ${snapshot.playerId}`);
      const expectedRow = snapshotRow(snapshot);
      const existing = existingById.get(snapshot.observationId);
      if (existing) {
        assertMatchingRow(existing.row, expectedRow, { ignoreInputTime: true });
        results.push({ observationId: snapshot.observationId, duplicate: true, appendedRow: existing.rowNumber });
        continue;
      }
      if (emptyCursor >= emptyRows.length) fail("observation_sheet_full", "관측입력 5000행이 모두 사용 중입니다.");
      const rowNumber = emptyRows[emptyCursor];
      emptyCursor += 1;
      const range = `'${OBSERVATION_SHEET}'!A${rowNumber}:${OBSERVATION_LAST_COLUMN}${rowNumber}`;
      writes.push({ range, majorDimension: "ROWS", values: [expectedRow], rowNumber, expectedRow });
      results.push({ observationId: snapshot.observationId, duplicate: false, appendedRow: rowNumber });
    }

    if (writes.length > 0) {
      const prewriteQuery = new URLSearchParams({
        majorDimension: "ROWS",
        valueRenderOption: "FORMULA",
      });
      writes.forEach(item => prewriteQuery.append("ranges", item.range));
      const prewrite = await request(apiUrl("/values:batchGet", prewriteQuery));
      if (!prewrite.ok || !Array.isArray(prewrite.body?.valueRanges)
          || prewrite.body.valueRanges.length !== writes.length) {
        fail("upstream_error", "Google Sheet 일괄 저장 직전 상태를 확인하지 못했습니다.");
      }
      if (prewrite.body.valueRanges.some(valueRange => !rowIsEmpty(valueRange?.values?.[0] || []))) {
        fail("target_row_conflict", "Google Sheet 일괄 저장 대상 행이 먼저 사용되었습니다.");
      }

      const update = await request(apiUrl("/values:batchUpdate"), {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({
          valueInputOption: "RAW",
          data: writes.map(({ range, majorDimension, values }) => ({ range, majorDimension, values })),
        }),
      });
      if (!update.ok || update.body?.totalUpdatedRows !== writes.length
          || !Array.isArray(update.body?.responses) || update.body.responses.length !== writes.length
          || update.body.responses.some(item => item?.updatedRows !== 1)) {
        fail("upstream_error", `Google Sheet 일괄 저장에 실패했습니다 (${update.status}).`);
      }

      const readbackQuery = new URLSearchParams({
        majorDimension: "ROWS",
        valueRenderOption: "UNFORMATTED_VALUE",
        dateTimeRenderOption: "SERIAL_NUMBER",
      });
      writes.forEach(item => readbackQuery.append("ranges", item.range));
      const readback = await request(apiUrl("/values:batchGet", readbackQuery));
      if (!readback.ok || !Array.isArray(readback.body?.valueRanges)
          || readback.body.valueRanges.length !== writes.length) {
        fail("upstream_error", "Google Sheet 일괄 저장 검증에 실패했습니다.");
      }
      readback.body.valueRanges.forEach((valueRange, index) => {
        const row = valueRange?.values?.[0] || [];
        assertMatchingRow(row, writes[index].expectedRow);
      });
    }

    return {
      ok: true,
      results,
      appendedCount: writes.length,
      duplicateCount: results.length - writes.length,
    };
  }

  async function appendSnapshots(inputs) {
    if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > MAX_SNAPSHOT_BATCH) {
      fail("invalid_snapshot_batch", `snapshot batch는 1~${MAX_SNAPSHOT_BATCH}개여야 합니다.`);
    }
    const ids = new Set();
    for (const input of inputs) {
      const id = input && typeof input === "object" ? input.observationId : null;
      if (typeof id === "string" && ids.has(id)) {
        fail("duplicate_observation_id", "batch 안에 중복 observationId가 있습니다.");
      }
      if (typeof id === "string") ids.add(id);
    }
    const lock = acquireLock(lockPath);
    try {
      return await appendSnapshotsUnlocked(inputs);
    } finally {
      lock.release();
    }
  }

  return Object.freeze({ appendSnapshot, appendSnapshots });
}

module.exports = {
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_TIMEOUT_MS,
  EXPECTED_HEADERS,
  FIELD_HEADERS,
  GOOGLE_SHEETS_SCOPE,
  OBSERVATION_LAST_COLUMN,
  GOOGLE_TOKEN_URI,
  KST_OFFSET_DAYS,
  MAX_OBSERVATION_ROW,
  MAX_SNAPSHOT_BATCH,
  SamgukGoogleSheetWriterError,
  createSamgukGoogleSheetWriter,
  normalizeSnapshot,
  readPrivateTokenFile,
  sheetSerial,
  snapshotRow,
};
