const cron = require("node-cron");
const fetchNotices = require("./fetch-notices");
const parseHot = require("./parse-hot");

function createRunner({
  fetchNoticesFn = fetchNotices,
  parseHotFn = parseHot,
  logger = console,
} = {}) {
  const fetchRuns = new Map();
  let parseRun = null;

  function runFetch(mode) {
    if (fetchRuns.has(mode)) return fetchRuns.get(mode);

    const task = Promise.resolve()
      .then(() => fetchNoticesFn(mode))
      .catch((error) => {
        logger.error(`[cron] fetch-notices:${mode} failed:`, error.message);
      })
      .finally(() => fetchRuns.delete(mode));
    fetchRuns.set(mode, task);
    return task;
  }

  function runParse() {
    if (parseRun) return parseRun;

    parseRun = Promise.resolve()
      .then(() => parseHotFn())
      .catch((error) => {
        logger.error("[cron] parse-hot failed:", error.message);
      })
      .finally(() => { parseRun = null; });
    return parseRun;
  }

  async function runCycle({ includeRest = false } = {}) {
    const fetchTasks = [runFetch("popular")];
    if (includeRest) fetchTasks.push(runFetch("rest"));
    await Promise.all(fetchTasks);
    await runParse();
  }

  return { runCycle };
}

function start() {
  const runner = createRunner();
  let stopped = false;

  // 수집이 끝난 뒤 파싱한다. 이전 파싱이 진행 중이면 같은 Promise를 공유해 중복 실행하지 않는다.
  const scheduledTask = cron.schedule("*/5 * * * *", () => {
    if (stopped) return;
    const includeRest = new Date().getMinutes() % 30 === 0;
    void runner.runCycle({ includeRest });
  });

  // 재기동 직후에도 전체 공지를 먼저 갱신하고 캘린더를 백필한다.
  void runner.runCycle({ includeRest: true });

  console.log("[cron] scheduled: ordered fetch(popular/5m, rest/30m) -> parse-hot, bootstrap enabled");

  return () => {
    if (stopped) return;
    stopped = true;
    scheduledTask.stop();
    if (typeof scheduledTask.destroy === "function") scheduledTask.destroy();
  };
}

module.exports = { start, createRunner };
