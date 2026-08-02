"use strict";

const crypto = require("node:crypto");
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  DEFAULT_MAX_BATCH_BYTES,
  DEFAULT_MAX_SEGMENTS,
  SoopHlsFrameError,
  buildSoopHlsFrameFfmpegInput,
  buildSoopMpegTsFrameFfmpegInput,
  createSoopHlsFrameFetcher,
  createSoopHlsFrameSegmentBatchFetcher,
  createSoopHlsFrameSegmentFetcher,
  fetchSoopHlsFramePlaylist,
  fetchSoopHlsFrameSegment,
  parseSoopHlsMediaPlaylist,
} = require("../lib/soop-hls-frame");

const PLAYLIST_URL = "https://live-pcweb-kr-cdn-z02.sooplive.com/live/channel/playlist.m3u8?aid=aid-private";

function segmentIdForTest(segmentUri, playlistUrl = PLAYLIST_URL) {
  const url = new URL(segmentUri, playlistUrl);
  url.hash = "";
  return crypto.createHash("sha256").update(url.toString(), "utf8").digest("hex");
}

function mediaPlaylist(segmentUris, mediaSequence = 0) {
  return [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    `#EXT-X-MEDIA-SEQUENCE:${mediaSequence}`,
    "#EXT-X-TARGETDURATION:2",
    ...segmentUris.flatMap(uri => ["#EXTINF:2.0,", uri]),
    "",
  ].join("\n");
}

function chunkedResponse(chunks, options = {}) {
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(Buffer.from(chunk));
      controller.close();
    },
  });
  return {
    ok: options.status === undefined || (options.status >= 200 && options.status < 300),
    status: options.status || 200,
    url: options.url || "",
    headers: new Headers(options.headers || {}),
    body,
  };
}

function assertOrderedArgs(args, expected) {
  let cursor = 0;
  for (const value of expected) {
    const index = args.indexOf(value, cursor);
    assert.notEqual(index, -1, `missing ffmpeg arg: ${value}`);
    cursor = index + 1;
  }
}

test("마지막 완성 segment만 절대 URL인 finite media playlist로 만든다", () => {
  const media = [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    "#EXT-X-MEDIA-SEQUENCE:410",
    "#EXT-X-TARGETDURATION:7",
    "#EXTINF:6.006,first",
    "segments/410.ts?token=old-token",
    "#EXTINF:5.500,last complete",
    "../media/411.ts?token=segment-secret",
    "#EXT-X-PART:DURATION=0.5,URI=\"ignored-part.ts\"",
    "#EXTINF:4.000,incomplete",
    "",
  ].join("\r\n");

  const finite = parseSoopHlsMediaPlaylist(media, PLAYLIST_URL);
  assert.equal(finite, [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    "#EXT-X-TARGETDURATION:7",
    "#EXT-X-MEDIA-SEQUENCE:411",
    "#EXTINF:5.500,last complete",
    "https://live-pcweb-kr-cdn-z02.sooplive.com/live/media/411.ts?token=segment-secret",
    "#EXT-X-ENDLIST",
    "",
  ].join("\n"));
  assert.equal((finite.match(/^#EXTINF:/gm) || []).length, 1);
});

test("임의 chunk 경계의 playlist와 마지막 segment body를 Node에서 제한 fetch한다", async () => {
  const segment = Buffer.from([0x47, 0x40, 0x00, 0x10, 0x47, 0x40, 0x01, 0x10]);
  const media = [
    "#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:9\n#EXT-X-VERSION:3\n",
    "#EXT-X-TARGETDURATION:6\n#EXTINF:5.9,\nold/9.ts\n#EXTINF:5.8,\n",
    "latest/10.ts?segment_token=private\n",
  ];
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    if (calls.length === 1) return chunkedResponse(media);
    if (calls.length === 2) return chunkedResponse([segment.subarray(0, 3), segment.subarray(3, 7), segment.subarray(7)]);
    throw new Error("unexpected fetch");
  };

  const fetched = await fetchSoopHlsFrameSegment(PLAYLIST_URL, {
    fetchImpl,
    timeoutMs: 100,
    maxResponseBytes: 1_024,
    maxSegmentBytes: 1_024,
  });
  assert.deepEqual(fetched, segment);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.init.method, "GET");
    assert.equal(call.init.credentials, "omit");
    assert.equal(call.init.redirect, "manual");
    assert.ok(call.init.signal instanceof AbortSignal);
    assert.equal(call.init.headers.Origin, "https://play.sooplive.com");
    assert.equal(call.init.headers.Referer, "https://play.sooplive.com/");
    assert.match(call.init.headers["User-Agent"], /^Mozilla\/5\.0/);
    assert.equal(Object.keys(call.init.headers).some(name => name.toLowerCase() === "cookie"), false);
  }
  assert.match(calls[0].init.headers.Accept, /mpegurl/i);
  assert.match(calls[1].init.headers.Accept, /video\/mp2t/i);
});

