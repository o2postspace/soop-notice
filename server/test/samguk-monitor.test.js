const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { CURRENT_SEASON_ID, readObservationQueue } = require("../lib/samguk-observations");
const { buildPromotionSnapshots } = require("../scripts/samguk-promote-observations");
const {
  SamgukMonitorError,
  assertActivationAllowed,
  captureRoi,
  createMonitor,
  createSoopLiveChecker,
  isMonitorEnabled,
  main,
  normalizeMonitorConfig,
  parseOcrOutput,
  runOcrAdapter,
} = require("../workers/samguk-monitor");

function config(overrides = {}) {
  return {
    version: 1,
    permissionConfirmed: true,
    display: ":0.0",
    ffmpegPath: "/usr/bin/ffmpeg",
    idlePollMs: 60_000,
    livePollMs: 15_000,
    captureTimeoutMs: 8_000,
    cropRetentionMs: 0,
    ocr: {
      command: "/opt/local/samguk-ocr",
      args: ["--input", "{input}", "--field", "{field}"],
      minConfidence: 0.95,
    },
    targets: [{
      id: "player-1",
      enabled: true,
      playerId: "P001",
      bjId: "test_bj",
      sourceUrl: "https://play.sooplive.com/test_bj",
      sampleIntervalMs: 15_000,
      rois: [{ id: "strength", field: "strength", x: 10, y: 20, width: 100, height: 40 }],
    }],
    ...overrides,
  };
}

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "samguk-monitor-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("기본 비활성이면 config도 읽지 않고 외부 작업 없이 종료한다", async () => {
  const logs = [];
  assert.equal(isMonitorEnabled({}), false);
  assert.equal(isMonitorEnabled({ SAMGUK_MONITOR_ENABLED: "true" }), false);
  assert.equal(isMonitorEnabled({ SAMGUK_MONITOR_ENABLED: "1" }), true);
  assert.deepEqual(await main({ env: {}, logger: { log: value => logs.push(value) } }), { enabled: false });
  assert.match(logs[0], /외부 조회와 캡처를 시작하지 않습니다/);
});

test("권한 확인과 활성 target 없이는 시작하지 않는다", () => {
  const noPermission = normalizeMonitorConfig(config({ permissionConfirmed: false }));
  assert.throws(
    () => assertActivationAllowed(noPermission),
    error => error instanceof SamgukMonitorError && error.code === "permission_required",
  );
  const noTargets = normalizeMonitorConfig(config({
    targets: config().targets.map(target => ({ ...target, enabled: false })),
  }));
  assert.throws(() => assertActivationAllowed(noTargets), error => error.code === "no_targets");
});

test("설정된 ROI와 안전한 범위만 허용한다", () => {
  const normalized = normalizeMonitorConfig(config());
  assert.equal(normalized.idlePollMs, 60_000);
  assert.equal(normalized.livePollMs, 15_000);
  assert.equal(normalized.cropRetentionMs, 0);
  assert.throws(
    () => normalizeMonitorConfig(config({ display: ":0.0;touch /tmp/bad" })),
    error => error.code === "invalid_config",
  );
  assert.throws(
    () => normalizeMonitorConfig(config({ cropRetentionMs: 300_001 })),
    error => error.code === "invalid_config",
  );
  assert.throws(
    () => normalizeMonitorConfig(config({
      ocr: { ...config().ocr, minConfidence: 0.94 },
    })),
    error => error.code === "invalid_config" && /0\.95 이상/.test(error.message),
  );
  assert.throws(
    () => normalizeMonitorConfig(config({
      targets: [{ ...config().targets[0], playerId: "player-1" }],
    })),
    error => error.code === "invalid_config" && /playerId 형식/.test(error.message),
  );
  assert.throws(
    () => normalizeMonitorConfig(config({
      targets: [{ ...config().targets[0], rois: [{ ...config().targets[0].rois[0], field: "chat" }] }],
    })),
    error => error.code === "invalid_config",
  );
});

test("ffmpeg를 shell 없이 ROI 좌표 인자 배열로 실행한다", async (t) => {
  const directory = temporaryDirectory(t);
  const outputPath = path.join(directory, "crop.png");
  let invocation;
  const fakeExecFile = (command, args, options, callback) => {
    invocation = { command, args, options };
    fs.writeFileSync(outputPath, "fake-png");
    callback(null, "", "");
  };
  await captureRoi({
    ffmpegPath: "/usr/bin/ffmpeg",
    display: ":0.0",
    captureTimeoutMs: 8_000,
    roi: { x: 10, y: 20, width: 100, height: 40 },
    outputPath,
  }, { execFileImpl: fakeExecFile, env: { PATH: "/usr/bin" } });

  assert.equal(invocation.command, "/usr/bin/ffmpeg");
  assert.equal(invocation.options.shell, false);
  assert.equal(invocation.args[invocation.args.indexOf("-video_size") + 1], "100x40");
  assert.equal(invocation.args[invocation.args.indexOf("-i") + 1], ":0.0+10,20");
  assert.equal(invocation.args.at(-1), outputPath);
});

