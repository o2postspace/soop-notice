"use strict";

const fs = require("node:fs");
const path = require("node:path");
const FALLBACK = require("../data/samguk-fallback.json");
const {
  CURRENT_SEASON_ID,
  CURRENT_SEASON_START_AT,
  appendObservationQueue,
} = require("./samguk-observations");

const SEARCH_URL = "https://www.fmkorea.com/search.php?mid=afreecatv&sort_index=regdate&listStyle=webzine&search_keyword=%EA%B0%95&search_target=title_content";
const DEFAULT_MIN_INTERVAL_MS = 5 * 60_000;
const DEFAULT_HTTP_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_DETAIL_FETCHES = 6;
const DEFAULT_MAX_POST_AGE_MS = 48 * 60 * 60_000;
const MIN_RATE_LIMIT_BACKOFF_MS = 10 * 60_000;
const MAX_RATE_LIMIT_BACKOFF_MS = 60 * 60_000;
const STATE_MAX_BYTES = 256 * 1024;
const STATE_MAX_DOCUMENTS = 1_000;
const STATE_RETENTION_MS = 14 * 24 * 60 * 60_000;
const MAX_ALIAS_FILE_BYTES = 32 * 1024;
const MAX_ALIAS_COUNT_PER_PLAYER = 20;
const MAX_ALIAS_LENGTH = 40;
const MAX_TEXT_LINE_LENGTH = 500;
const MAX_PLAYER_SEGMENT_LENGTH = 160;
const MAX_EQUIPMENT_SEGMENT_LENGTH = 48;
const MAX_REDIRECTS = 3;
const FMKOREA_HOSTS = new Set(["fmkorea.com", "www.fmkorea.com", "m.fmkorea.com"]);
const USER_AGENT = "Mozilla/5.0 (compatible; SOOPNOTICE-FMK-monitor/1.0; +https://soopnotice.com)";

const EQUIPMENT_TERMS = Object.freeze([
  ["helmet", Object.freeze(["두갑", "투구", "머리방어구", "헬멧"])],
  ["armor", Object.freeze(["갑빠", "갑바", "흉갑", "갑옷", "상의방어구"])],
  ["shoes", Object.freeze(["각갑", "신발", "장화", "하의방어구"])],
  ["weapon", Object.freeze(["무기"])],
]);
const EQUIPMENT_LOOKUP = new Map(
  EQUIPMENT_TERMS.flatMap(([field, terms]) => terms.map(term => [term, field])),
);
const EQUIPMENT_MATCHER = new RegExp(
  [...EQUIPMENT_LOOKUP.keys()].sort((left, right) => right.length - left.length)
    .map(escapeRegExp).join("|"),
  "gu",
);
const LEVEL_MATCHER = /([0-9]{1,2})\s*강(?:화)?/gu;
const NEGATIVE_CONTEXT = /(?:실패|터짐|깨짐|하락|복구|도전|시도|확률|예정|가즈아|가자|간다|누를|눌러|갈까|할까|인가|이면|되면|가면|일까|맞나|맞아|아님|아닌가|못\s*(?:갔|간|감|찍|올렸|했)|성공\s*했나|됐나|됬나|된\s*건가|갔나|찍었나|했나|\?)/u;
const WORD_CHARACTER = /[\p{L}\p{N}_]/u;
const KOREAN_CHARACTER = /^[가-힣]+$/u;
const NAME_PARTICLES = Object.freeze(["에게", "한테", "으로", "로", "이", "가", "은", "는", "의", "도", "만"]);

class SamgukFmkoreaMonitorError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "SamgukFmkoreaMonitorError";
    this.code = code;
    this.retryAfterMs = Number.isFinite(details.retryAfterMs) && details.retryAfterMs >= 0
      ? details.retryAfterMs
      : null;
  }
}

