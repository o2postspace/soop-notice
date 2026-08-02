"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { existsSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const { EventEmitter } = require("node:events");
const { PassThrough, Writable } = require("node:stream");
const {
  DEFAULTS,
  GRAY_FRAME_BYTES,
  GRAY_FRAME_COUNT,
  GRAY_OUTPUT_BYTES,
  SamgukFfmpegFrameError,
  buildGrayArgs,
  buildOcrPngArgs,
  captureGrayFrame,
  captureOcrPng,
  createSamgukFfmpegFrame,
} = require("../lib/samguk-ffmpeg-frame");

function pngChunk(type, data = Buffer.alloc(0)) {
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, 4, "ascii");
  data.copy(chunk, 8);
  // CRC 값은 구조 검증 대상이 아니므로 synthetic fixture에서는 0으로 둔다.
  return chunk;
}

function syntheticPng(width = 960, height = 540, trailing = Buffer.alloc(0)) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", Buffer.from([1])),
    pngChunk("IEND"),
    trailing,
  ]);
}

function fakeSpawner(behavior) {
  const calls = [];
  function spawnImpl(command, args, options) {
    const child = new EventEmitter();
    const input = [];
    child.stdin = new Writable({
      write(chunk, _encoding, callback) {
        input.push(Buffer.from(chunk));
        callback();
      },
    });
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kills = [];
    child.kill = signal => {
      child.kills.push(signal);
      return true;
    };
    const call = { command, args, options, child, input };
    calls.push(call);
    queueMicrotask(() => behavior(call));
    return child;
  }
  return { calls, spawnImpl };
}

function closeWith(call, { stdout = [], stderr = [], code = 0 } = {}) {
  for (const chunk of stdout) call.child.stdout.write(chunk);
  for (const chunk of stderr) call.child.stderr.write(chunk);
  call.child.stdout.end();
  call.child.stderr.end();
  call.child.emit("close", code, null);
}

function extractor(fake, overrides = {}) {
  return createSamgukFfmpegFrame({
    ffmpegPath: "/usr/bin/ffmpeg",
    timeoutMs: 100,
    spawnImpl: fake.spawnImpl,
    ...overrides,
  });
}

function trackedAbortSignal() {
  let aborted = false;
  const listeners = new Set();
  const signal = {
    get aborted() { return aborted; },
    addEventListener(type, listener) {
      if (type === "abort") listeners.add(listener);
    },
    removeEventListener(type, listener) {
      if (type === "abort") listeners.delete(listener);
    },
  };
  return {
    signal,
    abort() {
      if (aborted) return;
      aborted = true;
      for (const listener of [...listeners]) listener();
    },
    listenerCount: () => listeners.size,
  };
}

function runActualFfmpeg(args, input) {
  return spawnSync("/usr/bin/ffmpeg", args, {
    input,
    maxBuffer: 16 * 1024 * 1024,
    shell: false,
    windowsHide: true,
  });
}

function byteMean(buffer) {
  let sum = 0;
  for (const value of buffer) sum += value;
  return sum / buffer.length;
}

test("ffmpeg 절대경로와 모든 size/timeout option을 엄격히 검증한다", () => {
  for (const options of [
    {},
    { ffmpegPath: "ffmpeg" },
    { ffmpegPath: "/usr/bin/ffmpeg\n--bad" },
    { ffmpegPath: "/usr/bin/ffmpeg", timeoutMs: 9 },
    { ffmpegPath: "/usr/bin/ffmpeg", maxInputBytes: 0 },
    { ffmpegPath: "/usr/bin/ffmpeg", maxGrayOutputBytes: GRAY_OUTPUT_BYTES - 1 },
    { ffmpegPath: "/usr/bin/ffmpeg", maxPngOutputBytes: 63 },
    { ffmpegPath: "/usr/bin/ffmpeg", maxStderrBytes: -1 },
    { ffmpegPath: "/usr/bin/ffmpeg", unknown: true },
  ]) {
    assert.throws(
      () => createSamgukFfmpegFrame(options),
      error => error instanceof SamgukFfmpegFrameError && error.code === "invalid_config",
    );
  }
});