test("OCR adapter는 인자 template을 배열에서 치환하고 JSON 계약만 받는다", async () => {
  let invocation;
  const result = await runOcrAdapter({
    command: "/opt/local/ocr",
    args: ["--input", "{input}", "--field={field}"],
    timeoutMs: 1_000,
    maxOutputBytes: 1_024,
  }, {
    input: "/tmp/crop;not-a-shell.png",
    field: "strength",
    playerId: "P001",
    targetId: "target",
    roiId: "strength",
  }, {
    execFileImpl(command, args, options, callback) {
      invocation = { command, args, options };
      callback(null, JSON.stringify({ value: 321, confidence: 0.98 }), "");
    },
  });
  assert.deepEqual(result, { value: 321, confidence: 0.98 });
  assert.equal(invocation.options.shell, false);
  assert.deepEqual(invocation.args, ["--input", "/tmp/crop;not-a-shell.png", "--field=strength"]);
  assert.throws(
    () => parseOcrOutput('{"value":1,"confidence":0.9,"extra":true}'),
    error => error.code === "invalid_ocr_output" && /허용되지 않은/.test(error.message),
  );
  assert.throws(() => parseOcrOutput("debug log"), error => error.code === "invalid_ocr_output");
});

test("SOOP LIVE 조회는 브라우저 헤더를 보내고 broad 유무와 HTTP 성공을 구분한다", async () => {
  const invocations = [];
  const responses = [
    { ok: true, status: 200, json: async () => ({ broad: { broad_no: 123 } }) },
    { ok: true, status: 200, json: async () => ({ broad: null }) },
  ];
  const checker = createSoopLiveChecker({
    fetchImpl: async (url, options) => {
      invocations.push({ url, options });
      return responses.shift();
    },
  });

  assert.equal(await checker("test_bj"), true);
  assert.equal(await checker("offline_bj"), false);
  assert.equal(invocations[0].url, "https://chapi.sooplive.co.kr/api/test_bj/station");
  assert.deepEqual(invocations[0].options.headers, {
    Referer: "https://www.sooplive.co.kr/",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    Accept: "application/json",
  });
  assert.ok(invocations[0].options.signal instanceof AbortSignal);

  const rejected = createSoopLiveChecker({
    fetchImpl: async () => ({ ok: false, status: 404 }),
  });
  await assert.rejects(() => rejected("test_bj"), /SOOP HTTP 404/);
});

test("LIVE일 때만 지정 ROI를 관측하고 15초, 대기 때는 60초를 반환한다", async (t) => {
  const directory = temporaryDirectory(t);
  const normalized = normalizeMonitorConfig(config({
    targets: [
      config().targets[0],
      { ...config().targets[0], id: "player-2", playerId: "P002", bjId: "offline_bj" },
      { ...config().targets[0], id: "disabled", playerId: "P003", bjId: "disabled_bj", enabled: false },
    ],
  }));
  const checked = [];
  let currentTime = Date.parse("2026-08-02T10:00:00.000Z");
  const queuePath = path.join(directory, "queue.ndjson");
  const monitor = createMonitor({
    config: normalized,
    queuePath,
    stateDir: directory,
    now: () => currentTime,
    randomId: () => "frame1",
    getLiveStatus: async (bjId) => {
      checked.push(bjId);
      return bjId === "test_bj";
    },
    captureRoiFn: async ({ outputPath }) => fs.writeFileSync(outputPath, "roi-only"),
    runOcrFn: async () => ({ value: 123, confidence: 0.98 }),
    logger: { warn() {} },
  });

  const liveCycle = await monitor.runCycle();
  assert.deepEqual(checked.sort(), ["offline_bj", "test_bj"]);
  assert.equal(liveCycle.liveCount, 1);
  assert.equal(liveCycle.capturedCount, 1);
  assert.equal(liveCycle.appendedCount, 1);
  assert.equal(liveCycle.nextPollMs, 15_000);
  const queued = readObservationQueue(queuePath);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].sourceType, "broadcast");
  assert.equal(queued[0].field, "strength");
  assert.equal(queued[0].value, 123);
  assert.equal(queued[0].ocrConfidence, 0.98);
  assert.equal(fs.readdirSync(monitor.cropsDir).length, 0);

  currentTime += 15_000;
  const idleMonitor = createMonitor({
    config: normalized,
    queuePath: path.join(directory, "idle.ndjson"),
    stateDir: path.join(directory, "idle"),
    getLiveStatus: async () => false,
    now: () => currentTime,
    logger: { warn() {} },
  });
  const idleCycle = await idleMonitor.runCycle();
  assert.equal(idleCycle.capturedCount, 0);
  assert.equal(idleCycle.nextPollMs, 60_000);
});

