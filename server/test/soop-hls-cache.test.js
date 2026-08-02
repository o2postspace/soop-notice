"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  MAX_BJ_IDS,
  MAX_TTL_MS,
  SoopHlsCacheError,
  createSoopHlsCache,
} = require("../lib/soop-hls-cache");

function hlsResult(bjId, quality, version = 1) {
  return {
    bjId,
    broadNo: String(300_000_000 + version),
    quality,
    hlsUrl: `https://live-pcweb-kr-cdn-z02.sooplive.com/live/${bjId}/${quality}.m3u8?aid=private-${version}`,
  };
}

function immediateResolvers(calls = { SD: 0, HD: 0 }) {
  return {
    SD: async (bjId) => hlsResult(bjId, "SD", ++calls.SD),
    HD: async (bjId) => hlsResult(bjId, "HD", ++calls.HD),
  };
}

test("resolver·TTL·최대 BJ 수와 SD/HD 품질을 엄격히 검증한다", async () => {
  assert.throws(
    () => createSoopHlsCache({ resolvers: { SD: async () => ({}) } }),
    error => error instanceof SoopHlsCacheError && error.code === "invalid_config",
  );
  assert.throws(
    () => createSoopHlsCache({ resolvers: immediateResolvers(), ttlMs: MAX_TTL_MS + 1 }),
    error => error.code === "invalid_config",
  );
  assert.throws(
    () => createSoopHlsCache({ resolvers: immediateResolvers(), ttlMs: 0 }),
    error => error.code === "invalid_config",
  );
  assert.throws(
    () => createSoopHlsCache({ resolvers: immediateResolvers(), maxBjIds: MAX_BJ_IDS + 1 }),
    error => error.code === "invalid_config",
  );
  assert.throws(
    () => createSoopHlsCache({ resolvers: immediateResolvers(), unexpected: true }),
    error => error.code === "invalid_config",
  );

  const calls = { SD: 0, HD: 0 };
  const cache = createSoopHlsCache({ resolvers: immediateResolvers(calls) });
  assert.throws(() => cache.get("valid_bj", "sd"), error => error.code === "invalid_quality");
  assert.throws(() => cache.get("../invalid", "SD"), error => error.code === "invalid_bj_id");
  const forgedSignal = Object.create(AbortSignal.prototype);
  const accessorOptions = {};
  Object.defineProperty(accessorOptions, "signal", {
    enumerable: true,
    get() {
      throw new Error("cache-options-getter-secret");
    },
  });
  for (const options of [null, { signal: {} }, { signal: forgedSignal }, { unexpected: true }, accessorOptions]) {
    assert.throws(
      () => cache.get("valid_bj", "SD", options),
      error => error.code === "invalid_config" && !error.message.includes("getter-secret"),
    );
  }
  const controller = new AbortController();
  controller.abort(new Error("cache-proxy-secret"));
  const proxyOptions = new Proxy({ signal: controller.signal }, {
    get() {
      throw new Error("cache-proxy-secret");
    },
  });
  await assert.rejects(cache.get("valid_bj", "SD", proxyOptions), error => (
    error.code === "aborted" && !error.message.includes("proxy-secret")
  ));
  assert.equal(calls.SD + calls.HD, 0);
});

test("quality별 resolver 결과를 TTL 동안 재사용하고 만료 시 갱신한다", async () => {
  let currentTime = 1_000;
  const calls = { SD: 0, HD: 0 };
  const cache = createSoopHlsCache({
    resolvers: immediateResolvers(calls),
    ttlMs: 60_000,
    clock: () => currentTime,
  });

  const firstSd = await cache.get("devil0108", "SD");
  assert.equal(firstSd.quality, "SD");
  assert.match(firstSd.hlsUrl, /\?aid=private-1$/);
  assert.equal(Object.isFrozen(firstSd), true);
  currentTime = 60_999;
  assert.equal(await cache.get("devil0108", "SD"), firstSd);
  assert.equal(calls.SD, 1);

  const firstHd = await cache.get("devil0108", "HD");
  assert.equal(firstHd.quality, "HD");
  assert.equal(calls.HD, 1);

  currentTime = 61_000;
  const secondSd = await cache.get("devil0108", "SD");
  assert.notEqual(secondSd, firstSd);
  assert.equal(calls.SD, 2);
  assert.match(secondSd.hlsUrl, /\?aid=private-2$/);

  const snapshot = cache.getSnapshot();
  assert.equal(snapshot.cachedCount, 2);
  assert.deepEqual(snapshot.byQuality.SD, { entries: 1, cached: 1, pending: 0 });
  assert.deepEqual(snapshot.byQuality.HD, { entries: 1, cached: 1, pending: 0 });
  const visible = JSON.stringify(snapshot);
  assert.equal(visible.includes("https://"), false);
  assert.equal(visible.includes("aid="), false);
  assert.equal(visible.includes("devil0108"), false);
});