test("batch 최초 호출은 지정한 최근 segment만 순서대로 안전한 ID·sequence와 반환한다", async () => {
  const uris = Array.from({ length: 6 }, (_value, index) => (
    `segments/${100 + index}.ts?segment_token=private-${index}`
  ));
  const playlist = mediaPlaylist(uris, 700);
  const calls = [];
  const fetchBatch = createSoopHlsFrameSegmentBatchFetcher({
    fetchImpl: async (url, init) => {
      const parsed = new URL(url);
      calls.push({ url: parsed.toString(), init });
      if (parsed.pathname.endsWith(".m3u8")) return chunkedResponse([playlist]);
      return chunkedResponse([`body-${parsed.pathname.split("/").pop()}`]);
    },
    maxResponseBytes: 4_096,
    maxSegmentBytes: 1_024,
  });

  const result = await fetchBatch(PLAYLIST_URL, { initialSegmentCount: 2 });
  assert.equal(DEFAULT_MAX_SEGMENTS, 6);
  assert.equal(DEFAULT_MAX_BATCH_BYTES, 32 * 1024 * 1024);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(result.length, 2);
  assert.deepEqual(result.map(item => item.mediaSequence), [704, 705]);
  assert.deepEqual(
    result.map(item => item.segmentId),
    uris.slice(-2).map(uri => segmentIdForTest(uri)),
  );
  assert.deepEqual(result.map(item => item.body.toString()), ["body-104.ts", "body-105.ts"]);
  for (const item of result) {
    assert.deepEqual(Object.keys(item).sort(), ["body", "mediaSequence", "segmentId"]);
    assert.match(item.segmentId, /^[0-9a-f]{64}$/);
    assert.equal(Number.isSafeInteger(item.mediaSequence), true);
    assert.equal(Object.isFrozen(item), true);
  }
  const visible = JSON.stringify(result);
  assert.equal(visible.includes("https://"), false);
  assert.equal(visible.includes("aid-private"), false);
  assert.equal(visible.includes("segment_token"), false);
  assert.equal(calls.length, 3);
  assert.match(calls[0].init.headers.Accept, /mpegurl/i);
  assert.match(calls[1].init.headers.Accept, /video\/mp2t/i);
});

test("batch cursor 이후만 읽고 최신 cursor면 빈 배열, 회전 시 initial 개수로 재기준한다", async () => {
  const uris = Array.from({ length: 8 }, (_value, index) => `segments/${index}.ts?token=${index}`);
  const playlist = mediaPlaylist(uris, 410);
  const segmentCalls = [];
  const fetchBatch = createSoopHlsFrameSegmentBatchFetcher({
    maxSegments: 3,
    maxResponseBytes: 4_096,
    maxSegmentBytes: 1_024,
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith(".m3u8")) return chunkedResponse([playlist]);
      segmentCalls.push(parsed.pathname);
      return chunkedResponse([parsed.pathname.split("/").pop()]);
    },
  });

  const afterMiddle = await fetchBatch(PLAYLIST_URL, {
    afterSegmentId: segmentIdForTest(uris[2]),
  });
  assert.deepEqual(afterMiddle.map(item => item.mediaSequence), [415, 416, 417]);
  assert.deepEqual(segmentCalls.splice(0), [
    "/live/channel/segments/5.ts",
    "/live/channel/segments/6.ts",
    "/live/channel/segments/7.ts",
  ]);

  const noNewSegments = await fetchBatch(PLAYLIST_URL, {
    afterSegmentId: segmentIdForTest(uris[7]),
  });
  assert.deepEqual(noNewSegments, []);
  assert.deepEqual(segmentCalls, []);

  const rotated = await fetchBatch(PLAYLIST_URL, {
    afterSegmentId: "0".repeat(64),
    initialSegmentCount: 2,
  });
  assert.deepEqual(rotated.map(item => item.mediaSequence), [416, 417]);

  const defaultInitial = await fetchBatch(PLAYLIST_URL);
  assert.deepEqual(defaultInitial.map(item => item.mediaSequence), [417]);

  const zeroInitial = await fetchBatch(PLAYLIST_URL, { initialSegmentCount: 0 });
  assert.deepEqual(zeroInitial, []);
});

