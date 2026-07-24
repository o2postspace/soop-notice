const { test } = require("node:test");
const assert = require("node:assert/strict");
const { brotliDecompressSync, gunzipSync } = require("node:zlib");
const {
  createEncodedJsonCache,
  etagMatches,
  selectEncoding,
  sendEncodedJson,
} = require("../lib/encoded-json-cache");

function createResponse(initialHeaders = {}) {
  const headers = new Map(
    Object.entries(initialHeaders).map(([name, value]) => [name.toLowerCase(), String(value)])
  );

  return {
    statusCode: 200,
    body: undefined,
    ended: false,
    getHeader(name) {
      return headers.get(name.toLowerCase());
    },
    setHeader(name, value) {
      headers.set(name.toLowerCase(), String(value));
    },
    removeHeader(name) {
      headers.delete(name.toLowerCase());
    },
    end(body) {
      this.body = body;
      this.ended = true;
    },
  };
}

function request(headers = {}, method = "GET") {
  return {
    method,
    headers: Object.fromEntries(
      Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value])
    ),
  };
}

test("동시 cold 요청은 DB loader와 압축을 한 번만 수행한다", async () => {
  let release;
  let loadCount = 0;
  const blocked = new Promise(resolve => { release = resolve; });
  const cache = createEncodedJsonCache({
    load: async () => {
      loadCount++;
      await blocked;
      return [{ title_no: 1, content_html: "본문" }];
    },
  });

  const first = cache.get();
  const second = cache.get();
  assert.equal(loadCount, 1);

  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a, b);
  assert.equal(loadCount, 1);
  assert.deepEqual(
    JSON.parse(brotliDecompressSync(a.variants.br.body).toString()),
    [{ title_no: 1, content_html: "본문" }]
  );
  assert.deepEqual(
    JSON.parse(gunzipSync(a.variants.gzip.body).toString()),
    [{ title_no: 1, content_html: "본문" }]
  );
});

test("TTL 동안 캐시를 재사용하고 만료 뒤 한 번만 갱신한다", async () => {
  let currentTime = 1_000;
  let loadCount = 0;
  const cache = createEncodedJsonCache({
    load: async () => [{ version: ++loadCount }],
    ttlMs: 60_000,
    now: () => currentTime,
  });

  const first = await cache.get();
  currentTime += 59_999;
  assert.equal(await cache.get(), first);
  assert.equal(loadCount, 1);

  currentTime++;
  const [second, alsoSecond] = await Promise.all([cache.get(), cache.get()]);
  assert.equal(second, alsoSecond);
  assert.notEqual(second, first);
  assert.equal(loadCount, 2);
});

test("갱신 실패 시 마지막 정상 응답을 유지하고 짧은 TTL 뒤 재시도한다", async () => {
  let currentTime = 0;
  let calls = 0;
  let shouldFail = false;
  const errors = [];
  const cache = createEncodedJsonCache({
    load: async () => {
      calls += 1;
      if (shouldFail) throw new Error("temporary database failure");
      return [{ version: calls }];
    },
    ttlMs: 100,
    staleIfErrorMs: 20,
    now: () => currentTime,
    onRefreshError: error => errors.push(error.message),
  });

  const initial = await cache.get();
  currentTime = 101;
  shouldFail = true;
  const stale = await cache.get();
  assert.equal(stale, initial);
  assert.equal(calls, 2);
  assert.deepEqual(errors, ["temporary database failure"]);

  currentTime = 110;
  assert.equal(await cache.get(), initial);
  assert.equal(calls, 2);

  currentTime = 122;
  shouldFail = false;
  const refreshed = await cache.get();
  assert.notEqual(refreshed, initial);
  assert.equal(calls, 3);
});

test("Accept-Encoding의 q값과 identity 제외를 반영한다", () => {
  assert.equal(selectEncoding(undefined), "identity");
  assert.equal(selectEncoding("gzip, deflate, br"), "br");
  assert.equal(selectEncoding("br;q=0.4, gzip;q=0.8, identity;q=0.2"), "gzip");
  assert.equal(selectEncoding("br;q=0, gzip;q=0, identity;q=0"), null);
  assert.equal(selectEncoding("*;q=0"), null);
  assert.equal(selectEncoding("*;q=0.5, identity;q=0"), "br");
});

test("압축 응답에 variant별 헤더와 정확한 길이를 설정한다", async () => {
  const cache = createEncodedJsonCache({ load: async () => [{ value: "반복".repeat(100) }] });
  const entry = await cache.get();
  const res = createResponse({ Vary: "Origin" });

  sendEncodedJson(request({ "Accept-Encoding": "gzip, br" }), res, entry);

  assert.equal(res.statusCode, 200);
  assert.equal(res.getHeader("content-type"), "application/json; charset=utf-8");
  assert.equal(res.getHeader("content-encoding"), "br");
  assert.equal(res.getHeader("content-length"), String(entry.variants.br.body.length));
  assert.equal(res.getHeader("vary"), "Origin, Accept-Encoding");
  assert.equal(res.getHeader("etag"), entry.variants.br.etag);
  assert.deepEqual(res.body, entry.variants.br.body);
});

test("일치하는 If-None-Match는 본문과 representation 헤더 없이 304를 반환한다", async () => {
  const cache = createEncodedJsonCache({ load: async () => [{ value: 1 }] });
  const entry = await cache.get();
  const etag = entry.variants.gzip.etag;
  const res = createResponse();

  sendEncodedJson(
    request({ "Accept-Encoding": "gzip", "If-None-Match": `W/${etag}` }),
    res,
    entry
  );

  assert.equal(res.statusCode, 304);
  assert.equal(res.body, undefined);
  assert.equal(res.getHeader("etag"), etag);
  assert.equal(res.getHeader("content-type"), undefined);
  assert.equal(res.getHeader("content-encoding"), undefined);
  assert.equal(res.getHeader("content-length"), undefined);
  assert.equal(res.getHeader("vary"), "Accept-Encoding");
  assert.match(res.getHeader("cache-control"), /s-maxage=60/);
});

test("HEAD와 허용 인코딩이 없는 요청을 올바르게 처리한다", async () => {
  const cache = createEncodedJsonCache({ load: async () => [{ value: 1 }] });
  const entry = await cache.get();

  const head = createResponse();
  sendEncodedJson(request({ "Accept-Encoding": "br" }, "HEAD"), head, entry);
  assert.equal(head.statusCode, 200);
  assert.equal(head.body, undefined);
  assert.equal(head.getHeader("content-encoding"), "br");
  assert.equal(head.getHeader("content-length"), String(entry.variants.br.body.length));

  const unacceptable = createResponse();
  sendEncodedJson(
    request({ "Accept-Encoding": "br;q=0, gzip;q=0, identity;q=0" }),
    unacceptable,
    entry
  );
  assert.equal(unacceptable.statusCode, 406);
  assert.equal(unacceptable.getHeader("content-length"), "0");
  assert.equal(unacceptable.getHeader("cache-control"), "no-store");
});

test("If-None-Match 목록과 wildcard를 weak 비교한다", () => {
  assert.equal(etagMatches('"other", W/"target"', '"target"'), true);
  assert.equal(etagMatches("*", '"target"'), true);
  assert.equal(etagMatches('"other"', '"target"'), false);
});