test("gray frame은 MPEG-TS 전체를 4fps의 8개 연결 frame으로 추출한다", async () => {
  const secret = "https://secret.invalid/live.ts?token=never-in-argv";
  const fake = fakeSpawner(call => closeWith(call, {
    stdout: [Buffer.alloc(500, 1), Buffer.alloc(GRAY_OUTPUT_BYTES - 500, 2)],
  }));
  const input = Buffer.from(`binary-prefix:${secret}`);
  const output = await extractor(fake).captureGrayFrame(input);
  const [call] = fake.calls;

  assert.equal(GRAY_FRAME_BYTES, 48 * 27);
  assert.equal(GRAY_FRAME_COUNT, 8);
  assert.equal(GRAY_OUTPUT_BYTES, GRAY_FRAME_BYTES * GRAY_FRAME_COUNT);
  assert.equal(DEFAULTS.maxGrayOutputBytes, GRAY_OUTPUT_BYTES);
  assert.equal(output.length, GRAY_OUTPUT_BYTES);
  assert.equal(call.command, "/usr/bin/ffmpeg");
  assert.equal(call.options.shell, false);
  assert.deepEqual(call.options.stdio, ["pipe", "pipe", "pipe"]);
  assert.deepEqual(call.args, buildGrayArgs());
  assert.equal(call.args.includes("-skip_frame"), false);
  assert.equal(call.args.includes("fps=4,scale=48:27:flags=fast_bilinear"), true);
  assert.equal(call.args[call.args.indexOf("-filter_threads") + 1], "1");
  assert.equal(call.args.filter(value => value === "-threads").length, 2);
  assert.equal(call.args[call.args.indexOf("-frames:v") + 1], "8");
  assert.equal(call.args.join(" ").includes(secret), false);
  assert.equal(call.args[call.args.indexOf("-i") + 1], "pipe:0");
  assert.equal(call.args.at(-1), "pipe:1");
  assert.deepEqual(Buffer.concat(call.input), input);
});

test("OCR capture 기본값은 gray gate와 같은 fps phase의 index 4를 PNG로 받는다", async () => {
  const png = syntheticPng();
  const fake = fakeSpawner(call => closeWith(call, {
    stdout: [png.subarray(0, 17), png.subarray(17)],
  }));
  const output = await extractor(fake).captureOcrPng(Buffer.from([0x47]));
  const [call] = fake.calls;

  assert.deepEqual(output, png);
  assert.deepEqual(call.args, buildOcrPngArgs());
  assert.equal(call.args.includes("-skip_frame"), false);
  assert.equal(call.args.some(value => value.includes("://")), false);
  const threadsIndex = call.args.indexOf("-threads");
  assert.notEqual(threadsIndex, -1);
  assert.equal(call.args[threadsIndex + 1], "1");
  assert.ok(threadsIndex < call.args.indexOf("-i"));
  assert.equal(call.args[call.args.indexOf("-filter_threads") + 1], "1");
  assert.equal(call.args.filter(value => value === "-threads").length, 2);
  const inputIndex = call.args.indexOf("-i");
  assert.equal(call.args[inputIndex + 1], "pipe:0");
  assert.equal(call.args.includes("-ss"), false);
  assert.equal(
    call.args[call.args.indexOf("-vf") + 1],
    "fps=4,select=eq(n\\,4),scale=960:540:flags=bicubic",
  );
  assert.equal(call.args.at(-1), "pipe:1");
});