test("batch는 12개 상한과 순차 fetch를 지켜 90-stream 부하 증폭을 제한한다", async () => {
  const uris = Array.from({ length: 30 }, (_value, index) => `load/${index}.ts`);
  const playlist = mediaPlaylist(uris, 1_000);
  let fetchCalls = 0;
  let activeSegments = 0;
  let maxActiveSegments = 0;
  const fetchBatch = createSoopHlsFrameSegmentBatchFetcher({
    maxSegments: 12,
    maxResponseBytes: 8_192,
    maxSegmentBytes: 1_024,
    fetchImpl: async (url) => {
      fetchCalls += 1;
      const parsed = new URL(url);
      if (parsed.pathname.endsWith(".m3u8")) return chunkedResponse([playlist]);
      activeSegments += 1;
      maxActiveSegments = Math.max(maxActiveSegments, activeSegments);
      await new Promise(resolve => setImmediate(resolve));
      activeSegments -= 1;
      return chunkedResponse([parsed.pathname]);
    },
  });

  const result = await fetchBatch(PLAYLIST_URL, {
    afterSegmentId: segmentIdForTest(uris[0]),
  });
  assert.equal(result.length, 12);
  assert.deepEqual(result.map(item => item.mediaSequence), Array.from({ length: 12 }, (_v, i) => 1_018 + i));
  assert.equal(fetchCalls, 13);
  assert.equal(maxActiveSegments, 1);
});

test("batch segment ID는 playlist URL 기준이며 공식 redirect 뒤에도 바뀌지 않는다", async () => {
  const uri = "origin/7.ts?aid=segment-secret#ignored-fragment";
  const playlist = mediaPlaylist([uri], 77);
  let calls = 0;
  const fetchBatch = createSoopHlsFrameSegmentBatchFetcher({
    maxResponseBytes: 1_024,
    maxSegmentBytes: 1_024,
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) return chunkedResponse([playlist]);
      if (calls === 2) {
        return chunkedResponse([], {
          status: 302,
          headers: { Location: "/redirected/7.ts?token=redirect-secret" },
        });
      }
      return chunkedResponse(["redirected-body"]);
    },
  });

  const result = await fetchBatch(PLAYLIST_URL);
  assert.equal(result[0].segmentId, segmentIdForTest(uri));
  assert.equal(result[0].mediaSequence, 77);
  assert.equal(result[0].body.toString(), "redirected-body");
  assert.equal(calls, 3);
  assert.equal(JSON.stringify(result).includes("redirect-secret"), false);
});

test("playlist 응답 상한과 timeout은 민감정보 없는 안전 오류로 반환한다", async () => {
  const aid = "aid-must-not-leak";
  const source = `https://live-pcweb-kr-cdn-z02.sooplive.com/live/playlist.m3u8?aid=${aid}`;
  const tooLarge = createSoopHlsFrameFetcher({
    maxResponseBytes: 128,
    fetchImpl: async () => chunkedResponse(["x"], { headers: { "Content-Length": "129" } }),
  });
  await assert.rejects(tooLarge(source), error => {
    const visible = `${error.name} ${error.code} ${error.stage} ${error.message} ${JSON.stringify(error)}`;
    return error.code === "response_too_large" && error.stage === "playlist" && !visible.includes(aid);
  });

  const timeout = createSoopHlsFrameFetcher({
    timeoutMs: 10,
    fetchImpl: async (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => {
        reject(new Error(`aborted ${source}`));
      }, { once: true });
    }),
  });
  await assert.rejects(timeout(source), error => {
    const visible = `${error.name} ${error.code} ${error.stage} ${error.message} ${JSON.stringify(error)}`;
    return error.code === "upstream_timeout" && error.stage === "playlist" && !visible.includes(aid);
  });
});

