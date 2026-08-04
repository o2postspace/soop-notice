"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const FALLBACK = require("../data/samguk-fallback.json");
const {
  CURRENT_SEASON_START_AT,
  buildRosterAliasIndex,
  calculateRateLimitBackoffMs,
  candidatePriority,
  extractGearClaims,
  fetchFmkoreaHtml,
  loadMonitorState,
  normalizeSeasonStartAt,
  parseFmkoreaPostHtml,
  parseRetryAfter,
  parseFmkoreaSearchHtml,
  runFmkoreaGearMonitor,
} = require("../lib/samguk-fmkorea-gear-monitor");
const {
  CURRENT_SEASON_ID,
  readObservationQueue,
  resolveLatestAccepted,
} = require("../lib/samguk-observations");

const MEMBERS = Object.freeze([
  Object.freeze({ name: "조경훈", soopId: "cnsgkcnehd74" }),
  Object.freeze({ name: "킴나니", soopId: "sksgml16" }),
  Object.freeze({ name: "표우", soopId: "pyowoo" }),
]);
const LEGACY_TEST_SEASON_START_AT = "2026-08-01T00:00:00.000Z";

function runLegacyTestMonitor(options) {
  return runFmkoreaGearMonitor({ seasonStartAt: LEGACY_TEST_SEASON_START_AT, ...options });
}

function temporaryPaths(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "samguk-fmkorea-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return {
    queuePath: path.join(directory, "observations.ndjson"),
    statePath: path.join(directory, "state.json"),
  };
}

function searchItem(documentId, title, time = "14:55") {
  return `<li class="li li_best2_pop0"><h3 class="title"><a href="/index.php?document_srl=${documentId}"><span class="ellipsis-target">${title}</span></a></h3><span class="regdate">${time}</span></li>`;
}

function searchHtml(items) {
  return `<html><body><ul>${items.join("\n")}</ul></body></html>`;
}

function postHtml(documentId, title, body, regdate) {
  return `<!doctype html><html><head><meta property="og:title" content="${title}" /></head><body>
<script>window.current_document_srl = parseInt('${documentId}'); window.document_regdate = ${regdate};</script>
<article><!--BeforeDocument(${documentId},123)--><div class="document_${documentId}_123 xe_content">${body}</div><!--AfterDocument(${documentId},123)--></article>
<div class="comment-content"><div class="xe_content">댓글 속 조경훈 무기 15강</div></div>
</body></html>`;
}

function htmlResponse(url, body) {
  const response = new Response(body, {
    status: 200,
    headers: { "content-type": "text/html; charset=UTF-8" },
  });
  Object.defineProperty(response, "url", { value: url });
  return response;
}

test("명시적인 참가자·장비·강화 수치만 장비 관측으로 파싱한다", () => {
  const aliases = buildRosterAliasIndex(MEMBERS);
  assert.deepEqual(
    extractGearClaims("조경훈 무기9강 · 갑빠 8강 · 신발 7강", aliases)
      .map(({ playerId, field, value }) => ({ playerId, field, value })),
    [
      { playerId: "P001", field: "armor", value: 8 },
      { playerId: "P001", field: "shoes", value: 7 },
      { playerId: "P001", field: "weapon", value: 9 },
    ],
  );
  assert.deepEqual(
    extractGearClaims("킴나니 무기8강 ㅅㅅ", aliases)
      .map(({ playerId, field, value }) => ({ playerId, field, value })),
    [{ playerId: "P002", field: "weapon", value: 8 }],
  );
  assert.deepEqual(
    extractGearClaims("표우가 두갑 4강 성공", aliases)
      .map(({ playerId, field, value }) => ({ playerId, field, value })),
    [{ playerId: "P003", field: "helmet", value: 4 }],
  );
});