test("OCR sampleIndex 0..7을 같은 fps=4 stream의 frame index로 엄격히 변환한다", async () => {
  const png = syntheticPng();
  for (let sampleIndex = 0; sampleIndex < GRAY_FRAME_COUNT; sampleIndex += 1) {
    const fake = fakeSpawner(call => closeWith(call, { stdout: [png] }));
    await extractor(fake).captureOcrPng(Buffer.from([0x47]), { sampleIndex });
    const args = fake.calls[0].args;
    assert.equal(args.includes("-ss"), false);
    assert.equal(
      args[args.indexOf("-vf") + 1],
      `fps=4,select=eq(n\\,${sampleIndex}),scale=960:540:flags=bicubic`,
    );
    assert.deepEqual(args, buildOcrPngArgs(sampleIndex));
  }

  const fake = fakeSpawner(() => {});
  for (const sampleIndex of [-1, 8, 1.5, "4", null, NaN]) {
    await assert.rejects(
      extractor(fake).captureOcrPng(Buffer.from([0x47]), { sampleIndex }),
      error => error.code === "invalid_sample_index",
    );
    assert.throws(
      () => buildOcrPngArgs(sampleIndex),
      error => error.code === "invalid_sample_index",
    );
  }
  assert.equal(fake.calls.length, 0);
});

test("실제 MPEG-TS에서도 gray candidate와 OCR sampleIndex의 fps phase가 일치한다", {
  timeout: 20_000,
}, async t => {
  if (!existsSync("/usr/bin/ffmpeg")) {
    t.skip("/usr/bin/ffmpeg가 없습니다.");
    return;
  }

  const generated = runActualFfmpeg([
    "-hide_banner",
    "-loglevel", "error",
    "-f", "lavfi",
    "-i", "color=black:size=960x540:rate=30:duration=2",
    "-vf", "drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:enable='between(t,0.84,0.91)'",
    "-c:v", "libx264",
    "-preset", "ultrafast",
    "-g", "120",
    "-keyint_min", "120",
    "-sc_threshold", "0",
    "-f", "mpegts",
    "pipe:1",
  ]);
  assert.equal(generated.status, 0, generated.stderr?.toString("utf8"));
  assert.ok(Buffer.isBuffer(generated.stdout) && generated.stdout.length > 0);

  const frames = createSamgukFfmpegFrame({ ffmpegPath: "/usr/bin/ffmpeg" });
  const gray = await frames.captureGrayFrame(generated.stdout);
  const grayMeans = Array.from({ length: GRAY_FRAME_COUNT }, (_, index) => byteMean(
    gray.subarray(index * GRAY_FRAME_BYTES, (index + 1) * GRAY_FRAME_BYTES),
  ));
  assert.equal(grayMeans.indexOf(Math.max(...grayMeans)), 3);
  assert.ok(grayMeans[3] > 200);

  const ocrMeans = [];
  for (const sampleIndex of [2, 3, 4]) {
    const png = await frames.captureOcrPng(generated.stdout, { sampleIndex });
    const decoded = runActualFfmpeg([
      "-hide_banner",
      "-loglevel", "error",
      "-f", "image2pipe",
      "-i", "pipe:0",
      "-map", "0:v:0",
      "-an",
      "-sn",
      "-dn",
      "-vf", "scale=48:27:flags=fast_bilinear",
      "-pix_fmt", "gray",
      "-frames:v", "1",
      "-f", "rawvideo",
      "pipe:1",
    ], png);
    assert.equal(decoded.status, 0, decoded.stderr?.toString("utf8"));
    assert.equal(decoded.stdout.length, GRAY_FRAME_BYTES);
    ocrMeans.push(byteMean(decoded.stdout));
  }
  assert.ok(ocrMeans[0] < 20);
  assert.ok(ocrMeans[1] > 200);
  assert.ok(ocrMeans[2] < 20);
});