test("비공식 source·redirect·segment URL을 fetch 전 또는 parse 단계에서 차단한다", async () => {
  let fetchCount = 0;
  const fetcher = createSoopHlsFrameFetcher({
    fetchImpl: async () => {
      fetchCount += 1;
      return chunkedResponse([]);
    },
  });
  await assert.rejects(
    fetcher("https://evil.invalid/live.m3u8?aid=source-secret"),
    error => error instanceof SoopHlsFrameError && error.code === "invalid_hls_url",
  );
  assert.equal(fetchCount, 0);

  let redirectFetchCount = 0;
  const redirected = createSoopHlsFrameFetcher({
    fetchImpl: async () => {
      redirectFetchCount += 1;
      return chunkedResponse([], {
        status: 302,
        headers: { Location: "https://evil.invalid/redirect.m3u8?token=redirect-secret" },
      });
    },
  });
  await assert.rejects(redirected(PLAYLIST_URL), error => (
    error.code === "invalid_hls_url" && !error.message.includes("redirect-secret")
  ));
  assert.equal(redirectFetchCount, 1);

  const malicious = [
    "#EXTM3U",
    "#EXT-X-TARGETDURATION:6",
    "#EXT-X-MEDIA-SEQUENCE:1",
    "#EXTINF:5.0,",
    "https://evil.invalid/1.ts?aid=segment-aid-secret",
    "",
  ].join("\n");
  assert.throws(
    () => parseSoopHlsMediaPlaylist(malicious, PLAYLIST_URL),
    error => error.code === "unsafe_segment_url" && !error.message.includes("segment-aid-secret"),
  );
});