function fail(code, message, details) {
  throw new SamgukFmkoreaMonitorError(code, message, details);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizedText(value) {
  return String(value ?? "").normalize("NFKC").trim();
}

function normalizeAlias(value, label) {
  const alias = normalizedText(value);
  if (!alias || alias.length > MAX_ALIAS_LENGTH || /[\u0000-\u001f\u007f]/u.test(alias)) {
    fail("invalid_alias", `${label} 형식이 올바르지 않습니다.`);
  }
  return alias;
}

function buildRosterAliasIndex(members = FALLBACK.members, { aliasesByPlayer = {} } = {}) {
  if (!Array.isArray(members) || members.length === 0 || members.length > 90) {
    fail("invalid_roster", "삼국지 roster가 1~90명의 배열이어야 합니다.");
  }
  if (!isPlainObject(aliasesByPlayer)) fail("invalid_alias", "aliases는 객체여야 합니다.");

  const players = members.map((member, index) => {
    const playerId = `P${String(index + 1).padStart(3, "0")}`;
    const name = normalizeAlias(member?.name, `${playerId}.name`);
    const soopId = normalizeAlias(member?.soopId, `${playerId}.soopId`);
    return Object.freeze({ playerId, name, soopId });
  });
  const playerByKey = new Map();
  for (const player of players) {
    for (const key of [player.playerId, player.name, player.soopId]) {
      if (playerByKey.has(key.toLocaleLowerCase("ko-KR"))) {
        fail("invalid_roster", `roster 식별자가 중복되었습니다: ${key}`);
      }
      playerByKey.set(key.toLocaleLowerCase("ko-KR"), player);
    }
  }

  const aliases = new Map();
  const addAlias = (alias, player) => {
    const normalized = normalizeAlias(alias, `${player.playerId}.alias`);
    const key = normalized.toLocaleLowerCase("ko-KR");
    if (!aliases.has(key)) aliases.set(key, new Map());
    aliases.get(key).set(player.playerId, { alias: normalized, playerId: player.playerId });
  };
  players.forEach(player => {
    addAlias(player.name, player);
    addAlias(player.soopId, player);
  });

  for (const [target, values] of Object.entries(aliasesByPlayer)) {
    const player = playerByKey.get(normalizedText(target).toLocaleLowerCase("ko-KR"));
    if (!player) fail("invalid_alias", `aliases 대상이 roster에 없습니다: ${target}`);
    if (!Array.isArray(values) || values.length > MAX_ALIAS_COUNT_PER_PLAYER) {
      fail("invalid_alias", `${target} aliases는 최대 ${MAX_ALIAS_COUNT_PER_PLAYER}개의 배열이어야 합니다.`);
    }
    values.forEach(alias => addAlias(alias, player));
  }

  // 둘 이상의 참가자를 가리키는 별칭은 오탐을 막기 위해 전부 제외한다.
  const entries = [...aliases.values()]
    .filter(targets => targets.size === 1)
    .map(targets => [...targets.values()][0])
    .sort((left, right) => right.alias.length - left.alias.length || left.alias.localeCompare(right.alias));
  return Object.freeze({
    players: Object.freeze(players),
    entries: Object.freeze(entries.map(Object.freeze)),
  });
}

function aliasOccurrenceAt(text, lowerText, entry, start) {
  const alias = entry.alias;
  const before = start > 0 ? text[start - 1] : "";
  if (before && WORD_CHARACTER.test(before)) return null;

  let end = start + alias.length;
  const after = text[end] || "";
  if (!after || !WORD_CHARACTER.test(after)) return { start, end, ...entry };

  // 조사 없이 단어 중간에 걸린 별칭은 제외한다. 한 글자 별칭은 "썩은" 같은
  // 일반 단어 오탐이 커서 조사 결합도 허용하지 않는다.
  if (!KOREAN_CHARACTER.test(alias) || alias.length < 2) return null;
  const suffix = lowerText.slice(end);
  const particle = NAME_PARTICLES.find(candidate => suffix.startsWith(candidate));
  if (!particle) return null;
  end += particle.length;
  const afterParticle = text[end] || "";
  return afterParticle && WORD_CHARACTER.test(afterParticle) ? null : { start, end, ...entry };
}

function findAliasOccurrences(text, aliasIndex) {
  const lowerText = text.toLocaleLowerCase("ko-KR");
  const found = [];
  for (const entry of aliasIndex.entries) {
    const needle = entry.alias.toLocaleLowerCase("ko-KR");
    let offset = 0;
    while (offset <= lowerText.length - needle.length) {
      const start = lowerText.indexOf(needle, offset);
      if (start < 0) break;
      const occurrence = aliasOccurrenceAt(text, lowerText, entry, start);
      if (occurrence) found.push(occurrence);
      offset = start + Math.max(1, needle.length);
    }
  }
  found.sort((left, right) => left.start - right.start || right.end - left.end);
  return found.filter((item, index) => !found.slice(0, index).some(prior => (
    prior.start === item.start && prior.end >= item.end && prior.playerId === item.playerId
  )));
}

function containsRosterAlias(text, aliasIndex) {
  return findAliasOccurrences(normalizedText(text), aliasIndex).length > 0;
}

function validEnhancementLevels(segment, equipmentEnd) {
  const levels = [];
  LEVEL_MATCHER.lastIndex = 0;
  for (const match of segment.matchAll(LEVEL_MATCHER)) {
    const value = Number(match[1]);
    if (!Number.isInteger(value) || value < 0 || value > 15) continue;
    const contextStart = Math.max(equipmentEnd, match.index - 12);
    const contextEnd = Math.min(segment.length, match.index + match[0].length + 14);
    if (NEGATIVE_CONTEXT.test(segment.slice(contextStart, contextEnd))) continue;
    levels.push(value);
  }
  return levels;
}

function extractGearClaims(text, aliasIndex) {
  const normalized = String(text ?? "").normalize("NFKC")
    .replace(/\r\n?/g, "\n")
    .slice(0, 100_000);
  const claims = new Map();
  const lines = normalized.split(/\n+/u).map(line => line.trim()).filter(Boolean);

  for (const originalLine of lines) {
    const line = originalLine.slice(0, MAX_TEXT_LINE_LENGTH);
    const players = findAliasOccurrences(line, aliasIndex);
    for (let playerIndex = 0; playerIndex < players.length; playerIndex += 1) {
      const player = players[playerIndex];
      const nextPlayerStart = players[playerIndex + 1]?.start ?? line.length;
      const segmentEnd = Math.min(nextPlayerStart, player.end + MAX_PLAYER_SEGMENT_LENGTH);
      const segment = line.slice(player.end, segmentEnd);
      const equipment = [];
      EQUIPMENT_MATCHER.lastIndex = 0;
      for (const match of segment.matchAll(EQUIPMENT_MATCHER)) {
        equipment.push({
          field: EQUIPMENT_LOOKUP.get(match[0]),
          term: match[0],
          start: match.index,
          end: match.index + match[0].length,
        });
      }
      for (let equipmentIndex = 0; equipmentIndex < equipment.length; equipmentIndex += 1) {
        const item = equipment[equipmentIndex];
        const nextEquipmentStart = equipment[equipmentIndex + 1]?.start ?? segment.length;
        const itemEnd = Math.min(nextEquipmentStart, item.end + MAX_EQUIPMENT_SEGMENT_LENGTH);
        const itemSegment = segment.slice(item.start, itemEnd);
        const levels = validEnhancementLevels(itemSegment, item.term.length);
        if (levels.length === 0) continue;
        const value = Math.max(...levels);
        const key = `${player.playerId}\u0000${item.field}`;
        const prior = claims.get(key);
        if (!prior || value > prior.value) {
          claims.set(key, {
            playerId: player.playerId,
            field: item.field,
            value,
            matchedAlias: player.alias,
            equipmentTerm: item.term,
          });
        }
      }
    }
  }

  return [...claims.values()].sort((left, right) => (
    left.playerId.localeCompare(right.playerId) || left.field.localeCompare(right.field)
  ));
}

function decodeHtmlEntities(value) {
  const named = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " };
  return String(value ?? "").replace(/&(#(?:x[0-9a-f]+|[0-9]+)|[a-z]+);/gi, (whole, entity) => {
    if (entity[0] !== "#") return named[entity.toLowerCase()] ?? whole;
    const hexadecimal = entity[1]?.toLowerCase() === "x";
    const number = Number.parseInt(entity.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
    if (!Number.isInteger(number) || number < 0 || number > 0x10ffff) return "";
    try {
      return String.fromCodePoint(number);
    } catch {
      return "";
    }
  });
}

function htmlToText(value) {
  return decodeHtmlEntities(String(value ?? "")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(?:br|\/p|\/div|\/li|\/tr|\/h[1-6])\b[^>]*>/gi, "\n")
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]*>/g, " "))
    .replace(/[\t\f\v ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .trim();
}

function parseFmkoreaSearchHtml(html) {
  if (typeof html !== "string" || html.length === 0) fail("invalid_search_html", "FMK 검색 HTML이 비어 있습니다.");
  const posts = new Map();
  const itemMatcher = /<li\b[^>]*class=["'][^"']*\bli\b[^"']*["'][^>]*>([\s\S]*?)<\/li>/gi;
  for (const itemMatch of html.matchAll(itemMatcher)) {
    const item = itemMatch[1];
    const idMatch = /(?:document_srl=|href=["']\/)([0-9]{6,20})(?:[&"'\/?#]|$)/i.exec(item);
    const titleMatch = /<span\b[^>]*class=["'][^"']*\bellipsis-target\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i.exec(item);
    if (!idMatch || !titleMatch) continue;
    const documentId = idMatch[1];
    if (posts.has(documentId)) continue;
    const title = htmlToText(titleMatch[1]);
    if (!title) continue;
    posts.set(documentId, Object.freeze({
      documentId,
      title: title.slice(0, 300),
      sourceUrl: `https://www.fmkorea.com/${documentId}`,
    }));
  }
  return [...posts.values()];
}

function timestampFromRegdate(value) {
  const match = /^(20[0-9]{2})([01][0-9])([0-3][0-9])([0-2][0-9])([0-5][0-9])([0-5][0-9])$/.exec(value || "");
  if (!match) fail("invalid_post_html", "FMK 게시물 작성시각을 확인할 수 없습니다.");
  const [, year, month, day, hour, minute, second] = match;
  const iso = `${year}-${month}-${day}T${hour}:${minute}:${second}+09:00`;
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp)) fail("invalid_post_html", "FMK 게시물 작성시각이 올바르지 않습니다.");
  return new Date(timestamp).toISOString();
}

function parseFmkoreaPostHtml(html, expectedDocumentId) {
  if (typeof html !== "string" || html.length === 0) fail("invalid_post_html", "FMK 게시물 HTML이 비어 있습니다.");
  const documentMatch = /window\.current_document_srl\s*=\s*parseInt\(['"]([0-9]{6,20})['"]\)/i.exec(html);
  if (!documentMatch || documentMatch[1] !== String(expectedDocumentId)) {
    fail("invalid_post_html", "FMK 게시물 문서번호가 일치하지 않습니다.");
  }
  const titleMatch = /<meta\b[^>]*property=["']og:title["'][^>]*content=["']([\s\S]*?)["'][^>]*>/i.exec(html)
    || /<meta\b[^>]*content=["']([\s\S]*?)["'][^>]*property=["']og:title["'][^>]*>/i.exec(html);
  const regdateMatch = /window\.document_regdate\s*=\s*([0-9]{14})\s*;/i.exec(html);
  const bodyMatch = new RegExp(
    `<!--BeforeDocument\\(${escapeRegExp(String(expectedDocumentId))},[^)]*\\)-->([\\s\\S]*?)<!--AfterDocument\\(${escapeRegExp(String(expectedDocumentId))},[^)]*\\)-->`,
    "i",
  ).exec(html);
  if (!titleMatch || !regdateMatch || !bodyMatch) {
    fail("invalid_post_html", "FMK 게시물 제목·본문·작성시각을 모두 확인할 수 없습니다.");
  }
  const title = htmlToText(titleMatch[1]);
  const body = htmlToText(bodyMatch[1]);
  if (!title) fail("invalid_post_html", "FMK 게시물 제목이 비어 있습니다.");
  return Object.freeze({
    documentId: documentMatch[1],
    title: title.slice(0, 300),
    body: body.slice(0, 100_000),
    observedAt: timestampFromRegdate(regdateMatch[1]),
    sourceUrl: `https://www.fmkorea.com/${documentMatch[1]}`,
  });
}

function candidatePriority(post, aliasIndex) {
  if (extractGearClaims(post.title, aliasIndex).length > 0) return 0;
  if (containsRosterAlias(post.title, aliasIndex)) return 1;
  EQUIPMENT_MATCHER.lastIndex = 0;
  LEVEL_MATCHER.lastIndex = 0;
  if (EQUIPMENT_MATCHER.test(post.title) && LEVEL_MATCHER.test(post.title)) return 2;
  return null;
}

function normalizePath(value, label) {
  if (typeof value !== "string" || !value.trim() || value.includes("\u0000")) fail("invalid_path", `${label} 경로가 필요합니다.`);
  return path.resolve(value);
}

function loadAliasesByPlayerFile(filePath) {
  if (filePath === undefined || filePath === null || String(filePath).trim() === "") return {};
  const resolved = normalizePath(filePath, "aliases");
  const stat = assertRegularOrMissing(resolved, "aliases");
  if (!stat || stat.size > MAX_ALIAS_FILE_BYTES) {
    fail("invalid_alias", "aliases는 32KiB 이하의 일반 JSON 파일이어야 합니다.");
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(resolved, "utf8"));
  } catch {
    fail("invalid_alias", "aliases JSON을 읽을 수 없습니다.");
  }
  if (!isPlainObject(parsed)) fail("invalid_alias", "aliases JSON은 객체여야 합니다.");
  return parsed;
}

function assertRegularOrMissing(filePath, label) {
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) fail("invalid_path", `${label}은 일반 파일이어야 합니다.`);
    return stat;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function emptyState() {
  return {
    version: 2,
    lastRunAt: null,
    nextRunAt: null,
    rateLimitCount: 0,
    documents: {},
  };
}

function normalizedStateTimestamp(value, label, { nullable = true } = {}) {
  if (nullable && (value === null || value === undefined || value === "")) return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) fail("invalid_state", `${label} 시각이 올바르지 않습니다.`);
  return new Date(timestamp).toISOString();
}

function loadMonitorState(filePath) {
  const resolved = normalizePath(filePath, "state");
  const stat = assertRegularOrMissing(resolved, "state");
  if (!stat) return emptyState();
  if (stat.size > STATE_MAX_BYTES) fail("invalid_state", "FMK monitor state가 너무 큽니다.");
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(resolved, "utf8"));
  } catch {
    fail("invalid_state", "FMK monitor state JSON을 읽을 수 없습니다.");
  }
  if (!isPlainObject(parsed) || ![1, 2].includes(parsed.version)
    || !isPlainObject(parsed.documents)) {
    fail("invalid_state", "FMK monitor state 형식이 올바르지 않습니다.");
  }
  const lastRunAt = normalizedStateTimestamp(parsed.lastRunAt, "lastRunAt");
  const nextRunAt = parsed.version === 1
    ? null
    : normalizedStateTimestamp(parsed.nextRunAt, "nextRunAt");
  const rateLimitCount = parsed.version === 1 ? 0 : parsed.rateLimitCount;
  if (!Number.isSafeInteger(rateLimitCount) || rateLimitCount < 0 || rateLimitCount > 31) {
    fail("invalid_state", "rateLimitCount 형식이 올바르지 않습니다.");
  }
  const documents = {};
  for (const [documentId, record] of Object.entries(parsed.documents)) {
    if (!/^[0-9]{6,20}$/.test(documentId) || !isPlainObject(record)
      || !["queued", "no-match", "too-old"].includes(record.status)
      || !Number.isFinite(Date.parse(record.processedAt))) {
      fail("invalid_state", "FMK monitor document cache 형식이 올바르지 않습니다.");
    }
    documents[documentId] = { status: record.status, processedAt: new Date(record.processedAt).toISOString() };
  }
  // v1은 읽는 즉시 v2 메모리 계약으로 올리고 다음 원자 저장 때 마이그레이션한다.
  return { version: 2, lastRunAt, nextRunAt, rateLimitCount, documents };
}

function prunedState(state, now) {
  const cutoff = now - STATE_RETENTION_MS;
  const entries = Object.entries(state.documents)
    .filter(([, record]) => Date.parse(record.processedAt) >= cutoff)
    .sort((left, right) => Date.parse(right[1].processedAt) - Date.parse(left[1].processedAt))
    .slice(0, STATE_MAX_DOCUMENTS);
  return {
    version: 2,
    lastRunAt: state.lastRunAt,
    nextRunAt: state.nextRunAt,
    rateLimitCount: state.rateLimitCount,
    documents: Object.fromEntries(entries),
  };
}

function calculateRateLimitBackoffMs(rateLimitCount, retryAfterMs = null) {
  const count = Math.max(1, Math.min(31, Number(rateLimitCount) || 1));
  const exponential = Math.min(
    MAX_RATE_LIMIT_BACKOFF_MS,
    MIN_RATE_LIMIT_BACKOFF_MS * (2 ** Math.min(6, count - 1)),
  );
  const requested = Number.isFinite(retryAfterMs) && retryAfterMs >= 0 ? retryAfterMs : 0;
  return Math.min(MAX_RATE_LIMIT_BACKOFF_MS, Math.max(MIN_RATE_LIMIT_BACKOFF_MS, exponential, requested));
}

function applyRateLimitState(state, error, now) {
  state.lastRunAt = new Date(now).toISOString();
  state.rateLimitCount = Math.min(31, (state.rateLimitCount || 0) + 1);
  const delayMs = calculateRateLimitBackoffMs(state.rateLimitCount, error?.retryAfterMs);
  state.nextRunAt = new Date(now + delayMs).toISOString();
  return delayMs;
}

function saveMonitorState(filePath, input, now = Date.now()) {
  const resolved = normalizePath(filePath, "state");
  assertRegularOrMissing(resolved, "state");
  const directory = path.dirname(resolved);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const directoryStat = fs.lstatSync(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) fail("invalid_path", "state 상위 경로가 안전하지 않습니다.");
  const state = prunedState(input, now);
  const payload = Buffer.from(`${JSON.stringify(state)}\n`, "utf8");
  if (payload.length > STATE_MAX_BYTES) fail("invalid_state", "FMK monitor state가 너무 큽니다.");
  const temporaryPath = `${resolved}.tmp-${process.pid}-${process.hrtime.bigint()}`;
  let descriptor = null;
  try {
    descriptor = fs.openSync(temporaryPath, "wx", 0o600);
    fs.writeFileSync(descriptor, payload);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    assertRegularOrMissing(resolved, "state");
    fs.renameSync(temporaryPath, resolved);
    fs.chmodSync(resolved, 0o600);
  } finally {
    if (descriptor !== null) {
      try { fs.closeSync(descriptor); } catch {}
    }
    try { fs.unlinkSync(temporaryPath); } catch {}
  }
  return state;
}

function validateFmkoreaUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail("unsafe_response_url", "FMK 응답 URL이 올바르지 않습니다.");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port
    || !FMKOREA_HOSTS.has(parsed.hostname.toLowerCase())) {
    fail("unsafe_response_url", "FMK 응답이 허용되지 않은 URL로 이동했습니다.");
  }
}

function parseRetryAfter(value, now = Date.now()) {
  const normalized = String(value ?? "").trim();
  if (!normalized) return null;
  if (/^[0-9]{1,10}$/.test(normalized)) {
    const seconds = Number(normalized);
    return Number.isSafeInteger(seconds) ? seconds * 1_000 : null;
  }
  const retryAt = Date.parse(normalized);
  if (!Number.isFinite(retryAt)) return null;
  return Math.max(0, retryAt - now);
}

async function readResponseLimited(response, maximumBytes) {
  const length = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(length) && length > maximumBytes) fail("response_too_large", "FMK 응답이 너무 큽니다.");
  if (!response.body || typeof response.body.getReader !== "function") {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maximumBytes) fail("response_too_large", "FMK 응답이 너무 큽니다.");
    return buffer.toString("utf8");
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) fail("response_too_large", "FMK 응답이 너무 큽니다.");
      chunks.push(Buffer.from(value));
    }
  } finally {
    if (total > maximumBytes) {
      try { await reader.cancel(); } catch {}
    }
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

async function fetchFmkoreaHtml(url, {
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_HTTP_TIMEOUT_MS,
  maximumBytes = DEFAULT_MAX_RESPONSE_BYTES,
  now = Date.now(),
} = {}) {
  if (typeof fetchImpl !== "function") fail("fetch_unavailable", "fetch 구현이 없습니다.");
  validateFmkoreaUrl(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let currentUrl = url;
    let response;
    for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
      response = await fetchImpl(currentUrl, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          Accept: "text/html,application/xhtml+xml",
          "Accept-Language": "ko-KR,ko;q=0.9",
          "Cache-Control": "no-cache",
          "User-Agent": USER_AGENT,
        },
      });
      validateFmkoreaUrl(response.url || currentUrl);
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      if (redirectCount === MAX_REDIRECTS) fail("too_many_redirects", "FMK redirect 횟수를 초과했습니다.");
      const location = response.headers?.get?.("location");
      if (!location) fail("invalid_redirect", "FMK redirect 위치가 없습니다.");
      const nextUrl = new URL(location, currentUrl).toString();
      validateFmkoreaUrl(nextUrl);
      try { await response.body?.cancel?.(); } catch {}
      currentUrl = nextUrl;
    }
    if ([429, 430].includes(response.status)) {
      const retryAfterMs = parseRetryAfter(response.headers?.get?.("retry-after"), now);
      try { await response.body?.cancel?.(); } catch {}
      fail(
        "upstream_rate_limited",
        "FMK 요청 제한에 걸려 backoff 뒤 다시 시도합니다.",
        { retryAfterMs },
      );
    }
    if (!response.ok) fail("upstream_http", `FMK 응답 상태가 ${response.status}입니다.`);
    const contentType = String(response.headers?.get?.("content-type") || "").toLowerCase();
    if (!contentType.includes("text/html")) fail("invalid_content_type", "FMK 응답이 HTML이 아닙니다.");
    return await readResponseLimited(response, maximumBytes);
  } catch (error) {
    if (error instanceof SamgukFmkoreaMonitorError) throw error;
    if (error?.name === "AbortError") fail("upstream_timeout", "FMK 요청 시간이 초과되었습니다.");
    fail("upstream_error", "FMK 요청에 실패했습니다.");
  } finally {
    clearTimeout(timer);
  }
}