test("실패·도전·가정·질문과 슬롯이 모호한 방어구 표현은 거부한다", () => {
  const aliases = buildRosterAliasIndex(MEMBERS);
  for (const title of [
    "조경훈 갑빠 9강 실패",
    "조경훈 무기 10강 도전",
    "조경훈 갑빠 9강이면 우승",
    "조경훈 신발 8강?",
    "조경훈 방어구 9강",
    "갑빠 9강 성공",
    "조경훈 갑빠 16강 성공",
    "조경훈 갑빠 9강 맞나",
    "조경훈 갑빠 9강 아님",
    "조경훈 갑빠 9강 못갔네",
    "조경훈 갑빠 9강 성공했나",
    "조경훈 갑빠 9강 됐나",
  ]) {
    assert.deepEqual(extractGearClaims(title, aliases), [], title);
  }
});

test("기본 90명 roster에서 조경훈과 킴나니 player_id를 고정한다", () => {
  const aliases = buildRosterAliasIndex(FALLBACK.members);
  assert.deepEqual(
    extractGearClaims("조경훈 갑빠 9강 성공 · 킴나니 무기8강 성공", aliases)
      .map(({ playerId, field, value }) => ({ playerId, field, value })),
    [
      { playerId: "P001", field: "armor", value: 9 },
      { playerId: "P044", field: "weapon", value: 8 },
    ],
  );
});

test("roster 별칭은 한 참가자에만 매칭될 때 사용한다", () => {
  const aliases = buildRosterAliasIndex(MEMBERS, {
    aliasesByPlayer: {
      P001: ["경훈"],
      킴나니: ["나니"],
    },
  });
  assert.deepEqual(
    extractGearClaims("경훈이 갑바 9강, 나니 무기 8강", aliases)
      .map(({ playerId, field, value }) => ({ playerId, field, value })),
    [
      { playerId: "P001", field: "armor", value: 9 },
      { playerId: "P002", field: "weapon", value: 8 },
    ],
  );

  const ambiguous = buildRosterAliasIndex(MEMBERS, {
    aliasesByPlayer: { P001: ["공통"], P002: ["공통"] },
  });
  assert.deepEqual(extractGearClaims("공통 무기 8강", ambiguous), []);
});

test("검색 HTML의 강조 태그를 제거하고 문서번호·제목만 추출한다", () => {
  const posts = parseFmkoreaSearchHtml(searchHtml([
    searchItem("10166535738", "킴나니 무기8<strong class=\"searchContextDoc\">강</strong> ㅅㅅ"),
    searchItem("10166534555", "조경훈 갑빠 9<strong>강</strong> 좀 큰데"),
  ]));
  assert.deepEqual(posts, [
    {
      documentId: "10166535738",
      title: "킴나니 무기8 강 ㅅㅅ",
      sourceUrl: "https://www.fmkorea.com/10166535738",
    },
    {
      documentId: "10166534555",
      title: "조경훈 갑빠 9 강 좀 큰데",
      sourceUrl: "https://www.fmkorea.com/10166534555",
    },
  ]);
});

test("게시물 본문과 정확한 KST 작성시각만 읽고 댓글은 제외한다", () => {
  const detail = parseFmkoreaPostHtml(
    postHtml("10166534555", "조경훈 갑빠 9강", "<p>조경훈 갑빠 9강 성공</p>", "20260803145541"),
    "10166534555",
  );
  assert.equal(detail.title, "조경훈 갑빠 9강");
  assert.equal(detail.body, "조경훈 갑빠 9강 성공");
  assert.equal(detail.observedAt, "2026-08-03T05:55:41.000Z");
  assert.doesNotMatch(detail.body, /댓글/);
  assert.throws(
    () => parseFmkoreaPostHtml(postHtml("10166534555", "제목", "본문", "20260803145541"), "10166535738"),
    error => error.code === "invalid_post_html",
  );
});

test("후보는 정확한 제목을 우선하고 참가자 또는 장비 단서가 있어야 한다", () => {
  const aliases = buildRosterAliasIndex(MEMBERS);
  assert.equal(candidatePriority({ title: "조경훈 갑빠 9강 성공" }, aliases), 0);
  assert.equal(candidatePriority({ title: "조경훈 저게 왜 됨" }, aliases), 1);
  assert.equal(candidatePriority({ title: "누군가 무기 8강 성공" }, aliases), 2);
  assert.equal(candidatePriority({ title: "강화석 가격이 올랐다" }, aliases), null);
});