test("공식 redirect만 최대 3회 따라가고 그 이상은 요청하지 않는다", async () => {
  const validMedia = [
    "#EXTM3U",
    "#EXT-X-TARGETDURATION:6",
    "#EXTINF:5.0,",
    "segment.ts",
    "",
  ].join("\n");
  let validCalls = 0;
  const redirected = createSoopHlsFrameFetcher({
    fetchImpl: async () => {
      validCalls += 1;
      if (validCalls <= 3) {
        return chunkedResponse([], {
          status: 302,
          headers: { Location: `/redirect/${validCalls}.m3u8` },
        });
      }
      return chunkedResponse([validMedia]);
    },
  });
  const finite = await redirected(PLAYLIST_URL);
  assert.match(finite, /#EXT-X-ENDLIST\n$/);
  assert.equal(validCalls, 4);

  let excessiveCalls = 0;
  const excessive = createSoopHlsFrameFetcher({
    fetchImpl: async () => {
      excessiveCalls += 1;
      return chunkedResponse([], {
        status: 307,
        headers: { Location: `/redirect/${excessiveCalls}.m3u8` },
      });
    },
  });
  await assert.rejects(excessive(PLAYLIST_URL), error => (
    error.code === "upstream_http" && error.stage === "playlist"
  ));
  assert.equal(excessiveCalls, 4);
});

test("upstream 예외의 HLS URL·query·AID를 오류 객체에 보관하지 않는다", async () => {
  const aid = "private-aid-never-visible";
  const token = "private-query-never-visible";
  const source = `https://live-pcweb-kr-cdn-z02.sooplive.com/live/list.m3u8?aid=${aid}&token=${token}`;
  const fetcher = createSoopHlsFrameFetcher({
    fetchImpl: async () => {
      const error = new Error(`network failed ${source}`);
      error.url = source;
      throw error;
    },
  });

  await assert.rejects(fetcher(source), error => {
    const visible = `${error.name} ${error.code} ${error.stage} ${error.message} ${JSON.stringify(error)}`;
    assert.equal(visible.includes(aid), false);
    assert.equal(visible.includes(token), false);
    assert.equal(Object.hasOwn(error, "cause"), false);
    assert.equal(Object.hasOwn(error, "url"), false);
    return error.code === "upstream_error" && error.stage === "playlist";
  });
});

test("finite playlist는 stdin에만 두고 HLS ffmpeg argv는 고정한다", () => {
  const token = "hls-argv-secret";
  const finite = [
    "#EXTM3U",
    "#EXT-X-TARGETDURATION:6",
    "#EXT-X-MEDIA-SEQUENCE:10",
    "#EXTINF:5.8,",
    `https://live-pcweb-kr-cdn-z02.sooplive.com/live/10.ts?aid=${token}`,
    "#EXT-X-ENDLIST",
    "",
  ].join("\n");
  const input = buildSoopHlsFrameFfmpegInput(finite);

  assert.deepEqual(input.stdin, Buffer.from(finite));
  assertOrderedArgs(input.args, [
    "-threads", "1",
    "-skip_frame", "nokey",
    "-f", "hls",
    "-i", "pipe:0",
    "-vf", "scale=48:27:flags=fast_bilinear",
    "-pix_fmt", "gray",
    "-frames:v", "1",
    "-f", "rawvideo",
    "pipe:1",
  ]);
  const argv = input.args.join(" ");
  assert.equal(argv.includes(token), false);
  assert.equal(input.args.some(value => value.includes("://")), false);

  const malicious = finite.replace(
    "https://live-pcweb-kr-cdn-z02.sooplive.com/live/10.ts",
    "https://evil.invalid/live/10.ts",
  );
  assert.throws(
    () => buildSoopHlsFrameFfmpegInput(malicious),
    error => error.code === "invalid_ffmpeg_input" && !error.message.includes(token),
  );
});

test("MPEG-TS segment도 Buffer stdin에만 두고 URL 없는 argv를 만든다", () => {
  const segment = Buffer.from("mpegts bytes with aid=stdin-only-token");
  const input = buildSoopMpegTsFrameFfmpegInput(segment);

  assert.deepEqual(input.stdin, segment);
  assert.notEqual(input.stdin, segment);
  assertOrderedArgs(input.args, [
    "-threads", "1",
    "-skip_frame", "nokey",
    "-f", "mpegts",
    "-i", "pipe:0",
    "-vf", "scale=48:27:flags=fast_bilinear",
    "-pix_fmt", "gray",
    "-frames:v", "1",
    "-f", "rawvideo",
    "pipe:1",
  ]);
  assert.equal(input.args.join(" ").includes("stdin-only-token"), false);
  assert.equal(input.args.some(value => value.includes("://")), false);
});

test("이미 취소된 signal은 playlist와 segment fetch 전에 고정 오류로 거부한다", async () => {
  let fetchCount = 0;
  const fetchImpl = async () => {
    fetchCount += 1;
    return chunkedResponse([]);
  };
  const playlistFetcher = createSoopHlsFrameFetcher({ fetchImpl });
  const segmentFetcher = createSoopHlsFrameSegmentFetcher({ fetchImpl });
  const controller = new AbortController();
  controller.abort(new Error("abort-frame-secret"));

  for (const run of [
    () => playlistFetcher(PLAYLIST_URL, { signal: controller.signal }),
    () => segmentFetcher(PLAYLIST_URL, { signal: controller.signal }),
    () => fetchSoopHlsFramePlaylist(PLAYLIST_URL, { fetchImpl, signal: controller.signal }),
  ]) {
    await assert.rejects(run(), error => {
      const visible = `${error.name} ${error.code} ${error.stage} ${error.message} ${JSON.stringify(error)}`;
      assert.equal(error.code, "aborted");
      assert.equal(visible.includes("abort-frame-secret"), false);
      assert.equal(Object.hasOwn(error, "cause"), false);
      assert.equal(Object.hasOwn(error, "url"), false);
      return true;
    });
  }
  assert.equal(fetchCount, 0);
});

test("실행 중 playlist 취소는 내부 fetch controller까지 중단한다", async () => {
  const secret = "playlist-abort-aid-secret";
  let internalSignal;
  let markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  const fetcher = createSoopHlsFrameFetcher({
    timeoutMs: 100,
    fetchImpl: async (_url, init) => new Promise((_resolve, reject) => {
      internalSignal = init.signal;
      markStarted();
      init.signal.addEventListener("abort", () => reject(new Error(secret)), { once: true });
    }),
  });
  const controller = new AbortController();
  const pending = fetcher(PLAYLIST_URL, { signal: controller.signal });
  await started;
  controller.abort(new Error(secret));

  await assert.rejects(pending, error => {
    const visible = `${error.name} ${error.code} ${error.stage} ${error.message} ${JSON.stringify(error)}`;
    assert.equal(error.code, "aborted");
    assert.equal(error.stage, "playlist");
    assert.equal(visible.includes(secret), false);
    return true;
  });
  assert.equal(internalSignal.aborted, true);
});

test("segment 요청 중 취소도 해당 fetch controller를 중단한다", async () => {
  const media = [
    "#EXTM3U",
    "#EXT-X-TARGETDURATION:6",
    "#EXTINF:5.0,",
    "latest.ts?token=segment-abort-secret",
    "",
  ].join("\n");
  let calls = 0;
  let segmentSignal;
  let markSegmentStarted;
  const segmentStarted = new Promise(resolve => { markSegmentStarted = resolve; });
  const fetcher = createSoopHlsFrameSegmentFetcher({
    timeoutMs: 100,
    fetchImpl: async (_url, init) => {
      calls += 1;
      if (calls === 1) return chunkedResponse([media]);
      segmentSignal = init.signal;
      markSegmentStarted();
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("segment-upstream-secret")), { once: true });
      });
    },
  });
  const controller = new AbortController();
  const pending = fetcher(PLAYLIST_URL, { signal: controller.signal });
  await segmentStarted;
  controller.abort(new Error("segment-abort-secret"));

  await assert.rejects(pending, error => (
    error.code === "aborted"
    && error.stage === "segment"
    && !error.message.includes("segment-abort-secret")
    && !Object.hasOwn(error, "cause")
    && !Object.hasOwn(error, "url")
  ));
  assert.equal(segmentSignal.aborted, true);
});

