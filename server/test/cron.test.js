const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  createRunner,
  samgukFmkoreaConfig,
  samgukTrackingConfig,
} = require("../cron");

const silentLogger = { error() {} };

test("공지 수집을 마친 뒤 캘린더 파싱을 시작한다", async () => {
  const events = [];
  const runner = createRunner({
    fetchNoticesFn: async (mode) => { events.push(`fetch:${mode}`); },
    parseHotFn: async () => { events.push("parse"); },
    logger: silentLogger,
  });

  await runner.runCycle({ includeRest: true });
  assert.equal(events.at(-1), "parse");
  assert.deepEqual(new Set(events.slice(0, -1)), new Set(["fetch:popular", "fetch:rest"]));
});

test("겹친 주기에서 parse-hot을 중복 실행하지 않는다", async () => {
  let releaseParse;
  let parseCalls = 0;
  const parseStarted = new Promise(resolve => {
    releaseParse = { start: resolve };
  });
  const parseBlocked = new Promise(resolve => {
    releaseParse.finish = resolve;
  });

  const runner = createRunner({
    fetchNoticesFn: async () => {},
    parseHotFn: async () => {
      parseCalls++;
      releaseParse.start();
      await parseBlocked;
    },
    logger: silentLogger,
  });

  const first = runner.runCycle();
  await parseStarted;
  const second = runner.runCycle();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(parseCalls, 1);

  releaseParse.finish();
  await Promise.all([first, second]);
});

test("삼국지 tracking은 명시적으로 켠 경우에도 기본 dry-run 설정을 유지한다", async () => {
  const calls = [];
  const config = samgukTrackingConfig({
    SAMGUK_TRACKING_ENABLED: "1",
    SAMGUK_OBSERVATION_QUEUE_PATH: "data/test-observations.ndjson",
    SAMGUK_CONSENSUS_WINDOW_MS: "3600000",
  });
  const runner = createRunner({
    promoteSamgukFn: async options => { calls.push(options); },
    samgukTracking: config,
    logger: silentLogger,
  });

  await runner.runSamgukPromotion();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].write, false);
  assert.equal(calls[0].windowMs, 3_600_000);
  assert.match(calls[0].queuePath, /server\/data\/test-observations\.ndjson$/);

  const disabled = createRunner({
    promoteSamgukFn: async () => { calls.push("disabled"); },
    samgukTracking: samgukTrackingConfig({ SAMGUK_TRACKING_ENABLED: "0" }),
    logger: silentLogger,
  });
  assert.equal(await disabled.runSamgukPromotion(), null);
  assert.equal(calls.length, 1);
});

test("겹친 삼국지 승격 주기는 같은 in-flight Promise를 공유한다", async () => {
  let releasePromotion;
  let promotionCalls = 0;
  const started = new Promise(resolve => { releasePromotion = { start: resolve }; });
  const blocked = new Promise(resolve => { releasePromotion.finish = resolve; });
  const runner = createRunner({
    promoteSamgukFn: async () => {
      promotionCalls += 1;
      releasePromotion.start();
      await blocked;
      return { written: 0 };
    },
    samgukTracking: {
      enabled: true,
      write: false,
      queuePath: "/tmp/samguk-test-observations.ndjson",
      windowMs: 60_000,
    },
    logger: silentLogger,
  });

  const first = runner.runSamgukPromotion();
  await started;
  const second = runner.runSamgukPromotion();
  assert.equal(first, second);
  assert.equal(promotionCalls, 1);

  releasePromotion.finish();
  await Promise.all([first, second]);
});

test("FMK 장비 monitor는 명시적으로 켰을 때 tracking과 같은 queue를 사용한다", async () => {
  const tracking = samgukTrackingConfig({
    SAMGUK_OBSERVATION_QUEUE_PATH: "data/test-fmk-observations.ndjson",
  });
  const config = samgukFmkoreaConfig({
    SAMGUK_FMKOREA_MONITOR_ENABLED: "1",
    SAMGUK_FMKOREA_MIN_INTERVAL_MS: "600000",
  }, tracking);
  assert.equal(config.enabled, true);
  assert.equal(config.queuePath, tracking.queuePath);
  assert.equal(config.minIntervalMs, 600_000);
  assert.equal(config.statePath, `${tracking.queuePath.replace(/\/[^/]+$/, "")}/fmkorea-gear-monitor-state.json`);

  const disabled = samgukFmkoreaConfig({}, tracking);
  assert.equal(disabled.enabled, false);
});

test("겹친 FMK 장비 수집 주기는 같은 in-flight Promise를 공유한다", async () => {
  let release;
  let calls = 0;
  const started = new Promise(resolve => { release = { start: resolve }; });
  const blocked = new Promise(resolve => { release.finish = resolve; });
  const runner = createRunner({
    fmkoreaMonitorFn: async () => {
      calls += 1;
      release.start();
      await blocked;
      return { inserted: 1, searched: 10, fetched: 1, errors: [] };
    },
    samgukFmkorea: {
      enabled: true,
      queuePath: "/tmp/samguk-fmkorea-test.ndjson",
      statePath: "/tmp/samguk-fmkorea-test.json",
      minIntervalMs: 300_000,
      aliasesByPlayer: {},
    },
    logger: silentLogger,
  });

  const first = runner.runSamgukFmkoreaMonitor();
  await started;
  const second = runner.runSamgukFmkoreaMonitor();
  assert.equal(first, second);
  assert.equal(calls, 1);

  release.finish();
  await Promise.all([first, second]);
});
