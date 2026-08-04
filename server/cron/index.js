const cron = require("node-cron");
const path = require("node:path");
const fetchNotices = require("./fetch-notices");
const parseHot = require("./parse-hot");
const cleanupCommunity = require("./cleanup-community");
const { markCacheInvalidated } = require("../lib/encoded-json-cache");
const { createSamgukSheetService } = require("../lib/samguk-sheet");
const {
  DEFAULT_MIN_INTERVAL_MS: DEFAULT_FMKOREA_MIN_INTERVAL_MS,
  loadAliasesByPlayerFile,
  normalizeSeasonStartAt,
  runFmkoreaGearMonitor,
} = require("../lib/samguk-fmkorea-gear-monitor");
const {
  DEFAULT_BASELINE_RETRY_ATTEMPTS,
  DEFAULT_BASELINE_RETRY_BASE_MS,
  DEFAULT_BASELINE_RETRY_MAX_MS,
  DEFAULT_QUEUE_PATH: DEFAULT_SAMGUK_QUEUE_PATH,
  promote: promoteSamgukObservations,
  resolveCacheStampPath,
} = require("../scripts/samguk-promote-observations");

const DEFAULT_SAMGUK_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_SAMGUK_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

function boundedPositiveInt(value, fallback, maximum) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= maximum ? parsed : fallback;
}

function samgukTrackingConfig(env = process.env) {
  const parsedWindowMs = Number(env.SAMGUK_CONSENSUS_WINDOW_MS);
  const windowMs = Number.isFinite(parsedWindowMs)
    && parsedWindowMs > 0
    && parsedWindowMs <= MAX_SAMGUK_WINDOW_MS
    ? parsedWindowMs
    : DEFAULT_SAMGUK_WINDOW_MS;
  const configuredQueuePath = String(env.SAMGUK_OBSERVATION_QUEUE_PATH || "").trim();
  const queuePath = configuredQueuePath
    ? (path.isAbsolute(configuredQueuePath)
      ? configuredQueuePath
      : path.resolve(__dirname, "..", configuredQueuePath))
    : DEFAULT_SAMGUK_QUEUE_PATH;
  const baselineRetryBaseMs = boundedPositiveInt(
    env.SAMGUK_BASELINE_RETRY_BASE_MS,
    DEFAULT_BASELINE_RETRY_BASE_MS,
    10_000,
  );
  return Object.freeze({
    enabled: env.SAMGUK_TRACKING_ENABLED === "1",
    write: env.SAMGUK_TRACKING_WRITE_ENABLED === "1",
    queuePath,
    windowMs,
    baselineRetryAttempts: boundedPositiveInt(
      env.SAMGUK_BASELINE_RETRY_ATTEMPTS,
      DEFAULT_BASELINE_RETRY_ATTEMPTS,
      5,
    ),
    baselineRetryBaseMs,
    baselineRetryMaxMs: Math.max(baselineRetryBaseMs, boundedPositiveInt(
      env.SAMGUK_BASELINE_RETRY_MAX_MS,
      DEFAULT_BASELINE_RETRY_MAX_MS,
      10_000,
    )),
    cacheStampPath: resolveCacheStampPath(queuePath, env.SAMGUK_API_CACHE_STAMP_PATH),
  });
}

function samgukFmkoreaConfig(env = process.env, tracking = samgukTrackingConfig(env)) {
  const enabled = env.SAMGUK_FMKOREA_MONITOR_ENABLED === "1";
  const stateValue = String(env.SAMGUK_FMKOREA_STATE_PATH || "").trim();
  const aliasValue = String(env.SAMGUK_FMKOREA_ALIASES_PATH || "").trim();
  const aliasPath = aliasValue
    ? (path.isAbsolute(aliasValue) ? aliasValue : path.resolve(__dirname, "..", aliasValue))
    : null;
  const intervalValue = Number(env.SAMGUK_FMKOREA_MIN_INTERVAL_MS);
  const seasonStartAt = normalizeSeasonStartAt(env.SAMGUK_SEASON_START_AT);
  return Object.freeze({
    enabled,
    queuePath: tracking.queuePath,
    statePath: stateValue
      ? (path.isAbsolute(stateValue) ? stateValue : path.resolve(__dirname, "..", stateValue))
      : path.join(path.dirname(tracking.queuePath), "fmkorea-gear-monitor-state.json"),
    minIntervalMs: Number.isSafeInteger(intervalValue)
      && intervalValue >= DEFAULT_FMKOREA_MIN_INTERVAL_MS
      && intervalValue <= 60 * 60_000
      ? intervalValue
      : DEFAULT_FMKOREA_MIN_INTERVAL_MS,
    seasonStartAt,
    aliasesByPlayer: enabled && aliasPath ? loadAliasesByPlayerFile(aliasPath) : {},
  });
}

