const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const {
  DEFAULT_ALLOWED_BJ_IDS,
  createLiveStatusService,
  createRouter,
  parseBjIds,
} = require("../routes/live-check")._test;
const { members: samgukMembers } = require("../data/samguk-fallback.json");

function stationResponse(isLive) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ broad: isLive ? { broad_no: 1 } : null }),
  };
}

test("BJ ID를 검증하고 중복을 제거한다", () => {
  assert.deepEqual(parseBjIds("valid_1,valid_1,ABC123"), {
    ids: ["valid_1", "ABC123"],
  });
  assert.match(parseBjIds("../invalid").error, /유효하지 않은/);
  assert.match(parseBjIds(Array.from({ length: 51 }, (_, i) => `bj${i}`).join(",")).error, /최대 50개/);
});

test("삼국지 참가자도 기본 LIVE 조회 허용 목록에 포함한다", () => {
  assert.equal(samgukMembers.length, 90);
  assert.ok(samgukMembers.every(member => DEFAULT_ALLOWED_BJ_IDS.has(member.soopId)));
});

test("라우트가 입력 오류를 거부하고 공유 캐시 헤더를 설정한다", async (t) => {
  const app = express();
  app.use("/api/live-check", createRouter({
    allowedBjIds: new Set(["valid_1"]),
    service: {
      getStatuses: async (ids) => Object.fromEntries(ids.map((id) => [id, true])),
    },
  }));
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, () => resolve(instance));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const baseUrl = `http://127.0.0.1:${server.address().port}/api/live-check`;
  const invalid = await fetch(`${baseUrl}?ids=../invalid`);
  assert.equal(invalid.status, 400);

  const response = await fetch(`${baseUrl}?ids=valid_1`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control"), /s-maxage=15/);
  assert.match(response.headers.get("cdn-cache-control"), /stale-while-revalidate=30/);
  assert.deepEqual(await response.json(), { valid_1: true });

  const unknown = await fetch(`${baseUrl}?ids=unknown_bj`);
  assert.equal(unknown.status, 200);
  assert.deepEqual(await unknown.json(), { unknown_bj: false });
});

test("BJ별 TTL 안에서는 SOOP을 다시 조회하지 않는다", async () => {
  let currentTime = 1_000;
  let fetchCount = 0;
  const service = createLiveStatusService({
    now: () => currentTime,
    ttlMs: 1_000,
    fetchImpl: async () => {
      fetchCount += 1;
      return stationResponse(true);
    },
  });

  assert.equal(await service.getStatus("test_bj"), true);
  currentTime += 999;
  assert.equal(await service.getStatus("test_bj"), true);
  assert.equal(fetchCount, 1);

  currentTime += 2;
  assert.equal(await service.getStatus("test_bj"), true);
  assert.equal(fetchCount, 2);
});

test("동일 BJ의 진행 중인 조회를 하나로 합친다", async () => {
  let fetchCount = 0;
  let releaseFetch;
  const fetchGate = new Promise((resolve) => {
    releaseFetch = resolve;
  });
  const service = createLiveStatusService({
    fetchImpl: async () => {
      fetchCount += 1;
      await fetchGate;
      return stationResponse(true);
    },
  });

  const first = service.getStatus("same_bj");
  const second = service.getStatus("same_bj");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fetchCount, 1);

  releaseFetch();
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.equal(fetchCount, 1);
});

test("서로 다른 BJ 조회도 설정한 동시성 상한을 지킨다", async () => {
  let active = 0;
  let maxActive = 0;
  const service = createLiveStatusService({
    concurrency: 2,
    fetchImpl: async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return stationResponse(false);
    },
  });

  const ids = Array.from({ length: 8 }, (_, i) => `bj${i}`);
  const statuses = await service.getStatuses(ids);
  assert.equal(Object.keys(statuses).length, ids.length);
  assert.equal(maxActive, 2);
});

test("일시적인 SOOP 오류에는 마지막 상태를 유지한다", async () => {
  let currentTime = 1_000;
  let shouldFail = false;
  const service = createLiveStatusService({
    now: () => currentTime,
    ttlMs: 100,
    failureTtlMs: 50,
    fetchImpl: async () => {
      if (shouldFail) throw new Error("temporary error");
      return stationResponse(true);
    },
  });

  assert.equal(await service.getStatus("stale_bj"), true);
  currentTime += 101;
  shouldFail = true;
  assert.equal(await service.getStatus("stale_bj"), true);
});
