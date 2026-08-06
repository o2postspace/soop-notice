const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const express = require("express");
const noticesRoute = require("../routes/notices");
const noticeContentRoute = require("../routes/notice-content");

const {
  NOTICE_METADATA_COLUMNS,
  createRouter: createNoticesRouter,
} = noticesRoute._test;
const {
  DEFAULT_RATE_LIMIT,
  createRouter: createNoticeContentRouter,
} = noticeContentRoute._test;

async function listen(router, mountPath = "/api") {
  const app = express();
  app.use(mountPath, router);
  const server = await new Promise(resolve => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  return {
    server,
    url: `http://127.0.0.1:${server.address().port}${mountPath}`,
  };
}

test("공지 목록은 명시한 metadata만 조회하고 본문 필드를 제거한다", async (t) => {
  let capturedSql = "";
  let capturedParams = [];
  const router = createNoticesRouter({
    bjList: { allowed_bj: { name: "허용" } },
    selectFn: async (sql, params) => {
      capturedSql = sql;
      capturedParams = params;
      return [{
        id: 1,
        bj_id: "allowed_bj",
        bj_name: "허용",
        title_no: 123,
        title_name: "공지",
        content_html: "<p>목록에 노출되면 안 되는 본문</p>",
        internal_value: "secret",
      }];
    },
  });
  const { server, url } = await listen(router, "/api/notices");
  t.after(() => new Promise(resolve => server.close(resolve)));

  const response = await fetch(url, { headers: { "Accept-Encoding": "identity" } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(await response.json(), [{
    id: 1,
    bj_id: "allowed_bj",
    bj_name: "허용",
    title_no: 123,
    title_name: "공지",
  }]);
  assert.doesNotMatch(capturedSql, /SELECT\s+\*/i);
  assert.doesNotMatch(capturedSql, /content_html/i);
  for (const column of NOTICE_METADATA_COLUMNS) assert.match(capturedSql, new RegExp(`\\b${column}\\b`));
  assert.deepEqual(capturedParams, ["allowed_bj"]);
});

test("공지 상세은 허용 BJ 범위에서만 조회하고 private 보안 헤더를 보낸다", async (t) => {
  let capturedSql = "";
  let capturedParams = [];
  const router = createNoticeContentRouter({
    bjList: { allowed_bj: { name: "허용" } },
    env: { NODE_ENV: "production" },
    selectFn: async (sql, params) => {
      capturedSql = sql;
      capturedParams = params;
      return [{ content_html: "<p>본문</p>" }];
    },
  });
  const { server, url } = await listen(router, "/api/notice-content");
  t.after(() => new Promise(resolve => server.close(resolve)));

  const response = await fetch(`${url}?title_no=123`, {
    headers: { Origin: "https://soopnotice.com" },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { content_html: "<p>본문</p>" });
  assert.equal(response.headers.get("cache-control"), "private, max-age=300");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("x-robots-tag"), "noindex, noarchive, nosnippet");
  assert.match(response.headers.get("vary"), /Origin/i);
  assert.match(capturedSql, /title_no\s*=\s*\?/i);
  assert.match(capturedSql, /bj_id\s+IN\s*\(\?\)/i);
  assert.deepEqual(capturedParams, [123, "allowed_bj"]);
});

test("공지 상세은 Origin 없는 서버 호출과 same-origin만 허용하고 외부 Origin은 거부한다", async (t) => {
  let queryCount = 0;
  const router = createNoticeContentRouter({
    bjList: { allowed_bj: { name: "허용" } },
    env: { NODE_ENV: "production" },
    allowedOrigins: new Set(),
    selectFn: async () => {
      queryCount += 1;
      return [{ content_html: "본문" }];
    },
  });
  const { server, url } = await listen(router, "/api/notice-content");
  t.after(() => new Promise(resolve => server.close(resolve)));

  const serverCall = await fetch(`${url}?title_no=1`);
  assert.equal(serverCall.status, 200);

  const sameOrigin = new URL(url).origin;
  const browserCall = await fetch(`${url}?title_no=2`, { headers: { Origin: sameOrigin } });
  assert.equal(browserCall.status, 200);

  const external = await fetch(`${url}?title_no=3`, {
    headers: { Origin: "https://attacker.example" },
  });
  assert.equal(external.status, 403);
  assert.deepEqual(await external.json(), { error: "Origin not allowed" });
  assert.equal(external.headers.get("cache-control"), "no-store");
  assert.equal(queryCount, 2);
});

test("공지 상세은 엄격한 title_no 검증과 IP별 요청 제한을 적용한다", async (t) => {
  let queryCount = 0;
  const router = createNoticeContentRouter({
    bjList: { allowed_bj: { name: "허용" } },
    env: { NODE_ENV: "production" },
    allowedOrigins: new Set(["https://soopnotice.com"]),
    rateLimit: 2,
    rateWindowMs: 60_000,
    now: () => 1_000,
    selectFn: async () => {
      queryCount += 1;
      return [{ content_html: "본문" }];
    },
  });
  const { server, url } = await listen(router, "/api/notice-content");
  t.after(() => new Promise(resolve => server.close(resolve)));
  const headers = { Origin: "https://soopnotice.com" };

  const invalid = await fetch(`${url}?title_no=1junk`, { headers });
  assert.equal(invalid.status, 400);
  assert.equal(queryCount, 0);

  const second = await fetch(`${url}?title_no=1`, { headers });
  assert.equal(second.status, 200);
  assert.equal(second.headers.get("ratelimit-limit"), "2");

  const limited = await fetch(`${url}?title_no=2`, { headers });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "60");
  assert.equal(limited.headers.get("cache-control"), "no-store");
  assert.equal(queryCount, 1);
  assert.equal(DEFAULT_RATE_LIMIT, 120);
});

test("개발용 서버의 공지 목록 조회도 metadata 컬럼만 선택한다", () => {
  for (const filename of ["dev-server.js", "local-server.js"]) {
    const source = fs.readFileSync(path.join(__dirname, "..", "..", filename), "utf8");
    assert.match(source, /NOTICE_METADATA_COLUMNS/);
    assert.doesNotMatch(source, /from\("notices"\)[\s\S]{0,80}select\("\*"\)/);
  }
});

test("기존 default router export와 createRouter export를 함께 유지한다", () => {
  assert.equal(typeof noticesRoute, "function");
  assert.equal(typeof noticesRoute.createRouter, "function");
  assert.equal(typeof noticeContentRoute, "function");
  assert.equal(typeof noticeContentRoute.createRouter, "function");
});
