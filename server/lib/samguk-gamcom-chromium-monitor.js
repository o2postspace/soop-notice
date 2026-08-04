"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const FALLBACK = require("../data/samguk-fallback.json");
const {
  buildGamcomSnapshots,
  GAMCOM_FACTION_URLS,
  mergeGamcomMembers,
  NUMERIC_FIELDS,
  parseGamcomFactionPayload,
} = require("./samguk-gamcom-sync");
const {
  acquireObservationQueueLock,
  CURRENT_SEASON_ID,
} = require("./samguk-observations");
const { createSamgukSheetService } = require("./samguk-sheet");
const { createSamgukSheetWriter } = require("./samguk-sheet-writer");

const DEFAULT_CHROMIUM_PATH = "/usr/bin/google-chrome";
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_VIRTUAL_TIME_BUDGET_MS = 12_000;
const DEFAULT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const DEFAULT_ATTEMPTS = 2;
const MAX_TIMEOUT_MS = 25_000;
const EXPECTED_ROSTER_COUNT = 90;
const DEFAULT_LOCK_PATH = path.join(os.homedir(), ".cache", "soop-notice", "samguk-gamcom-monitor.guard");
const VISIBLE_FIELDS = new Set(["horse", ...NUMERIC_FIELDS]);

class SamgukGamcomChromiumError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SamgukGamcomChromiumError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new SamgukGamcomChromiumError(code, message);
}

function boundedInteger(value, fallback, minimum, maximum, label) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    fail("invalid_config", `${label}은(는) ${minimum}~${maximum} 정수여야 합니다.`);
  }
  return parsed;
}

function chromiumExecutable(value) {
  const resolved = String(value || DEFAULT_CHROMIUM_PATH).trim();
  if (!path.isAbsolute(resolved) || resolved.length > 4_096
      || /[\u0000-\u001F\u007F]/.test(resolved)) {
    fail("invalid_config", "Chromium 실행 경로는 안전한 절대경로여야 합니다.");
  }
  return path.normalize(resolved);
}

function absoluteLockPath(value) {
  const queuePath = String(process.env.SAMGUK_OBSERVATION_QUEUE_PATH || "").trim();
  const fallback = path.isAbsolute(queuePath)
    ? path.join(path.dirname(queuePath), ".gamcom-monitor.guard")
    : DEFAULT_LOCK_PATH;
  const raw = String(value || process.env.SAMGUK_GAMCOM_LOCK_PATH || fallback).trim();
  if (!path.isAbsolute(raw) || raw.length > 4_096
      || /[\u0000-\u001F\u007F]/.test(raw)) {
    fail("invalid_config", "Gamcom monitor lock은 안전한 절대경로여야 합니다.");
  }
  return path.normalize(raw);
}

function abortError() {
  return new SamgukGamcomChromiumError("aborted", "Gamcom Chromium 조회가 중단되었습니다.");
}

function chromiumEnvironment(profileDir) {
  return {
    HOME: profileDir,
    LANG: "C.UTF-8",
    PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    TMPDIR: os.tmpdir(),
    XDG_CACHE_HOME: path.join(profileDir, ".cache"),
    XDG_CONFIG_HOME: path.join(profileDir, ".config"),
  };
}

function terminateChromium(child) {
  if (process.platform !== "win32" && Number.isSafeInteger(child?.pid) && child.pid > 0) {
    try {
      process.kill(-child.pid, "SIGKILL");
      return;
    } catch {}
  }
  try {
    child?.kill("SIGKILL");
  } catch {}
}

function runChromiumPage({
  chromiumPath,
  profileDir,
  url,
  timeoutMs,
  virtualTimeBudgetMs,
  maxOutputBytes,
  spawnImpl = spawn,
  signal,
}) {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const child = spawnImpl(chromiumPath, [
      "--headless=new",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      `--user-data-dir=${profileDir}`,
      `--virtual-time-budget=${virtualTimeBudgetMs}`,
      "--dump-dom",
      url,
    ], {
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "ignore"],
      env: chromiumEnvironment(profileDir),
    });
    const chunks = [];
    let total = 0;
    let settled = false;
    let oversized = false;
    let timedOut = false;
    let aborted = false;
    const onAbort = () => {
      aborted = true;
      terminateChromium(child);
    };
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminateChromium(child);
    }, timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    child.stdout.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxOutputBytes) {
        oversized = true;
        terminateChromium(child);
        return;
      }
      chunks.push(chunk);
    });
    child.once("error", () => {
      terminateChromium(child);
      finish(new SamgukGamcomChromiumError(
        "chromium_unavailable",
        "Gamcom 수집용 Chromium을 시작하지 못했습니다.",
      ));
    });
    child.once("close", (code, signal) => {
      terminateChromium(child);
      if (aborted) {
        finish(abortError());
        return;
      }
      if (timedOut) {
        finish(new SamgukGamcomChromiumError(
          "upstream_timeout",
          "Gamcom Chromium 조회 시간이 초과되었습니다.",
        ));
        return;
      }
      if (oversized) {
        finish(new SamgukGamcomChromiumError(
          "response_too_large",
          "Gamcom Chromium 응답이 제한 크기를 초과했습니다.",
        ));
        return;
      }
      if (code !== 0 || signal) {
        finish(new SamgukGamcomChromiumError(
          "upstream_error",
          "Gamcom Chromium 조회가 정상 종료되지 않았습니다.",
        ));
        return;
      }
      const payload = Buffer.concat(chunks, total).toString("utf8");
      if (payload.length < 2) {
        finish(new SamgukGamcomChromiumError("invalid_response", "Gamcom Chromium 응답이 비어 있습니다."));
        return;
      }
      finish(null, payload);
    });
  });
}

function defaultCreateProfileDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "soop-gamcom-chrome-"));
}

function defaultRemoveProfileDir(profileDir) {
  const temporaryRoot = path.resolve(os.tmpdir());
  const resolved = path.resolve(profileDir);
  const expectedPrefix = path.join(temporaryRoot, "soop-gamcom-chrome-");
  if (!resolved.startsWith(expectedPrefix) || resolved === temporaryRoot) {
    fail("unsafe_cleanup", "Gamcom Chromium 임시 경로를 안전하게 확인하지 못했습니다.");
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}

async function collectGamcomFactionsWithChromium(options = {}) {
  const runPage = options.runPage || runChromiumPage;
  const createProfileDir = options.createProfileDir || defaultCreateProfileDir;
  const removeProfileDir = options.removeProfileDir || defaultRemoveProfileDir;
  if (typeof runPage !== "function" || typeof createProfileDir !== "function"
      || typeof removeProfileDir !== "function") {
    fail("invalid_config", "Gamcom Chromium 실행 의존성이 올바르지 않습니다.");
  }
  const config = {
    chromiumPath: chromiumExecutable(options.chromiumPath),
    timeoutMs: boundedInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, 1_000, MAX_TIMEOUT_MS, "timeoutMs"),
    virtualTimeBudgetMs: boundedInteger(
      options.virtualTimeBudgetMs,
      DEFAULT_VIRTUAL_TIME_BUDGET_MS,
      1_000,
      60_000,
      "virtualTimeBudgetMs",
    ),
    maxOutputBytes: boundedInteger(
      options.maxOutputBytes,
      DEFAULT_MAX_OUTPUT_BYTES,
      64 * 1024,
      4 * 1024 * 1024,
      "maxOutputBytes",
    ),
    attempts: boundedInteger(options.attempts, DEFAULT_ATTEMPTS, 1, 3, "attempts"),
  };
  const outcomes = await Promise.allSettled(Object.entries(GAMCOM_FACTION_URLS).map(async ([nation, url]) => {
    const profileDir = createProfileDir();
    try {
      let parsed = null;
      let lastError = null;
      for (let attempt = 0; attempt < config.attempts; attempt += 1) {
        if (options.signal?.aborted) throw abortError();
        try {
          const payload = await runPage({
            ...config,
            profileDir,
            nation,
            url,
            attempt,
            signal: options.signal,
          });
          parsed = parseGamcomFactionPayload(payload, { expectedNation: nation });
          break;
        } catch (error) {
          lastError = error;
        }
      }
      if (!parsed) {
        if (lastError instanceof SamgukGamcomChromiumError) throw lastError;
        fail("invalid_response", `${nation} Gamcom 30명 자료를 해석하지 못했습니다.`);
      }
      return parsed.map(row => Object.freeze({ ...row, sourceUrl: url }));
    } finally {
      removeProfileDir(profileDir);
    }
  }));
  const failed = outcomes.find(outcome => outcome.status === "rejected");
  if (failed) throw failed.reason;
  const rows = outcomes.flatMap(outcome => outcome.value);
  if (options.signal?.aborted) throw abortError();
  const names = new Set(rows.map(row => row.nickname));
  if (rows.length !== EXPECTED_ROSTER_COUNT || names.size !== EXPECTED_ROSTER_COUNT) {
    fail("invalid_roster", `Gamcom 전체 참가자가 ${rows.length}/90명입니다.`);
  }
  return Object.freeze(rows);
}

function snapshotVisible(payload, merged) {
  let members;
  try {
    members = currentMembersWithPlayerIds(payload);
  } catch {
    return false;
  }
  const byId = new Map(members.map(member => [member.playerId, member]));
  return merged.members.every((expected, index) => {
    const current = byId.get(expected.playerId);
    const changedFields = merged.referenceRows[index]?.changedFields || [];
    return changedFields.filter(field => VISIBLE_FIELDS.has(field)).every((field) => {
      if (typeof expected[field] === "number") return Number(current?.[field]) >= expected[field];
      return current?.[field] === expected[field];
    });
  });
}

