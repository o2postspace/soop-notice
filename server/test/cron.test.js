const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createRunner } = require("../cron");

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