test("시즌 시작시각은 현재 시즌 기본값과 엄격한 UTC ISO 명시값만 허용한다", () => {
  assert.equal(normalizeSeasonStartAt(), CURRENT_SEASON_START_AT);
  assert.equal(
    normalizeSeasonStartAt("2026-08-04T10:36:40.000Z"),
    "2026-08-04T10:36:40.000Z",
  );
  for (const value of ["2026-08-04T19:36:40+09:00", "2026-08-04", "invalid", 0]) {
    assert.throws(
      () => normalizeSeasonStartAt(value),
      error => error.code === "invalid_config",
    );
  }
});

test("수집기는 문서 cache·5분 간격을 지키고 FM 단독 관측만 queue에 넣는다", async (t) => {
  const { queuePath, statePath } = temporaryPaths(t);
  const list = searchHtml([
    searchItem("10166535738", "킴나니 무기8<strong>강</strong> ㅅㅅ"),
    searchItem("10166534555", "조경훈 갑빠 9<strong>강</strong> 성공"),
    searchItem("10166530000", "강화 관련 잡담"),
  ]);
  const details = new Map([
    ["https://www.fmkorea.com/10166535738", postHtml(
      "10166535738", "킴나니 무기8강 ㅅㅅ", "<p>킴나니 무기 8강 성공</p>", "20260803145600",
    )],
    ["https://www.fmkorea.com/10166534555", postHtml(
      "10166534555", "조경훈 갑빠 9강 성공", "<p>조경훈 갑빠 9강 성공</p>", "20260803145500",
    )],
  ]);
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes("search.php")) return htmlResponse(url, list);
    if (details.has(url)) return htmlResponse(url, details.get(url));
    throw new Error(`unexpected URL: ${url}`);
  };
  const now = Date.parse("2026-08-03T06:00:00.000Z");
  const first = await runLegacyTestMonitor({
    queuePath,
    statePath,
    members: MEMBERS,
    fetchImpl,
    now,
  });
  assert.deepEqual(first, {
    skipped: false,
    searched: 3,
    candidates: 2,
    fetched: 2,
    observations: 2,
    inserted: 2,
    duplicates: 0,
    errors: [],
  });
  const queued = readObservationQueue(queuePath);
  assert.ok(queued.every(item => item.seasonId === CURRENT_SEASON_ID));
  assert.deepEqual(queued.map(item => [item.playerId, item.field, item.value, item.sourceType]), [
    ["P002", "weapon", 8, "fmkorea"],
    ["P001", "armor", 9, "fmkorea"],
  ]);
  assert.deepEqual(resolveLatestAccepted(queued, { now }), []);
  assert.equal(loadMonitorState(statePath).documents["10166535738"].status, "queued");

  const second = await runLegacyTestMonitor({
    queuePath,
    statePath,
    members: MEMBERS,
    fetchImpl,
    now: now + 60_000,
  });
  assert.equal(second.skipped, true);
  assert.equal(calls.length, 3);
  assert.equal(readObservationQueue(queuePath).length, 2);
});

test("시즌 시작 전 게시물은 관측과 processed cache에서 모두 제외한다", async (t) => {
  const { queuePath, statePath } = temporaryPaths(t);
  const beforeId = "10166530001";
  const boundaryId = "10166530002";
  const list = searchHtml([
    searchItem(beforeId, "조경훈 갑빠 9강 성공"),
    searchItem(boundaryId, "킴나니 무기8강 성공"),
  ]);
  const details = new Map([
    [`https://www.fmkorea.com/${beforeId}`, postHtml(
      beforeId, "조경훈 갑빠 9강 성공", "<p>조경훈 갑빠 9강 성공</p>", "20260804193639",
    )],
    [`https://www.fmkorea.com/${boundaryId}`, postHtml(
      boundaryId, "킴나니 무기8강 성공", "<p>킴나니 무기8강 성공</p>", "20260804193640",
    )],
  ]);
  const detailCalls = [];
  const fetchImpl = async (url) => {
    if (url.includes("search.php")) return htmlResponse(url, list);
    detailCalls.push(url);
    return htmlResponse(url, details.get(url));
  };
  const now = Date.parse("2026-08-04T10:40:00.000Z");

  const first = await runFmkoreaGearMonitor({
    queuePath,
    statePath,
    members: MEMBERS,
    fetchImpl,
    now,
  });
  assert.equal(first.candidates, 2);
  assert.equal(first.observations, 1);
  assert.equal(first.inserted, 1);
  assert.deepEqual(
    readObservationQueue(queuePath).map(item => [item.playerId, item.field, item.value]),
    [["P002", "weapon", 8]],
  );
  let state = loadMonitorState(statePath);
  assert.equal(state.documents[beforeId], undefined);
  assert.equal(state.documents[boundaryId].status, "queued");

  const second = await runFmkoreaGearMonitor({
    queuePath,
    statePath,
    members: MEMBERS,
    fetchImpl,
    now: now + 5 * 60_000,
    force: true,
  });
  assert.equal(second.candidates, 1);
  assert.equal(second.observations, 0);
  assert.equal(second.inserted, 0);
  state = loadMonitorState(statePath);
  assert.equal(state.documents[beforeId], undefined);
  assert.deepEqual(detailCalls, [
    `https://www.fmkorea.com/${beforeId}`,
    `https://www.fmkorea.com/${boundaryId}`,
    `https://www.fmkorea.com/${beforeId}`,
  ]);
});