test("동일 BJ·quality의 동시 resolve는 같은 pending promise로 dedupe한다", async () => {
  let release;
  let calls = 0;
  const blocked = new Promise(resolve => { release = resolve; });
  const cache = createSoopHlsCache({
    resolvers: {
      SD: async (bjId) => {
        calls += 1;
        await blocked;
        return hlsResult(bjId, "SD");
      },
      HD: async bjId => hlsResult(bjId, "HD"),
    },
  });

  const first = cache.get("same_bj", "SD");
  const second = cache.get("same_bj", "SD");
  assert.equal(first, second);
  await Promise.resolve();
  assert.equal(calls, 1);
  assert.equal(cache.getSnapshot().pendingCount, 1);

  release();
  const [left, right] = await Promise.all([first, second]);
  assert.equal(left, right);
  assert.equal(cache.getSnapshot().stats.deduped, 1);
});

test("invalidate 중 완료된 이전 pending 결과는 cache에 되살아나지 않는다", async () => {
  const releases = [];
  let calls = 0;
  const cache = createSoopHlsCache({
    resolvers: {
      SD: bjId => new Promise(resolve => {
        calls += 1;
        const version = calls;
        releases.push(() => resolve(hlsResult(bjId, "SD", version)));
      }),
      HD: async bjId => hlsResult(bjId, "HD"),
    },
  });

  const oldPending = cache.get("generation_bj", "SD");
  await Promise.resolve();
  assert.equal(cache.invalidate("generation_bj", "SD"), 1);
  const newPending = cache.get("generation_bj", "SD");
  await Promise.resolve();
  assert.equal(calls, 2);

  releases[0]();
  const oldResult = await oldPending;
  assert.match(oldResult.hlsUrl, /private-1$/);
  assert.equal(cache.getSnapshot().cachedCount, 0);
  assert.equal(cache.getSnapshot().pendingCount, 1);

  releases[1]();
  const newResult = await newPending;
  assert.match(newResult.hlsUrl, /private-2$/);
  assert.equal(await cache.get("generation_bj", "SD"), newResult);
  assert.equal(calls, 2);
});

test("BJ 전체 invalidate와 clear도 pending generation을 폐기한다", async () => {
  const resolvers = immediateResolvers();
  const cache = createSoopHlsCache({ resolvers });
  await Promise.all([cache.get("all_bj", "SD"), cache.get("all_bj", "HD")]);
  assert.equal(cache.invalidate("all_bj"), 2);
  assert.equal(cache.getSnapshot().entryCount, 0);

  const releases = [];
  const pendingCache = createSoopHlsCache({
    resolvers: {
      SD: bjId => new Promise(resolve => releases.push(() => resolve(hlsResult(bjId, "SD")))),
      HD: bjId => new Promise(resolve => releases.push(() => resolve(hlsResult(bjId, "HD")))),
    },
  });
  const pending = [pendingCache.get("clear_bj", "SD"), pendingCache.get("clear_bj", "HD")];
  await Promise.resolve();
  assert.equal(pendingCache.clear(), 2);
  for (const release of releases) release();
  await Promise.all(pending);
  assert.equal(pendingCache.getSnapshot().entryCount, 0);
  assert.equal(pendingCache.getSnapshot().cachedCount, 0);
});