test("frame 생성 옵션과 호출 signal을 strict하게 검증한다", async () => {
  let fetchCount = 0;
  const fetchImpl = async () => {
    fetchCount += 1;
    return chunkedResponse([]);
  };
  assert.throws(
    () => createSoopHlsFrameFetcher({ fetchImpl, maxSegmentBytes: 1_024 }),
    error => error.code === "invalid_config",
  );
  assert.throws(
    () => createSoopHlsFrameSegmentFetcher({ fetchImpl, unexpected: true }),
    error => error.code === "invalid_config",
  );
  const fetcher = createSoopHlsFrameFetcher({ fetchImpl });
  const forgedSignal = Object.create(AbortSignal.prototype);
  const accessorOptions = {};
  Object.defineProperty(accessorOptions, "signal", {
    enumerable: true,
    get() {
      throw new Error("frame-options-getter-secret");
    },
  });
  for (const options of [null, { signal: {} }, { signal: forgedSignal }, { unexpected: true }, accessorOptions]) {
    await assert.rejects(
      fetcher(PLAYLIST_URL, options),
      error => (
        error.code === "invalid_config"
        && error.stage === "config"
        && !error.message.includes("getter-secret")
      ),
    );
  }
  const controller = new AbortController();
  controller.abort(new Error("frame-proxy-secret"));
  const proxyOptions = new Proxy({ signal: controller.signal }, {
    get() {
      throw new Error("frame-proxy-secret");
    },
  });
  await assert.rejects(fetcher(PLAYLIST_URL, proxyOptions), error => (
    error.code === "aborted" && !error.message.includes("proxy-secret")
  ));
  assert.throws(
    () => fetchSoopHlsFramePlaylist(PLAYLIST_URL, { fetchImpl, unexpected: true }),
    error => error.code === "invalid_config",
  );
  assert.equal(fetchCount, 0);
});