test("상세 응답 오류 문서는 cache하지 않아 다음 주기에 재시도한다", async (t) => {
  const { queuePath, statePath } = temporaryPaths(t);
  const documentId = "10166534555";
  const list = searchHtml([searchItem(documentId, "조경훈 갑빠 9강 성공")]);
  const fetchImpl = async (url) => (
    url.includes("search.php")
      ? htmlResponse(url, list)
      : htmlResponse(url, "<html>broken</html>")
  );
  const now = Date.parse("2026-08-03T06:00:00.000Z");
  const result = await runLegacyTestMonitor({
    queuePath,
    statePath,
    members: MEMBERS,
    fetchImpl,
    now,
  });
  assert.equal(result.inserted, 0);
  assert.deepEqual(result.errors, [{ documentId, code: "invalid_post_html" }]);
  assert.equal(loadMonitorState(statePath).documents[documentId], undefined);
});

test("FMK 요청 제한 응답도 실행시각을 기록해 즉시 재요청하지 않는다", async (t) => {
  const { queuePath, statePath } = temporaryPaths(t);
  let calls = 0;
  const fetchImpl = async (url) => {
    calls += 1;
    const response = new Response("rate limited", {
      status: 430,
      headers: { "content-type": "text/html; charset=UTF-8", "retry-after": "300" },
    });
    Object.defineProperty(response, "url", { value: url });
    return response;
  };
  const now = Date.parse("2026-08-03T06:00:00.000Z");
  await assert.rejects(
    () => runLegacyTestMonitor({ queuePath, statePath, members: MEMBERS, fetchImpl, now }),
    error => error.code === "upstream_rate_limited",
  );
  assert.deepEqual(loadMonitorState(statePath), {
    version: 2,
    lastRunAt: "2026-08-03T06:00:00.000Z",
    nextRunAt: "2026-08-03T06:10:00.000Z",
    rateLimitCount: 1,
    documents: {},
  });

  const second = await runLegacyTestMonitor({
    queuePath,
    statePath,
    members: MEMBERS,
    fetchImpl,
    now: now + 6 * 60_000,
    force: true,
  });
  assert.equal(second.skipped, true);
  assert.equal(second.reason, "rate-limit");
  assert.equal(calls, 1);

  await assert.rejects(
    () => runLegacyTestMonitor({
      queuePath,
      statePath,
      members: MEMBERS,
      fetchImpl,
      now: now + 10 * 60_000,
    }),
    error => error.code === "upstream_rate_limited",
  );
  const repeated = loadMonitorState(statePath);
  assert.equal(repeated.rateLimitCount, 2);
  assert.equal(repeated.nextRunAt, "2026-08-03T06:30:00.000Z");
  assert.equal(calls, 2);
});