test("LRU 단위로 BJ를 제거해 SD/HD 합계와 BJ 수 상한을 지킨다", async () => {
  const calls = new Map();
  const resolver = quality => async (bjId) => {
    const key = `${bjId}:${quality}`;
    const count = (calls.get(key) || 0) + 1;
    calls.set(key, count);
    return hlsResult(bjId, quality, count);
  };
  const cache = createSoopHlsCache({
    resolvers: { SD: resolver("SD"), HD: resolver("HD") },
    maxBjIds: 2,
  });

  await cache.get("bj_a", "SD");
  await cache.get("bj_a", "HD");
  await cache.get("bj_b", "SD");
  await cache.get("bj_a", "SD");
  await cache.get("bj_c", "SD");
  let snapshot = cache.getSnapshot();
  assert.equal(snapshot.bjCount, 2);
  assert.ok(snapshot.entryCount <= 4);
  assert.equal(snapshot.stats.evictions, 1);

  await cache.get("bj_b", "SD");
  assert.equal(calls.get("bj_b:SD"), 2);
  snapshot = cache.getSnapshot();
  assert.equal(snapshot.bjCount, 2);
  assert.ok(snapshot.entryCount <= 4);
});

test("resolver 오류와 잘못된 결과에서 URL·query·AID를 제거한다", async () => {
  const aid = "aid-secret-never-visible";
  const query = "query-secret-never-visible";
  const secretUrl = `https://live-pcweb-kr-cdn-z02.sooplive.com/live/list.m3u8?aid=${aid}&token=${query}`;
  const cache = createSoopHlsCache({
    resolvers: {
      SD: async () => {
        const error = new Error(`resolver failed ${secretUrl}`);
        error.url = secretUrl;
        throw error;
      },
      HD: async bjId => ({ ...hlsResult(bjId, "HD"), hlsUrl: `https://evil.invalid/?aid=${aid}` }),
    },
  });

  await assert.rejects(cache.get("error_bj", "SD"), error => {
    const visible = `${error.name} ${error.code} ${error.message} ${JSON.stringify(error)}`;
    assert.equal(visible.includes(aid), false);
    assert.equal(visible.includes(query), false);
    assert.equal(Object.hasOwn(error, "cause"), false);
    assert.equal(Object.hasOwn(error, "url"), false);
    return error.code === "resolve_failed";
  });
  await assert.rejects(cache.get("error_bj", "HD"), error => (
    error.code === "invalid_result" && !error.message.includes(aid)
  ));

  const visibleSnapshot = JSON.stringify(cache.getSnapshot());
  assert.equal(visibleSnapshot.includes(aid), false);
  assert.equal(visibleSnapshot.includes(query), false);
  assert.equal(visibleSnapshot.includes("https://"), false);
  assert.equal(cache.getSnapshot().stats.resolverErrors, 2);
});

test("안전한 resolver 상태 code만 고정 메시지로 보존하고 원본 오류는 폐기한다", async () => {
  const allowedCodes = [
    "not_live",
    "restricted_broadcast",
    "upstream_timeout",
    "upstream_error",
    "upstream_http",
    "invalid_response",
    "aborted",
  ];
  const aid = "resolver-aid-never-visible";
  const secretUrl = `https://live-pcweb-kr-cdn-z02.sooplive.com/live/list.m3u8?aid=${aid}`;
  const cache = createSoopHlsCache({
    resolvers: {
      SD: async (bjId) => {
        const code = bjId === "unknown_code"
          ? "internal_secret_code"
          : bjId === "resolver_invalid_result" ? "invalid_result" : bjId;
        const error = new Error(`resolver secret ${secretUrl}`);
        error.code = code;
        error.cause = new Error(secretUrl);
        error.url = secretUrl;
        throw error;
      },
      HD: async bjId => hlsResult(bjId, "HD"),
    },
  });

  for (const code of allowedCodes) {
    await assert.rejects(cache.get(code, "SD"), error => {
      const visible = `${error.name} ${error.code} ${error.message} ${JSON.stringify(error)}`;
      assert.equal(error.code, code);
      assert.equal(visible.includes(aid), false);
      assert.equal(Object.hasOwn(error, "cause"), false);
      assert.equal(Object.hasOwn(error, "url"), false);
      return true;
    });
  }

  await assert.rejects(cache.get("unknown_code", "SD"), error => (
    error.code === "resolve_failed"
    && !error.message.includes(aid)
    && !Object.hasOwn(error, "cause")
    && !Object.hasOwn(error, "url")
  ));
  await assert.rejects(cache.get("resolver_invalid_result", "SD"), error => (
    error.code === "resolve_failed" && !error.message.includes(aid)
  ));
});