function integerOption(value, fallback, minimum, maximum, label) {
  const candidate = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(candidate) || candidate < minimum || candidate > maximum) {
    fail("invalid_config", `${label}은 ${minimum}~${maximum} 범위의 정수여야 합니다.`);
  }
  return candidate;
}

function normalizeSeasonStartAt(value = CURRENT_SEASON_START_AT) {
  if (value !== undefined && value !== null && typeof value !== "string") {
    fail("invalid_config", "seasonStartAt은 밀리초 단위 UTC ISO 시각이어야 합니다.");
  }
  const normalized = String(value ?? "").trim() || CURRENT_SEASON_START_AT;
  const timestamp = Date.parse(normalized);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(normalized)
    || !Number.isFinite(timestamp)
    || new Date(timestamp).toISOString() !== normalized) {
    fail("invalid_config", "seasonStartAt은 밀리초 단위 UTC ISO 시각이어야 합니다.");
  }
  return normalized;
}

async function runFmkoreaGearMonitor(options = {}) {
  const now = options.now === undefined ? Date.now() : Number(options.now);
  if (!Number.isFinite(now) || now <= 0) fail("invalid_config", "현재 시각이 올바르지 않습니다.");
  const seasonStartAt = normalizeSeasonStartAt(options.seasonStartAt);
  const seasonStartAtMs = Date.parse(seasonStartAt);
  const queuePath = normalizePath(options.queuePath, "queue");
  const statePath = normalizePath(options.statePath || path.join(path.dirname(queuePath), "fmkorea-gear-monitor-state.json"), "state");
  if (queuePath === statePath) fail("invalid_path", "queue와 state 경로는 달라야 합니다.");
  const minIntervalMs = integerOption(options.minIntervalMs, DEFAULT_MIN_INTERVAL_MS, 5 * 60_000, 60 * 60_000, "minIntervalMs");
  const httpTimeoutMs = integerOption(options.httpTimeoutMs, DEFAULT_HTTP_TIMEOUT_MS, 1_000, 30_000, "httpTimeoutMs");
  const maximumBytes = integerOption(options.maximumBytes, DEFAULT_MAX_RESPONSE_BYTES, 64 * 1024, 4 * 1024 * 1024, "maximumBytes");
  const maxDetailFetches = integerOption(options.maxDetailFetches, DEFAULT_MAX_DETAIL_FETCHES, 1, 10, "maxDetailFetches");
  const maxPostAgeMs = integerOption(options.maxPostAgeMs, DEFAULT_MAX_POST_AGE_MS, 60 * 60_000, 7 * 24 * 60 * 60_000, "maxPostAgeMs");
  const state = loadMonitorState(statePath);
  if (state.nextRunAt && now + 1_000 < Date.parse(state.nextRunAt)) {
    return {
      skipped: true,
      reason: "rate-limit",
      searched: 0,
      candidates: 0,
      fetched: 0,
      observations: 0,
      inserted: 0,
      duplicates: 0,
      errors: [],
    };
  }
  if (!options.force && state.lastRunAt
    && now + 1_000 < Date.parse(state.lastRunAt) + minIntervalMs) {
    return {
      skipped: true,
      reason: "interval",
      searched: 0,
      candidates: 0,
      fetched: 0,
      observations: 0,
      inserted: 0,
      duplicates: 0,
      errors: [],
    };
  }

  const aliasIndex = options.aliasIndex || buildRosterAliasIndex(options.members || FALLBACK.members, {
    aliasesByPlayer: options.aliasesByPlayer || {},
  });
  const fetchOptions = {
    fetchImpl: options.fetchImpl,
    timeoutMs: httpTimeoutMs,
    maximumBytes,
    now,
  };
  let searchHtml;
  try {
    searchHtml = await fetchFmkoreaHtml(SEARCH_URL, fetchOptions);
  } catch (error) {
    if (error?.code === "upstream_rate_limited") applyRateLimitState(state, error, now);
    else state.lastRunAt = new Date(now).toISOString();
    saveMonitorState(statePath, state, now);
    throw error;
  }
  const posts = parseFmkoreaSearchHtml(searchHtml);
  const candidates = posts.map(post => ({ post, priority: candidatePriority(post, aliasIndex) }))
    .filter(candidate => candidate.priority !== null && !state.documents[candidate.post.documentId])
    .sort((left, right) => left.priority - right.priority)
    .slice(0, maxDetailFetches);

  const observations = [];
  const handled = [];
  const errors = [];
  let detailRateLimited = false;
  for (const candidate of candidates) {
    const { documentId, sourceUrl } = candidate.post;
    let detail;
    try {
      const detailHtml = await fetchFmkoreaHtml(sourceUrl, fetchOptions);
      detail = parseFmkoreaPostHtml(detailHtml, documentId);
    } catch (error) {
      errors.push({ documentId, code: error?.code || "detail_error" });
      if (error?.code === "upstream_rate_limited") {
        applyRateLimitState(state, error, now);
        saveMonitorState(statePath, state, now);
        detailRateLimited = true;
        break;
      }
      continue;
    }
    const observedAtMs = Date.parse(detail.observedAt);
    if (observedAtMs < seasonStartAtMs) continue;
    if (observedAtMs < now - maxPostAgeMs || observedAtMs > now + 5 * 60_000) {
      handled.push({ documentId, status: "too-old" });
      continue;
    }
    const claims = new Map();
    for (const claim of [
      ...extractGearClaims(detail.title, aliasIndex),
      ...extractGearClaims(detail.body, aliasIndex),
    ]) {
      const key = `${claim.playerId}\u0000${claim.field}`;
      const prior = claims.get(key);
      if (!prior || claim.value > prior.value) claims.set(key, claim);
    }
    for (const claim of claims.values()) {
      observations.push({
        seasonId: CURRENT_SEASON_ID,
        playerId: claim.playerId,
        field: claim.field,
        value: claim.value,
        sourceType: "fmkorea",
        sourceId: `fmkorea:${documentId}:${claim.playerId}:${claim.field}`,
        sourceUrl: detail.sourceUrl,
        observedAt: detail.observedAt,
        collectedAt: new Date(now).toISOString(),
      });
    }
    handled.push({ documentId, status: claims.size > 0 ? "queued" : "no-match" });
  }

  const appendFn = options.appendFn || appendObservationQueue;
  const appendResult = observations.length > 0
    ? appendFn(queuePath, observations)
    : { inserted: [], duplicates: [] };
  const processedAt = new Date(now).toISOString();
  handled.forEach(item => {
    state.documents[item.documentId] = { status: item.status, processedAt };
  });
  state.lastRunAt = processedAt;
  if (!detailRateLimited) {
    state.nextRunAt = null;
    state.rateLimitCount = 0;
  }
  saveMonitorState(statePath, state, now);

  return {
    skipped: false,
    searched: posts.length,
    candidates: candidates.length,
    fetched: handled.length,
    observations: observations.length,
    inserted: appendResult.inserted?.length ?? 0,
    duplicates: appendResult.duplicates?.length ?? 0,
    errors,
  };
}

module.exports = {
  CURRENT_SEASON_START_AT,
  DEFAULT_HTTP_TIMEOUT_MS,
  DEFAULT_MAX_DETAIL_FETCHES,
  DEFAULT_MAX_POST_AGE_MS,
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_MIN_INTERVAL_MS,
  EQUIPMENT_TERMS,
  MAX_RATE_LIMIT_BACKOFF_MS,
  MIN_RATE_LIMIT_BACKOFF_MS,
  SEARCH_URL,
  SamgukFmkoreaMonitorError,
  buildRosterAliasIndex,
  calculateRateLimitBackoffMs,
  candidatePriority,
  containsRosterAlias,
  decodeHtmlEntities,
  extractGearClaims,
  fetchFmkoreaHtml,
  htmlToText,
  loadAliasesByPlayerFile,
  loadMonitorState,
  normalizeSeasonStartAt,
  parseFmkoreaPostHtml,
  parseRetryAfter,
  parseFmkoreaSearchHtml,
  runFmkoreaGearMonitor,
  saveMonitorState,
  timestampFromRegdate,
};