test("Retry-After와 지수 backoff는 10분부터 시작해 1시간에서 멈춘다", () => {
  const now = Date.parse("2026-08-03T06:00:00.000Z");
  assert.equal(parseRetryAfter("300", now), 300_000);
  assert.equal(parseRetryAfter("Mon, 03 Aug 2026 06:30:00 GMT", now), 30 * 60_000);
  assert.equal(parseRetryAfter("invalid", now), null);
  assert.equal(calculateRateLimitBackoffMs(1, 300_000), 10 * 60_000);
  assert.equal(calculateRateLimitBackoffMs(2, null), 20 * 60_000);
  assert.equal(calculateRateLimitBackoffMs(3, null), 40 * 60_000);
  assert.equal(calculateRateLimitBackoffMs(4, null), 60 * 60_000);
  assert.equal(calculateRateLimitBackoffMs(20, 2 * 60 * 60_000), 60 * 60_000);
});

test("v1 state는 nextRunAt과 rateLimitCount를 가진 v2로 호환 마이그레이션한다", (t) => {
  const { statePath } = temporaryPaths(t);
  fs.writeFileSync(statePath, `${JSON.stringify({
    version: 1,
    lastRunAt: "2026-08-03T06:00:00.000Z",
    documents: {
      10166534555: { status: "queued", processedAt: "2026-08-03T06:00:00.000Z" },
    },
  })}\n`, { mode: 0o600 });
  assert.deepEqual(loadMonitorState(statePath), {
    version: 2,
    lastRunAt: "2026-08-03T06:00:00.000Z",
    nextRunAt: null,
    rateLimitCount: 0,
    documents: {
      10166534555: { status: "queued", processedAt: "2026-08-03T06:00:00.000Z" },
    },
  });
});

test("상세 조회에서 제한되면 앞선 관측은 보존하고 남은 상세 요청을 중단한다", async (t) => {
  const { queuePath, statePath } = temporaryPaths(t);
  const documents = ["10166534555", "10166535738", "10166539999"];
  const list = searchHtml([
    searchItem(documents[0], "조경훈 갑빠 9강 성공"),
    searchItem(documents[1], "킴나니 무기8강 성공"),
    searchItem(documents[2], "표우 신발7강 성공"),
  ]);
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes("search.php")) return htmlResponse(url, list);
    if (url.endsWith(documents[0])) {
      return htmlResponse(url, postHtml(
        documents[0], "조경훈 갑빠 9강 성공", "<p>조경훈 갑빠 9강 성공</p>", "20260803145500",
      ));
    }
    if (url.endsWith(documents[1])) {
      const response = new Response("rate limited", {
        status: 429,
        headers: { "content-type": "text/html", "retry-after": "1200" },
      });
      Object.defineProperty(response, "url", { value: url });
      return response;
    }
    throw new Error(`제한 뒤 호출되면 안 됩니다: ${url}`);
  };
  const now = Date.parse("2026-08-03T06:00:00.000Z");
  const result = await runLegacyTestMonitor({
    queuePath,
    statePath,
    members: MEMBERS,
    fetchImpl,
    now,
  });
  assert.equal(result.inserted, 1);
  assert.deepEqual(result.errors, [{ documentId: documents[1], code: "upstream_rate_limited" }]);
  assert.equal(calls.length, 3);
  assert.deepEqual(
    readObservationQueue(queuePath).map(item => [item.playerId, item.field, item.value]),
    [["P001", "armor", 9]],
  );
  const state = loadMonitorState(statePath);
  assert.equal(state.rateLimitCount, 1);
  assert.equal(state.nextRunAt, "2026-08-03T06:20:00.000Z");
  assert.equal(state.documents[documents[0]].status, "queued");
  assert.equal(state.documents[documents[1]], undefined);
  assert.equal(state.documents[documents[2]], undefined);
});

test("FMK 밖으로 향하는 redirect는 다음 요청 전에 차단한다", async () => {
  let calls = 0;
  const fetchImpl = async (url) => {
    calls += 1;
    const response = new Response(null, {
      status: 302,
      headers: { location: "http://127.0.0.1/internal" },
    });
    Object.defineProperty(response, "url", { value: url });
    return response;
  };
  await assert.rejects(
    () => fetchFmkoreaHtml("https://www.fmkorea.com/10166534555", { fetchImpl }),
    error => error.code === "unsafe_response_url",
  );
  assert.equal(calls, 1);
});
