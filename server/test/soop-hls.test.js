const test = require("node:test");
const assert = require("node:assert/strict");
const {
  SoopHlsError,
  createSoopHlsResolver,
  resolveSoopHls,
} = require("../lib/soop-hls");

function jsonResponse(body, options = {}) {
  return new Response(JSON.stringify(body), {
    status: options.status || 200,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
}

function publicFlowFetch(options = {}) {
  const calls = [];
  const aid = options.aid || "private-aid&part=two";
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    switch (calls.length) {
      case 1:
        return jsonResponse({
          broad: {
            broad_no: 296022399,
            is_password: false,
            subscription_only: 0,
            broad_grade: 0,
          },
        });
      case 2:
        return jsonResponse({
          CHANNEL: {
            RESULT: 1,
            BNO: "296022399",
            RMD: "https://livestream-manager.sooplive.com",
            CDN: options.cdn || "lg_cdn",
          },
        });
      case 3:
        return jsonResponse({ CHANNEL: { RESULT: "1", AID: aid } });
      case 4:
        return jsonResponse({
          result: "1",
          view_url: "https://live-pcweb-kr-cdn-z02.sooplive.com/live/stream/playlist.m3u8?edge=kr",
        });
      default:
        throw new Error("unexpected fetch");
    }
  };
  return { aid, calls, fetchImpl };
}

test("공개 LIVE를 공식 player 흐름으로 HLS URL까지 해석한다", async () => {
  const flow = publicFlowFetch();
  const resolve = createSoopHlsResolver({ fetchImpl: flow.fetchImpl, random: () => 0.25 });
  const result = await resolve("devil0108");

  assert.deepEqual(Object.keys(result).sort(), ["bjId", "broadNo", "hlsUrl", "quality"]);
  assert.equal(result.bjId, "devil0108");
  assert.equal(result.broadNo, "296022399");
  assert.equal(result.quality, "HD");
  const hlsUrl = new URL(result.hlsUrl);
  assert.equal(hlsUrl.protocol, "https:");
  assert.equal(hlsUrl.pathname, "/live/stream/playlist.m3u8");
  assert.equal(hlsUrl.searchParams.get("edge"), "kr");
  assert.equal(hlsUrl.searchParams.get("aid"), flow.aid);

  assert.equal(flow.calls.length, 4);
  assert.equal(new URL(flow.calls[0].url).hostname, "chapi.sooplive.co.kr");
  assert.equal(flow.calls[0].init.method, "GET");
  for (const call of flow.calls) {
    assert.equal(call.init.credentials, "omit");
    assert.equal(Object.keys(call.init.headers).some(name => name.toLowerCase() === "cookie"), false);
    assert.ok(call.init.signal instanceof AbortSignal);
  }

  for (const [index, expectedType] of [[1, "live"], [2, "aid"]]) {
    const call = flow.calls[index];
    const url = new URL(call.url);
    const body = new URLSearchParams(call.init.body);
    assert.equal(url.hostname, "live.sooplive.com");
    assert.equal(url.pathname, "/afreeca/player_live_api.php");
    assert.equal(url.searchParams.get("bjid"), "devil0108");
    assert.equal(call.init.method, "POST");
    assert.equal(body.get("type"), expectedType);
    assert.equal(body.get("quality"), "HD");
    assert.equal(body.get("stream_type"), "common");
    assert.equal(body.get("player_type"), "html5");
    assert.equal(body.get("pwd"), "");
  }

  const assign = new URL(flow.calls[3].url);
  assert.equal(assign.hostname, "livestream-manager.sooplive.com");
  assert.equal(assign.pathname, "/broad_stream_assign.html");
  assert.equal(assign.searchParams.get("broad_key"), "296022399-common-hd-hls");
  assert.equal(assign.searchParams.get("return_type"), "lg_cdn_pc_web");
  assert.equal(assign.searchParams.get("use_cors"), "true");
  assert.equal(assign.searchParams.get("cors_origin_url"), "play.sooplive.com");
  assert.equal(assign.searchParams.get("time"), "2500");
  assert.equal(assign.searchParams.has("aid"), false);
});

test("SD 품질을 player 요청과 broad_key 및 결과에 일관되게 반영한다", async () => {
  const flow = publicFlowFetch();
  const result = await resolveSoopHls("devil0108", {
    fetchImpl: flow.fetchImpl,
    quality: "SD",
    random: () => 0,
  });

  assert.equal(result.quality, "SD");
  assert.equal(new URLSearchParams(flow.calls[1].init.body).get("quality"), "SD");
  assert.equal(new URLSearchParams(flow.calls[2].init.body).get("quality"), "SD");
  assert.equal(
    new URL(flow.calls[3].url).searchParams.get("broad_key"),
    "296022399-common-sd-hls",
  );
});

test("ORIGINAL 품질은 1080p 원본 broad_key를 요청한다", async () => {
  const flow = publicFlowFetch();
  const result = await resolveSoopHls("devil0108", {
    fetchImpl: flow.fetchImpl,
    quality: "ORIGINAL",
    random: () => 0,
  });

  assert.equal(result.quality, "ORIGINAL");
  assert.equal(new URLSearchParams(flow.calls[1].init.body).get("quality"), "ORIGINAL");
  assert.equal(new URLSearchParams(flow.calls[2].init.body).get("quality"), "ORIGINAL");
  assert.equal(
    new URL(flow.calls[3].url).searchParams.get("broad_key"),
    "296022399-common-original-hls",
  );
});

test("지원하지 않는 품질은 fetch 전에 거부한다", async () => {
  let fetchCount = 0;
  const fetchImpl = async () => {
    fetchCount += 1;
    return jsonResponse({ broad: null });
  };

  for (const quality of ["sd", "4K", "", 1, null]) {
    assert.throws(
      () => createSoopHlsResolver({ fetchImpl, quality }),
      error => error instanceof SoopHlsError && error.code === "invalid_config",
    );
  }
  assert.equal(fetchCount, 0);
});

test("GS CDN은 공식 PC web return_type으로 변환한다", async () => {
  const flow = publicFlowFetch({ cdn: "gs_cdn" });
  await resolveSoopHls("devil0108", { fetchImpl: flow.fetchImpl, random: () => 0 });

  assert.equal(new URL(flow.calls[3].url).searchParams.get("return_type"), "gs_cdn_pc_web");
});

test("BJ ID를 fetch 전에 검증하고 방송 종료·제한 방송을 구분한다", async () => {
  let fetchCount = 0;
  const resolver = createSoopHlsResolver({
    fetchImpl: async () => {
      fetchCount += 1;
      return jsonResponse({ broad: null });
    },
  });
  await assert.rejects(resolver("../invalid"), error => (
    error instanceof SoopHlsError && error.code === "invalid_bj_id"
  ));
  assert.equal(fetchCount, 0);
  await assert.rejects(resolver("valid_bj"), error => error.code === "not_live");
  assert.equal(fetchCount, 1);

  const restricted = createSoopHlsResolver({
    fetchImpl: async () => jsonResponse({
      broad: { broad_no: 1, is_password: true, subscription_only: 0, broad_grade: 0 },
    }),
  });
  await assert.rejects(restricted("valid_bj"), error => error.code === "restricted_broadcast");
});

test("응답 크기 제한과 timeout을 단계 정보만으로 보고한다", async () => {
  const tooLarge = createSoopHlsResolver({
    maxResponseBytes: 128,
    fetchImpl: async () => new Response("x", {
      status: 200,
      headers: { "Content-Length": "129", "Content-Type": "application/json" },
    }),
  });
  await assert.rejects(tooLarge("valid_bj"), error => (
    error.code === "response_too_large" && error.stage === "station"
  ));

  const streamedTooLarge = createSoopHlsResolver({
    maxResponseBytes: 128,
    fetchImpl: async () => new Response("x".repeat(129), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  });
  await assert.rejects(streamedTooLarge("valid_bj"), error => (
    error.code === "response_too_large" && error.stage === "station"
  ));

  const timeout = createSoopHlsResolver({
    timeoutMs: 10,
    fetchImpl: async (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }),
  });
  await assert.rejects(timeout("valid_bj"), error => (
    error.code === "upstream_timeout" && error.stage === "station"
  ));
});

test("upstream 오류에는 AID나 URL query를 보관하거나 노출하지 않는다", async () => {
  const secret = "aid-secret-never-log";
  const querySecret = "query-secret-never-log";
  const flow = publicFlowFetch({ aid: secret });
  const normalFetch = flow.fetchImpl;
  const resolver = createSoopHlsResolver({
    fetchImpl: async (url, init) => {
      if (flow.calls.length === 3) {
        flow.calls.push({ url: String(url), init });
        throw new Error(`network failed: https://example.invalid/live.m3u8?aid=${secret}&token=${querySecret}`);
      }
      return normalFetch(url, init);
    },
  });

  await assert.rejects(resolver("valid_bj"), error => {
    const visible = `${error.name} ${error.code} ${error.stage} ${error.message} ${JSON.stringify(error)}`;
    assert.equal(visible.includes(secret), false);
    assert.equal(visible.includes(querySecret), false);
    assert.equal(Object.hasOwn(error, "cause"), false);
    assert.equal(Object.hasOwn(error, "url"), false);
    return error.code === "upstream_error" && error.stage === "assign";
  });
});

test("RMD와 view_url은 인증정보 없는 SOOP HTTPS URL만 허용한다", async () => {
  const unsafeRmd = publicFlowFetch();
  unsafeRmd.fetchImpl = async (url, init) => {
    unsafeRmd.calls.push({ url: String(url), init });
    if (unsafeRmd.calls.length === 1) return jsonResponse({ broad: { broad_no: 1 } });
    return jsonResponse({ CHANNEL: { RESULT: 1, BNO: "1", RMD: "http://localhost:8080?token=hidden", CDN: "lg_cdn" } });
  };
  await assert.rejects(
    resolveSoopHls("valid_bj", { fetchImpl: unsafeRmd.fetchImpl }),
    error => error.code === "invalid_response" && !error.message.includes("hidden"),
  );

  const unsafeView = publicFlowFetch();
  const normalFetch = unsafeView.fetchImpl;
  unsafeView.fetchImpl = async (url, init) => {
    if (unsafeView.calls.length === 3) {
      unsafeView.calls.push({ url: String(url), init });
      return jsonResponse({ result: 1, view_url: "https://user:pass@evil.invalid/live.m3u8?token=hidden" });
    }
    return normalFetch(url, init);
  };
  await assert.rejects(
    resolveSoopHls("valid_bj", { fetchImpl: unsafeView.fetchImpl }),
    error => error.code === "invalid_response" && !error.message.includes("hidden"),
  );
});

test("이미 취소된 signal은 fetch 전에 고정 aborted 오류로 거부한다", async () => {
  let fetchCount = 0;
  const controller = new AbortController();
  controller.abort(new Error("abort-reason-secret"));
  const resolver = createSoopHlsResolver({
    fetchImpl: async () => {
      fetchCount += 1;
      return jsonResponse({ broad: null });
    },
  });

  await assert.rejects(resolver("valid_bj", { signal: controller.signal }), error => {
    const visible = `${error.name} ${error.code} ${error.stage} ${error.message} ${JSON.stringify(error)}`;
    assert.equal(error.code, "aborted");
    assert.equal(visible.includes("abort-reason-secret"), false);
    assert.equal(Object.hasOwn(error, "cause"), false);
    assert.equal(Object.hasOwn(error, "url"), false);
    return true;
  });
  assert.equal(fetchCount, 0);
});

test("실행 중 취소는 현재 fetch controller를 중단하고 민감정보를 버린다", async () => {
  const secret = "abort-upstream-aid-secret";
  let internalSignal;
  let markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  const resolver = createSoopHlsResolver({
    fetchImpl: async (_url, init) => new Promise((_resolve, reject) => {
      internalSignal = init.signal;
      markStarted();
      init.signal.addEventListener("abort", () => {
        reject(new Error(`fetch aborted https://sooplive.com/live.m3u8?aid=${secret}`));
      }, { once: true });
    }),
  });
  const controller = new AbortController();
  const pending = resolver("valid_bj", { signal: controller.signal });
  await started;
  controller.abort(new Error(secret));

  await assert.rejects(pending, error => {
    const visible = `${error.name} ${error.code} ${error.stage} ${error.message} ${JSON.stringify(error)}`;
    assert.equal(error.code, "aborted");
    assert.equal(error.stage, "station");
    assert.equal(visible.includes(secret), false);
    assert.equal(Object.hasOwn(error, "cause"), false);
    assert.equal(Object.hasOwn(error, "url"), false);
    return true;
  });
  assert.equal(internalSignal.aborted, true);
});

test("resolver 생성 옵션과 호출 signal을 strict하게 검증한다", async () => {
  let fetchCount = 0;
  const fetchImpl = async () => {
    fetchCount += 1;
    return jsonResponse({ broad: null });
  };
  assert.throws(
    () => createSoopHlsResolver({ fetchImpl, unexpected: true }),
    error => error.code === "invalid_config",
  );
  const resolver = createSoopHlsResolver({ fetchImpl });
  const forgedSignal = Object.create(AbortSignal.prototype);
  const accessorOptions = {};
  Object.defineProperty(accessorOptions, "signal", {
    enumerable: true,
    get() {
      throw new Error("resolver-options-getter-secret");
    },
  });
  for (const options of [null, { signal: {} }, { signal: forgedSignal }, { unexpected: true }, accessorOptions]) {
    await assert.rejects(
      resolver("valid_bj", options),
      error => error.code === "invalid_config" && !error.message.includes("getter-secret"),
    );
  }
  const controller = new AbortController();
  controller.abort(new Error("resolver-proxy-secret"));
  const proxyOptions = new Proxy({ signal: controller.signal }, {
    get() {
      throw new Error("resolver-proxy-secret");
    },
  });
  await assert.rejects(resolver("valid_bj", proxyOptions), error => (
    error.code === "aborted" && !error.message.includes("proxy-secret")
  ));
  await assert.rejects(
    resolveSoopHls("valid_bj", { fetchImpl, signal: {} }),
    error => error.code === "invalid_config",
  );
  assert.equal(fetchCount, 0);
});