test("batch factory와 cursor 호출 옵션을 상한·형식까지 strict하게 검증한다", async () => {
  const baseOptions = { fetchImpl: async () => chunkedResponse([]) };
  for (const maxSegments of [0, 13, 1.5, "6", null, Number.NaN]) {
    assert.throws(
      () => createSoopHlsFrameSegmentBatchFetcher({ ...baseOptions, maxSegments }),
      error => error.code === "invalid_config" && error.stage === "config",
    );
  }
  for (const maxBatchBytes of [0, 127, 64 * 1024 * 1024 + 1, 1.5, "1024", null]) {
    assert.throws(
      () => createSoopHlsFrameSegmentBatchFetcher({ ...baseOptions, maxBatchBytes }),
      error => error.code === "invalid_config" && error.stage === "config",
    );
  }
  assert.throws(
    () => createSoopHlsFrameSegmentBatchFetcher({ ...baseOptions, unexpected: true }),
    error => error.code === "invalid_config",
  );

  let fetchCount = 0;
  const fetchBatch = createSoopHlsFrameSegmentBatchFetcher({
    maxSegments: 3,
    fetchImpl: async () => {
      fetchCount += 1;
      return chunkedResponse([mediaPlaylist(["1.ts"], 1)]);
    },
  });
  const forgedSignal = Object.create(AbortSignal.prototype);
  const symbolOptions = { [Symbol("secret")]: true };
  const accessorOptions = {};
  Object.defineProperty(accessorOptions, "afterSegmentId", {
    enumerable: true,
    get() {
      throw new Error("batch-options-getter-secret");
    },
  });
  const invalidCalls = [
    null,
    [],
    { unexpected: true },
    symbolOptions,
    accessorOptions,
    { afterSegmentId: "short" },
    { afterSegmentId: "A".repeat(64) },
    { afterSegmentId: null },
    { initialSegmentCount: -1 },
    { initialSegmentCount: 4 },
    { initialSegmentCount: 1.5 },
    { initialSegmentCount: null },
    { signal: {} },
    { signal: forgedSignal },
  ];
  for (const options of invalidCalls) {
    await assert.rejects(fetchBatch(PLAYLIST_URL, options), error => {
      const visible = `${error.code} ${error.stage} ${error.message} ${JSON.stringify(error)}`;
      return error.code === "invalid_config"
        && error.stage === "config"
        && !visible.includes("getter-secret");
    });
  }

  const controller = new AbortController();
  controller.abort(new Error("batch-abort-reason-secret"));
  const proxyOptions = new Proxy({ signal: controller.signal }, {
    get() {
      throw new Error("batch-proxy-secret");
    },
  });
  await assert.rejects(fetchBatch(PLAYLIST_URL, proxyOptions), error => (
    error.code === "aborted"
    && !error.message.includes("batch-proxy-secret")
    && !Object.hasOwn(error, "cause")
    && !Object.hasOwn(error, "url")
  ));
  assert.equal(fetchCount, 0);
});

test("batch mediaSequence는 non-negative safe integer만 허용한다", async () => {
  const uris = ["near-max-0.ts", "near-max-1.ts"];
  let playlist = mediaPlaylist(uris, Number.MAX_SAFE_INTEGER - 1);
  let segmentFetches = 0;
  const fetchBatch = createSoopHlsFrameSegmentBatchFetcher({
    maxSegments: 3,
    maxResponseBytes: 2_048,
    maxSegmentBytes: 1_024,
    fetchImpl: async (url) => {
      if (new URL(url).pathname.endsWith(".m3u8")) return chunkedResponse([playlist]);
      segmentFetches += 1;
      return chunkedResponse(["body"]);
    },
  });

  const valid = await fetchBatch(PLAYLIST_URL, { initialSegmentCount: 2 });
  assert.deepEqual(valid.map(item => item.mediaSequence), [
    Number.MAX_SAFE_INTEGER - 1,
    Number.MAX_SAFE_INTEGER,
  ]);
  assert.equal(segmentFetches, 2);

  playlist = mediaPlaylist([...uris, "overflow.ts"], Number.MAX_SAFE_INTEGER - 1);
  await assert.rejects(
    fetchBatch(PLAYLIST_URL, { initialSegmentCount: 3 }),
    error => error.code === "invalid_playlist" && error.stage === "parse",
  );
  assert.equal(segmentFetches, 2);

  playlist = mediaPlaylist(["duplicate.ts", "duplicate.ts"], 1);
  await assert.rejects(
    fetchBatch(PLAYLIST_URL, { initialSegmentCount: 1 }),
    error => error.code === "invalid_playlist" && error.stage === "parse",
  );
  assert.equal(segmentFetches, 2);
});