test("gray 8개 길이와 PNG 크기·단일 이미지 구조가 다르면 거부한다", async () => {
  const shortGray = fakeSpawner(call => closeWith(call, { stdout: [Buffer.alloc(GRAY_OUTPUT_BYTES - 1)] }));
  await assert.rejects(
    extractor(shortGray).captureGrayFrame(Buffer.from([1])),
    error => error.code === "invalid_gray_frame",
  );

  for (const png of [syntheticPng(959, 540), syntheticPng(960, 539), syntheticPng(960, 540, Buffer.from([1]))]) {
    const fake = fakeSpawner(call => closeWith(call, { stdout: [png] }));
    await assert.rejects(
      extractor(fake).captureOcrPng(Buffer.from([1])),
      error => error.code === "invalid_png",
    );
  }
});

test("stdin과 stdout cap은 spawn 전/실행 중 각각 적용된다", async () => {
  let spawnCount = 0;
  const inputFake = fakeSpawner(() => { spawnCount += 1; });
  const instance = extractor(inputFake, { maxInputBytes: 2 });
  await assert.rejects(instance.captureGrayFrame(Buffer.alloc(3)), error => error.code === "input_too_large");
  assert.equal(spawnCount, 0);
  await assert.rejects(instance.captureGrayFrame(new Uint8Array([1])), error => error.code === "invalid_input");

  const outputFake = fakeSpawner(call => closeWith(call, { stdout: [Buffer.alloc(GRAY_OUTPUT_BYTES + 1)] }));
  await assert.rejects(
    extractor(outputFake).captureGrayFrame(Buffer.from([1])),
    error => error.code === "stdout_too_large",
  );
  assert.deepEqual(outputFake.calls[0].child.kills, ["SIGKILL"]);
});

test("stderr cap과 프로세스 오류에서 stderr·내부 오류의 비밀값을 노출하지 않는다", async () => {
  const secret = "token=top-secret-value";
  const stderrFake = fakeSpawner(call => closeWith(call, {
    stderr: [Buffer.from(secret)],
    code: 1,
  }));
  await assert.rejects(
    extractor(stderrFake, { maxStderrBytes: 4 }).captureGrayFrame(Buffer.from([1])),
    error => {
      const visible = `${error.name} ${error.code} ${error.message} ${JSON.stringify(error)}`;
      return error.code === "stderr_too_large" && !visible.includes(secret) && !Object.hasOwn(error, "cause");
    },
  );
  assert.deepEqual(stderrFake.calls[0].child.kills, ["SIGKILL"]);

  const processFake = fakeSpawner(call => {
    call.child.stderr.write(secret);
    call.child.emit("error", new Error(`spawn failed: ${secret}`));
    call.child.emit("close", 1, null);
  });
  await assert.rejects(
    extractor(processFake, { maxStderrBytes: 1_024 }).captureGrayFrame(Buffer.from([1])),
    error => error.code === "spawn_failed" && !error.message.includes(secret),
  );
});

test("timeout은 SIGKILL하고 뒤늦은 close가 Promise를 다시 settle하지 못한다", async () => {
  let call;
  const fake = fakeSpawner(value => { call = value; });
  const promise = extractor(fake, { timeoutMs: 10 }).captureGrayFrame(Buffer.from([1]));
  await assert.rejects(promise, error => error.code === "timeout");
  assert.deepEqual(call.child.kills, ["SIGKILL"]);

  closeWith(call, { stdout: [Buffer.alloc(GRAY_OUTPUT_BYTES)] });
  assert.deepEqual(call.child.kills, ["SIGKILL"]);
});

test("spawn throw와 stdin 오류도 고정된 안전 오류로 한 번만 종료한다", async () => {
  const secret = "private-token-in-error";
  const throwing = createSamgukFfmpegFrame({
    ffmpegPath: "/usr/bin/ffmpeg",
    spawnImpl() { throw new Error(secret); },
  });
  await assert.rejects(
    throwing.captureGrayFrame(Buffer.from([1])),
    error => error.code === "spawn_failed" && !error.message.includes(secret),
  );

  const fake = fakeSpawner(call => {
    call.child.stdin.emit("error", new Error(secret));
    call.child.emit("close", 0, null);
  });
  await assert.rejects(
    extractor(fake).captureGrayFrame(Buffer.from([1])),
    error => error.code === "stdin_error" && !error.message.includes(secret),
  );
  assert.deepEqual(fake.calls[0].child.kills, ["SIGKILL"]);
});