test("낮은 OCR confidence는 queue에 추가하지 않고 crop을 즉시 지운다", async (t) => {
  const directory = temporaryDirectory(t);
  let appendCalls = 0;
  const monitor = createMonitor({
    config: normalizeMonitorConfig(config()),
    queuePath: path.join(directory, "queue.ndjson"),
    stateDir: directory,
    now: () => Date.parse("2026-08-02T10:00:00.000Z"),
    getLiveStatus: async () => true,
    captureRoiFn: async ({ outputPath }) => fs.writeFileSync(outputPath, "roi-only"),
    runOcrFn: async () => ({ value: 123, confidence: 0.5 }),
    appendFn: () => {
      appendCalls += 1;
      return { inserted: [] };
    },
    logger: { warn() {} },
  });
  const result = await monitor.runCycle();
  assert.equal(result.capturedCount, 1);
  assert.equal(result.appendedCount, 0);
  assert.equal(appendCalls, 0);
  assert.equal(fs.readdirSync(monitor.cropsDir).length, 0);
});

test("서로 다른 두 방송 frame이 NDJSON에서 promoter와 webhook 계약까지 승격된다", async (t) => {
  const directory = temporaryDirectory(t);
  const queuePath = path.join(directory, "queue.ndjson");
  let currentTime = Date.now() - 60_000;
  let captureCount = 0;
  const frameIds = ["frame-a", "frame-b"];
  const monitor = createMonitor({
    config: normalizeMonitorConfig(config()),
    queuePath,
    stateDir: directory,
    now: () => currentTime,
    randomId: () => frameIds.shift(),
    getLiveStatus: async () => true,
    captureRoiFn: async ({ outputPath }) => {
      captureCount += 1;
      fs.writeFileSync(outputPath, `roi-${captureCount}`);
    },
    runOcrFn: async () => ({ value: 123, confidence: 0.98 }),
    logger: { warn() {} },
  });

  assert.equal((await monitor.runCycle()).appendedCount, 1);
  currentTime += 15_000;
  assert.equal((await monitor.runCycle()).appendedCount, 1);

  const queued = readObservationQueue(queuePath);
  assert.equal(queued.length, 2);
  assert.ok(queued.every(item => item.seasonId === CURRENT_SEASON_ID));
  assert.ok(queued.every(item => item.field === "strength" && item.ocrConfidence === 0.98));
  assert.ok(queued.every(item => item.sourceId.startsWith("screen:player-1-strength-")));
  assert.equal(new Set(queued.map(item => item.sourceId)).size, 2);
  assert.equal(new Set(queued.map(item => item.evidenceHash)).size, 2);

  const baselineTime = new Date(currentTime - 60_000).toISOString();
  const snapshots = buildPromotionSnapshots({
    seasonId: CURRENT_SEASON_ID,
    source: "google-sheet",
    stale: false,
    sheetUrl: "https://docs.google.com/spreadsheets/d/test-sheet/edit",
    updatedAt: baselineTime,
    members: [{
      soopId: "cnsgkcnehd74",
      level: 10, horse: "백룡마", horseLevel: 1, weapon: 2, helmet: 1, armor: 1, shoes: 1,
      strength: 10, agility: 2, vitality: 3, intelligence: 4, powerScore: null,
      observedAt: baselineTime,
    }],
  }, queued, { windowMs: 60 * 60_000, now: currentTime });

  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].fields.strength, 123);
  assert.equal(snapshots[0].verification, "broadcast-repeat");
  assert.equal(snapshots[0].primarySourceType, "broadcast");
  assert.deepEqual(snapshots[0].sourceTypes, ["broadcast"]);
  assert.equal(snapshots[0].sourceCount, 2);
  assert.equal(snapshots[0].ocrConfidence, 0.98);

  const webhookPath = path.resolve(
    __dirname,
    "../scripts/google-apps-script/samguk-observation-webhook.gs",
  );
  const webhook = {};
  vm.runInNewContext(fs.readFileSync(webhookPath, "utf8"), webhook, { filename: webhookPath });
  assert.doesNotThrow(() => webhook.samgukValidateSnapshot_(snapshots[0]));
});