function createRunner({
  fetchNoticesFn = fetchNotices,
  parseHotFn = parseHot,
  promoteSamgukFn = promoteSamgukObservations,
  createSamgukSheetServiceFn = createSamgukSheetService,
  samgukSheetService = null,
  markSamgukCacheInvalidatedFn = markCacheInvalidated,
  fmkoreaMonitorFn = runFmkoreaGearMonitor,
  samgukTracking = samgukTrackingConfig(),
  samgukFmkorea = samgukFmkoreaConfig(process.env, samgukTracking),
  logger = console,
} = {}) {
  const fetchRuns = new Map();
  let parseRun = null;
  let samgukPromotionRun = null;
  let samgukFmkoreaRun = null;
  let sharedSamgukSheetService = samgukSheetService;

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

  function runSamgukPromotion() {
    if (!samgukTracking.enabled) return Promise.resolve(null);
    if (samgukPromotionRun) return samgukPromotionRun;

    samgukPromotionRun = Promise.resolve()
      .then(() => {
        if (!sharedSamgukSheetService) sharedSamgukSheetService = createSamgukSheetServiceFn();
        return promoteSamgukFn({
          queuePath: samgukTracking.queuePath,
          windowMs: samgukTracking.windowMs,
          write: samgukTracking.write,
          service: sharedSamgukSheetService,
          baselineRetryAttempts: samgukTracking.baselineRetryAttempts,
          baselineRetryBaseMs: samgukTracking.baselineRetryBaseMs,
          baselineRetryMaxMs: samgukTracking.baselineRetryMaxMs,
        });
      })
      .then((result) => {
        let cacheInvalidated = false;
        if (samgukTracking.write && (result?.written ?? 0) > 0) {
          try {
            markSamgukCacheInvalidatedFn(samgukTracking.cacheStampPath);
            cacheInvalidated = true;
          } catch (error) {
            logger.error("[cron] samguk API cache invalidation failed:", error.message);
          }
        }
        if (typeof logger.info === "function") {
          logger.info(
            `[cron] samguk promotion: mode=${samgukTracking.write ? "write" : "dry-run"}`
            + ` queued=${result?.queued ?? 0} snapshots=${result?.snapshots?.length ?? 0}`
            + ` written=${result?.written ?? 0} baselineAttempts=${result?.baselineAttempts ?? 0}`
            + ` cacheInvalidated=${cacheInvalidated}`,
          );
        }
        return result;
      })
      .catch((error) => {
        logger.error("[cron] samguk promotion failed:", error.message);
        return null;
      })
      .finally(() => { samgukPromotionRun = null; });
    return samgukPromotionRun;
  }

  function runSamgukFmkoreaMonitor() {
    if (!samgukFmkorea.enabled) return Promise.resolve(null);
    if (samgukFmkoreaRun) return samgukFmkoreaRun;

    samgukFmkoreaRun = Promise.resolve()
      .then(() => fmkoreaMonitorFn({
        queuePath: samgukFmkorea.queuePath,
        statePath: samgukFmkorea.statePath,
        minIntervalMs: samgukFmkorea.minIntervalMs,
        seasonStartAt: samgukFmkorea.seasonStartAt,
        aliasesByPlayer: samgukFmkorea.aliasesByPlayer,
      }))
      .then((result) => {
        if (result && typeof logger.info === "function") {
          logger.info(
            `[cron] samguk fmkorea: ${result.skipped ? "skipped" : "collected"}`
            + ` searched=${result.searched ?? 0} fetched=${result.fetched ?? 0}`
            + ` queued=${result.inserted ?? 0} errors=${result.errors?.length ?? 0}`,
          );
        }
        return result;
      })
      .catch((error) => {
        logger.error("[cron] samguk fmkorea failed:", error.message);
        return null;
      })
      .finally(() => { samgukFmkoreaRun = null; });
    return samgukFmkoreaRun;
  }

  async function runCycle({ includeRest = false } = {}) {
    const fetchTasks = [runFetch("popular")];
    if (includeRest) fetchTasks.push(runFetch("rest"));
    await Promise.all(fetchTasks);
    await runParse();
  }

  return {
    runCycle,
    runSamgukFmkoreaMonitor,
    runSamgukPromotion,
    samgukFmkorea,
    samgukTracking,
  };
}

function start() {
  const runner = createRunner();
  let stopped = false;

  // 수집이 끝난 뒤 파싱한다. 이전 파싱이 진행 중이면 같은 Promise를 공유해 중복 실행하지 않는다.
  const scheduledTask = cron.schedule("*/5 * * * *", () => {
    if (stopped) return;
    const includeRest = new Date().getMinutes() % 30 === 0;
    void runner.runCycle({ includeRest });
    void runner.runSamgukFmkoreaMonitor().then(() => runner.runSamgukPromotion());
  });
  const cleanupTask = cron.schedule("17 4 * * *", () => {
    if (stopped) return;
    void cleanupCommunity().catch(error => {
      console.error("[cron] community cleanup failed:", error.message);
    });
  });

  // 재기동 직후에도 전체 공지를 먼저 갱신하고 캘린더를 백필한다.
  void runner.runCycle({ includeRest: true });
  void runner.runSamgukFmkoreaMonitor().then(() => runner.runSamgukPromotion());

  const trackingMode = runner.samgukTracking.enabled
    ? (runner.samgukTracking.write ? "write" : "dry-run")
    : "disabled";
  const fmkoreaMode = runner.samgukFmkorea.enabled ? "collect" : "disabled";
  console.log(`[cron] scheduled: ordered fetch(popular/5m, rest/30m) -> parse-hot, samguk=${trackingMode}, fmkorea=${fmkoreaMode}, bootstrap enabled`);

  return () => {
    if (stopped) return;
    stopped = true;
    scheduledTask.stop();
    if (typeof scheduledTask.destroy === "function") scheduledTask.destroy();
    cleanupTask.stop();
    if (typeof cleanupTask.destroy === "function") cleanupTask.destroy();
  };
}

module.exports = { start, createRunner, samgukFmkoreaConfig, samgukTrackingConfig };