function waitWithSignal(milliseconds, signal) {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => finish(null), milliseconds);
    const onAbort = () => {
      finish(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

async function waitForSnapshotVisibility(service, merged, options = {}) {
  const attempts = boundedInteger(options.visibilityAttempts, 4, 1, 8, "visibilityAttempts");
  const delayMs = boundedInteger(options.visibilityDelayMs, 250, 10, 5_000, "visibilityDelayMs");
  const sleep = options.sleep || waitWithSignal;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (options.signal?.aborted) throw abortError();
    const payload = await service.load();
    if (snapshotVisible(payload, merged)) return true;
    if (attempt + 1 < attempts) await sleep(delayMs, options.signal);
  }
  return false;
}

function currentMembersWithPlayerIds(payload) {
  if (!payload || payload.source !== "google-sheet" || payload.stale === true
      || payload.seasonId !== CURRENT_SEASON_ID
      || !Array.isArray(payload.members) || payload.members.length !== EXPECTED_ROSTER_COUNT) {
    fail("invalid_baseline", "최신 후국지 Google Sheet 90명 기준값이 필요합니다.");
  }
  const identities = new Map(FALLBACK.members.map((member, index) => [
    member.name,
    Object.freeze({
      playerId: `P${String(index + 1).padStart(3, "0")}`,
      nation: member.nation,
      soopId: member.soopId,
    }),
  ]));
  const seen = new Set();
  const members = payload.members.map((member) => {
    const identity = identities.get(member?.name);
    if (!identity || seen.has(member.name)
        || identity.nation !== member.nation || identity.soopId !== member.soopId) {
      fail("invalid_roster", "운영원장 참가자와 후국지 고정 식별자가 일치하지 않습니다.");
    }
    seen.add(member.name);
    return Object.freeze({ ...member, playerId: identity.playerId });
  });
  if (seen.size !== EXPECTED_ROSTER_COUNT) fail("invalid_roster", "운영원장 참가자가 90명 exact-set이 아닙니다.");
  return Object.freeze(members);
}

async function runGamcomChromiumMonitor(options = {}) {
  const collectedAt = new Date(options.now ? options.now() : Date.now()).toISOString();
  const acquireLock = options.acquireLock || acquireObservationQueueLock;
  let monitorLock;
  try {
    monitorLock = acquireLock(absoluteLockPath(options.lockPath), {
      lockTimeoutMs: 0,
      lockStaleMs: 5 * 60_000,
    });
  } catch (error) {
    if (error?.code === "queue_lock_timeout") {
      return Object.freeze({
        collectedAt,
        matched: 0,
        changedCells: 0,
        conflicts: 0,
        snapshots: 0,
        written: 0,
        duplicates: 0,
        visible: null,
        skipped: true,
        skipReason: "busy",
        mode: options.write === true ? "write" : "dry-run",
      });
    }
    throw error;
  }
  try {
    if (options.signal?.aborted) throw abortError();
    const service = options.service || createSamgukSheetService();
    if (!service || typeof service.load !== "function") fail("invalid_config", "Sheet service가 필요합니다.");
    let writer = options.writer || null;
    if (options.write === true) {
      writer ||= createSamgukSheetWriter();
      if (!writer || typeof writer.appendSnapshots !== "function") {
        fail("invalid_config", "Gamcom batch 저장에는 OAuth Google Sheet writer가 필요합니다.");
      }
    }
    const baseline = await service.load();
    const currentMembers = currentMembersWithPlayerIds(baseline);
    const externalRows = await collectGamcomFactionsWithChromium(options);
    const merged = mergeGamcomMembers(currentMembers, externalRows, { collectedAt });
    const snapshots = buildGamcomSnapshots(merged, {
      sheetUrl: baseline.sheetUrl,
      collectedAt,
    });
    let writeResult = null;
    let visible = null;
    if (options.write === true && snapshots.length > 0) {
      writeResult = await writer.appendSnapshots(snapshots);
      visible = writeResult.appendedCount > 0
        ? await waitForSnapshotVisibility(service, merged, options)
        : null;
    }
    return Object.freeze({
      collectedAt,
      matched: merged.matchedCount,
      changedCells: merged.changedCount,
      conflicts: merged.conflicts.length,
      snapshots: snapshots.length,
      written: writeResult?.appendedCount || 0,
      duplicates: writeResult?.duplicateCount || 0,
      visible,
      skipped: false,
      skipReason: null,
      mode: options.write === true ? "write" : "dry-run",
    });
  } finally {
    monitorLock.release();
  }
}

module.exports = {
  DEFAULT_ATTEMPTS,
  DEFAULT_CHROMIUM_PATH,
  DEFAULT_LOCK_PATH,
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_VIRTUAL_TIME_BUDGET_MS,
  MAX_TIMEOUT_MS,
  SamgukGamcomChromiumError,
  collectGamcomFactionsWithChromium,
  currentMembersWithPlayerIds,
  runChromiumPage,
  runGamcomChromiumMonitor,
  snapshotVisible,
  waitForSnapshotVisibility,
};