test("batch 누적 byte 상한 초과는 부분 결과 없이 중단되고 같은 cursor로 재시도된다", async () => {
  const uris = Array.from({ length: 4 }, (_value, index) => `batch/${index}.ts?token=batch-${index}`);
  const playlist = mediaPlaylist(uris, 20);
  let retryMode = false;
  let segmentFetches = 0;
  const fetchBatch = createSoopHlsFrameSegmentBatchFetcher({
    maxSegments: 4,
    maxBatchBytes: 128,
    maxResponseBytes: 2_048,
    maxSegmentBytes: 128,
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith(".m3u8")) return chunkedResponse([playlist]);
      segmentFetches += 1;
      const index = Number.parseInt(parsed.pathname.match(/\/([0-9]+)\.ts$/)?.[1] || "0", 10);
      const size = retryMode ? 30 : [60, 60, 20, 1][index];
      return chunkedResponse([Buffer.alloc(size, index + 1)], {
        headers: { "Content-Length": String(size) },
      });
    },
  });

  await assert.rejects(fetchBatch(PLAYLIST_URL, { initialSegmentCount: 4 }), error => {
    const visible = `${error.name} ${error.code} ${error.stage} ${error.message} ${JSON.stringify(error)}`;
    assert.equal(visible.includes("batch-2"), false);
    assert.equal(Object.hasOwn(error, "cause"), false);
    assert.equal(Object.hasOwn(error, "url"), false);
    return error.code === "response_too_large" && error.stage === "segment";
  });
  assert.equal(segmentFetches, 3);

  retryMode = true;
  const retried = await fetchBatch(PLAYLIST_URL, { initialSegmentCount: 4 });
  assert.equal(retried.length, 4);
  assert.equal(retried.reduce((total, item) => total + item.body.length, 0), 120);
  assert.equal(segmentFetches, 7);
});

test("batch 중간 segment 취소는 현재 controller를 중단하고 후속 fetch를 시작하지 않는다", async () => {
  const playlist = mediaPlaylist([
    "abort/0.ts?aid=batch-abort-secret",
    "abort/1.ts?aid=batch-abort-secret",
    "abort/2.ts?aid=batch-abort-secret",
  ], 90);
  let calls = 0;
  let activeSignal;
  let markSecondStarted;
  const secondStarted = new Promise(resolve => { markSecondStarted = resolve; });
  const fetchBatch = createSoopHlsFrameSegmentBatchFetcher({
    maxSegments: 3,
    timeoutMs: 100,
    maxResponseBytes: 2_048,
    maxSegmentBytes: 1_024,
    fetchImpl: async (_url, init) => {
      calls += 1;
      if (calls === 1) return chunkedResponse([playlist]);
      if (calls === 2) return chunkedResponse(["first"]);
      activeSignal = init.signal;
      markSecondStarted();
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("batch-abort-secret")), { once: true });
      });
    },
  });
  const controller = new AbortController();
  const pending = fetchBatch(PLAYLIST_URL, {
    initialSegmentCount: 3,
    signal: controller.signal,
  });
  await secondStarted;
  controller.abort(new Error("batch-abort-secret"));

  await assert.rejects(pending, error => {
    const visible = `${error.name} ${error.code} ${error.stage} ${error.message} ${JSON.stringify(error)}`;
    return error.code === "aborted"
      && error.stage === "segment"
      && !visible.includes("batch-abort-secret")
      && !Object.hasOwn(error, "cause")
      && !Object.hasOwn(error, "url");
  });
  assert.equal(activeSignal.aborted, true);
  assert.equal(calls, 3);
});