test("이미 abort된 signal과 잘못된 signal은 spawn 전에 거부한다", async () => {
  const secret = "abort-reason-secret";
  const fake = fakeSpawner(() => {});
  const controller = new AbortController();
  controller.abort(new Error(secret));
  await assert.rejects(
    extractor(fake).captureOcrPng(Buffer.from([1]), { signal: controller.signal }),
    error => error.code === "aborted" && !error.message.includes(secret),
  );

  for (const runOptions of [
    null,
    { signal: null },
    { signal: { aborted: false, addEventListener() {} } },
    { signal: controller.signal, extra: true },
  ]) {
    await assert.rejects(
      extractor(fake).captureGrayFrame(Buffer.from([1]), runOptions),
      error => error.code === "invalid_signal",
    );
  }
  assert.equal(fake.calls.length, 0);
});

test("실행 중 abort는 SIGKILL하고 listener를 제거하며 뒤늦은 close를 무시한다", async () => {
  const tracked = trackedAbortSignal();
  const fake = fakeSpawner(() => {});
  const promise = extractor(fake).captureGrayFrame(Buffer.from([1]), { signal: tracked.signal });
  assert.equal(tracked.listenerCount(), 1);
  tracked.abort();

  await assert.rejects(promise, error => error.code === "aborted");
  const [call] = fake.calls;
  assert.deepEqual(call.child.kills, ["SIGKILL"]);
  assert.equal(tracked.listenerCount(), 0);
  closeWith(call, { stdout: [Buffer.alloc(GRAY_OUTPUT_BYTES)] });
  assert.deepEqual(call.child.kills, ["SIGKILL"]);
});

test("정상 완료 후에도 abort listener를 제거한다", async () => {
  const tracked = trackedAbortSignal();
  const fake = fakeSpawner(call => closeWith(call, {
    stdout: [Buffer.alloc(GRAY_OUTPUT_BYTES)],
  }));
  await extractor(fake).captureGrayFrame(Buffer.from([1]), { signal: tracked.signal });
  assert.equal(tracked.listenerCount(), 0);
});

test("one-shot API도 ffmpeg config와 signal·sampleIndex를 분리한다", async () => {
  const tracked = trackedAbortSignal();
  const fake = fakeSpawner(call => closeWith(call, {
    stdout: [Buffer.alloc(GRAY_OUTPUT_BYTES)],
  }));
  const output = await captureGrayFrame(Buffer.from([1]), {
    ffmpegPath: "/usr/bin/ffmpeg",
    spawnImpl: fake.spawnImpl,
    signal: tracked.signal,
  });
  assert.equal(output.length, GRAY_OUTPUT_BYTES);
  assert.equal(tracked.listenerCount(), 0);

  const png = syntheticPng();
  const pngFake = fakeSpawner(call => closeWith(call, { stdout: [png] }));
  assert.deepEqual(await captureOcrPng(Buffer.from([1]), {
    ffmpegPath: "/usr/bin/ffmpeg",
    spawnImpl: pngFake.spawnImpl,
    sampleIndex: 7,
  }), png);
  const filterIndex = pngFake.calls[0].args.indexOf("-vf");
  assert.equal(
    pngFake.calls[0].args[filterIndex + 1],
    "fps=4,select=eq(n\\,7),scale=960:540:flags=bicubic",
  );

  await assert.rejects(captureGrayFrame(Buffer.from([1]), null), error => (
    error.code === "invalid_config"
  ));
});