test("이미 취소된 signal은 resolver와 cache state를 만들기 전에 거부한다", async () => {
  let calls = 0;
  const cache = createSoopHlsCache({
    resolvers: {
      SD: async bjId => {
        calls += 1;
        return hlsResult(bjId, "SD");
      },
      HD: async bjId => hlsResult(bjId, "HD"),
    },
  });
  const controller = new AbortController();
  controller.abort(new Error("cache-abort-reason-secret"));

  await assert.rejects(cache.get("abort_bj", "SD", { signal: controller.signal }), error => {
    const visible = `${error.name} ${error.code} ${error.message} ${JSON.stringify(error)}`;
    assert.equal(error.code, "aborted");
    assert.equal(visible.includes("cache-abort-reason-secret"), false);
    assert.equal(Object.hasOwn(error, "cause"), false);
    assert.equal(Object.hasOwn(error, "url"), false);
    return true;
  });
  assert.equal(calls, 0);
  assert.equal(cache.getSnapshot().entryCount, 0);
  assert.equal(cache.getSnapshot().pendingCount, 0);
});

test("get 직후 같은 tick 취소도 resolver 호출 없이 pending state를 정리한다", async () => {
  let calls = 0;
  const cache = createSoopHlsCache({
    resolvers: {
      SD: async bjId => {
        calls += 1;
        return hlsResult(bjId, "SD");
      },
      HD: async bjId => hlsResult(bjId, "HD"),
    },
  });
  const controller = new AbortController();
  const pending = cache.get("same_tick_abort", "SD", { signal: controller.signal });
  controller.abort(new Error("same-tick-secret"));

  await assert.rejects(pending, error => (
    error.code === "aborted" && !error.message.includes("same-tick-secret")
  ));
  assert.equal(calls, 0);
  assert.equal(cache.getSnapshot().entryCount, 0);
  assert.equal(cache.getSnapshot().pendingCount, 0);
});

test("최초 miss signal이 shared pending을 취소하고 실패 state를 제거한다", async () => {
  let calls = 0;
  let firstSignal;
  let releaseFirst;
  const cache = createSoopHlsCache({
    resolvers: {
      SD: (bjId, options) => {
        calls += 1;
        if (calls === 1) {
          firstSignal = options.signal;
          return new Promise(resolve => { releaseFirst = () => resolve(hlsResult(bjId, "SD", 1)); });
        }
        return Promise.resolve(hlsResult(bjId, "SD", calls));
      },
      HD: async bjId => hlsResult(bjId, "HD"),
    },
  });
  const controller = new AbortController();
  const first = cache.get("abort_shared", "SD", { signal: controller.signal });
  const deduped = cache.get("abort_shared", "SD");
  assert.equal(first, deduped);
  await Promise.resolve();
  assert.equal(calls, 1);
  controller.abort(new Error("shared-abort-secret"));

  for (const pending of [first, deduped]) {
    await assert.rejects(pending, error => (
      error.code === "aborted"
      && !error.message.includes("shared-abort-secret")
      && !Object.hasOwn(error, "cause")
      && !Object.hasOwn(error, "url")
    ));
  }
  assert.equal(firstSignal, controller.signal);
  assert.equal(firstSignal.aborted, true);
  assert.equal(cache.getSnapshot().entryCount, 0);
  assert.equal(cache.getSnapshot().pendingCount, 0);

  const fresh = await cache.get("abort_shared", "SD");
  assert.equal(calls, 2);
  assert.match(fresh.hlsUrl, /private-2$/);
  releaseFirst();
  await Promise.resolve();
  assert.equal(await cache.get("abort_shared", "SD"), fresh);
});

test("dedupe 후속 요청의 signal은 최초 요청이 소유한 shared pending을 취소하지 않는다", async () => {
  let release;
  let calls = 0;
  const cache = createSoopHlsCache({
    resolvers: {
      SD: bjId => new Promise(resolve => {
        calls += 1;
        release = () => resolve(hlsResult(bjId, "SD"));
      }),
      HD: async bjId => hlsResult(bjId, "HD"),
    },
  });
  const firstController = new AbortController();
  const secondController = new AbortController();
  const first = cache.get("dedupe_signal", "SD", { signal: firstController.signal });
  const second = cache.get("dedupe_signal", "SD", { signal: secondController.signal });
  assert.equal(first, second);
  await Promise.resolve();
  secondController.abort();
  release();

  const [left, right] = await Promise.all([first, second]);
  assert.equal(left, right);
  assert.equal(calls, 1);
  assert.equal(cache.getSnapshot().cachedCount, 1);
});
