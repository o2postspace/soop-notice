const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const {
  CURRENT_SEASON_ID,
  acquireObservationQueueLock,
  appendObservationQueue,
  compactObservationQueue,
  readObservationQueue,
} = require("../lib/samguk-observations");

const MODULE_PATH = path.resolve(__dirname, "../lib/samguk-observations.js");
const FIXED_NOW = Date.parse("2026-08-02T12:00:00.000Z");

function temporaryQueue(t, name = "queue.ndjson") {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "samguk-queue-lock-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, name);
}

function observation(index, overrides = {}) {
  return {
    seasonId: CURRENT_SEASON_ID,
    playerId: "P001",
    field: "strength",
    value: index,
    sourceType: "fmkorea",
    sourceId: `post-${index}`,
    sourceUrl: `https://www.fmkorea.com/${1000 + index}`,
    observedAt: `2026-08-02T10:00:${String(index).padStart(2, "0")}.000Z`,
    collectedAt: `2026-08-02T10:01:${String(index).padStart(2, "0")}.000Z`,
    ocrConfidence: null,
    ...overrides,
  };
}

function startNode(source, env = {}) {
  const child = spawn(process.execPath, ["-e", source], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  const done = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  return { child, done };
}

async function waitForFile(filePath, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(filePath)) {
    if (Date.now() >= deadline) throw new Error("child barrier timeout");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test("live lock은 stale 시간이 지나도 훔치지 않고 timeout하며 symlink lock을 거부한다", (t) => {
  const queue = temporaryQueue(t);
  const lock = acquireObservationQueueLock(queue);
  const lockPath = `${queue}.lock`;
  const ownerName = fs.readdirSync(lockPath)[0];
  const ownerBody = fs.readFileSync(path.join(lockPath, ownerName), "utf8");

  assert.equal(fs.statSync(lockPath).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(lockPath, ownerName)).mode & 0o777, 0o600);
  let timeoutError;
  try {
    appendObservationQueue(queue, observation(1), {
      now: FIXED_NOW,
      lockTimeoutMs: 25,
      lockStaleMs: 1,
    });
  } catch (error) {
    timeoutError = error;
  }
  assert.equal(timeoutError?.code, "queue_lock_timeout");
  assert.equal(timeoutError.message.includes(queue), false);
  assert.equal(timeoutError.message.includes(ownerBody.trim()), false);
  assert.equal(lock.release(), true);
  assert.equal(lock.release(), false);
  assert.equal(fs.existsSync(lockPath), false);

  const symlinkQueue = path.join(path.dirname(queue), "symlink-queue.ndjson");
  const secretTarget = path.join(path.dirname(queue), "secret-lock-target");
  fs.writeFileSync(secretTarget, "do-not-expose-or-change\n", { mode: 0o600 });
  fs.symlinkSync(secretTarget, `${symlinkQueue}.lock`);
  let symlinkError;
  try {
    appendObservationQueue(symlinkQueue, observation(2), { now: FIXED_NOW, lockTimeoutMs: 10 });
  } catch (error) {
    symlinkError = error;
  }
  assert.equal(symlinkError?.code, "invalid_lock_path");
  assert.equal(symlinkError.message.includes("do-not-expose-or-change"), false);
  assert.equal(fs.readFileSync(secretTarget, "utf8"), "do-not-expose-or-change\n");
  assert.equal(fs.lstatSync(`${symlinkQueue}.lock`).isSymbolicLink(), true);
});

test("release는 directory inode와 owner token이 모두 일치할 때만 자기 lock을 지운다", (t) => {
  const inodeQueue = temporaryQueue(t, "inode.ndjson");
  const inodeLock = acquireObservationQueueLock(inodeQueue);
  const inodeLockPath = `${inodeQueue}.lock`;
  fs.renameSync(inodeLockPath, `${inodeLockPath}.old`);
  fs.mkdirSync(inodeLockPath, { mode: 0o700 });
  assert.throws(
    () => inodeLock.release(),
    error => error.code === "queue_lock_owner_mismatch",
  );
  assert.equal(fs.existsSync(inodeLockPath), true);

  const ownerQueue = path.join(path.dirname(inodeQueue), "owner.ndjson");
  const ownerLock = acquireObservationQueueLock(ownerQueue);
  const ownerLockPath = `${ownerQueue}.lock`;
  const ownerFile = path.join(ownerLockPath, fs.readdirSync(ownerLockPath)[0]);
  const ownerInode = fs.statSync(ownerFile).ino;
  fs.writeFileSync(ownerFile, "{}\n", { mode: 0o600 });
  assert.equal(fs.statSync(ownerFile).ino, ownerInode);
  assert.throws(
    () => ownerLock.release(),
    error => error.code === "queue_lock_owner_mismatch",
  );
  assert.equal(fs.existsSync(ownerFile), true);
});

test("owner fsync 직후 canonical lock inode가 바뀌면 lock 획득으로 반환하지 않는다", (t) => {
  const queue = temporaryQueue(t);
  const child = spawnSync(process.execPath, ["-e", [
    "const fs = require('node:fs');",
    "const originalFsync = fs.fsyncSync;",
    "let intercepted = false;",
    "fs.fsyncSync = function patchedFsync(descriptor) {",
    "  const result = originalFsync(descriptor);",
    "  if (!intercepted) {",
    "    intercepted = true;",
    "    fs.renameSync(process.env.LOCK_PATH, `${process.env.LOCK_PATH}.preempted`);",
    "    fs.mkdirSync(process.env.LOCK_PATH, { mode: 0o700 });",
    "  }",
    "  return result;",
    "};",
    "const { acquireObservationQueueLock } = require(process.env.MODULE_PATH);",
    "try {",
    "  acquireObservationQueueLock(process.env.QUEUE_PATH, { lockTimeoutMs: 30, lockStaleMs: 60000 });",
    "  process.stderr.write('unexpected_lock_acquisition');",
    "  process.exitCode = 2;",
    "} catch (error) {",
    "  if (error.code !== 'queue_lock_timeout') throw error;",
    "}",
  ].join("\n")], {
    env: {
      ...process.env,
      MODULE_PATH,
      QUEUE_PATH: queue,
      LOCK_PATH: `${queue}.lock`,
    },
    encoding: "utf8",
  });

  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stderr.includes("unexpected_lock_acquisition"), false);
  assert.equal(fs.statSync(`${queue}.lock`).isDirectory(), true);
});

test("종료된 process의 valid lock은 즉시, 생성 중 crash로 남은 빈 lock은 grace 뒤 복구한다", (t) => {
  const queue = temporaryQueue(t);
  const child = spawnSync(process.execPath, ["-e", [
    "const { acquireObservationQueueLock } = require(process.env.MODULE_PATH);",
    "global.lock = acquireObservationQueueLock(process.env.QUEUE_PATH);",
  ].join("\n")], {
    env: { ...process.env, MODULE_PATH, QUEUE_PATH: queue },
    encoding: "utf8",
  });
  assert.equal(child.status, 0, child.stderr);

  const lockPath = `${queue}.lock`;
  appendObservationQueue(queue, observation(3), {
    now: FIXED_NOW,
    lockTimeoutMs: 500,
    lockStaleMs: 30_000,
  });
  assert.deepEqual(readObservationQueue(queue).map(row => row.value), [3]);
  assert.equal(fs.existsSync(lockPath), false);
  assert.deepEqual(
    fs.readdirSync(path.dirname(queue)).filter(name => name.includes(".stale-")),
    [],
  );

  const emptyQueue = path.join(path.dirname(queue), "empty-crash.ndjson");
  const emptyLockPath = `${emptyQueue}.lock`;
  fs.mkdirSync(emptyLockPath, { mode: 0o700 });
  assert.throws(
    () => appendObservationQueue(emptyQueue, observation(4), {
      now: FIXED_NOW,
      lockTimeoutMs: 25,
      lockStaleMs: 1_000,
    }),
    error => error.code === "queue_lock_timeout",
  );
  const oldTime = new Date(Date.now() - 60_000);
  fs.utimesSync(emptyLockPath, oldTime, oldTime);
  appendObservationQueue(emptyQueue, observation(4), {
    now: FIXED_NOW,
    lockTimeoutMs: 500,
    lockStaleMs: 1_000,
  });
  assert.deepEqual(readObservationQueue(emptyQueue).map(row => row.value), [4]);
  assert.equal(fs.existsSync(emptyLockPath), false);
});

test("compact transform 오류와 thenable은 원본 queue를 보존하고 lock을 해제한다", (t) => {
  const queue = temporaryQueue(t);
  appendObservationQueue(queue, observation(5), { now: FIXED_NOW });
  const original = fs.readFileSync(queue, "utf8");
  const transformError = new Error("transform-original-error");

  assert.throws(
    () => compactObservationQueue(queue, () => { throw transformError; }),
    error => error === transformError,
  );
  assert.equal(fs.readFileSync(queue, "utf8"), original);
  assert.equal(fs.existsSync(`${queue}.lock`), false);

  assert.throws(
    () => compactObservationQueue(queue, () => Promise.resolve([])),
    error => error.code === "invalid_schema",
  );
  assert.equal(fs.readFileSync(queue, "utf8"), original);
  assert.equal(fs.existsSync(`${queue}.lock`), false);

  const tamperedQueue = path.join(path.dirname(queue), "tampered.ndjson");
  appendObservationQueue(tamperedQueue, observation(8), { now: FIXED_NOW });
  const originalError = new Error("primary-transform-error");
  assert.throws(
    () => compactObservationQueue(tamperedQueue, () => {
      const lockPath = `${tamperedQueue}.lock`;
      const ownerPath = path.join(lockPath, fs.readdirSync(lockPath)[0]);
      fs.writeFileSync(ownerPath, "{}\n", { mode: 0o600 });
      throw originalError;
    }),
    error => error === originalError,
  );
  assert.deepEqual(readObservationQueue(tamperedQueue).map(row => row.value), [8]);
  assert.equal(fs.existsSync(`${tamperedQueue}.lock`), true);
});

test("compact read-transform-rewrite 동안 다른 process append가 lock 뒤에서 대기해 유실되지 않는다", async (t) => {
  const queue = temporaryQueue(t);
  const compactReady = path.join(path.dirname(queue), "compact-ready");
  const appendReady = path.join(path.dirname(queue), "append-ready");
  const release = path.join(path.dirname(queue), "release");
  appendObservationQueue(queue, observation(6), { now: FIXED_NOW });

  const compactor = startNode([
    "const fs = require('node:fs');",
    "const { compactObservationQueue } = require(process.env.MODULE_PATH);",
    "const wait = new Int32Array(new SharedArrayBuffer(4));",
    "compactObservationQueue(process.env.QUEUE_PATH, () => {",
    "  fs.writeFileSync(process.env.COMPACT_READY, 'ready', { mode: 0o600 });",
    "  const deadline = Date.now() + 5000;",
    "  while (!fs.existsSync(process.env.RELEASE_PATH)) {",
    "    if (Date.now() >= deadline) throw new Error('barrier_timeout');",
    "    Atomics.wait(wait, 0, 0, 10);",
    "  }",
    "  return [];",
    "}, { lockTimeoutMs: 5000, lockStaleMs: 60000 });",
  ].join("\n"), {
    MODULE_PATH,
    QUEUE_PATH: queue,
    COMPACT_READY: compactReady,
    RELEASE_PATH: release,
  });

  try {
    await waitForFile(compactReady);
    const appender = startNode([
      "const fs = require('node:fs');",
      "const { appendObservationQueue } = require(process.env.MODULE_PATH);",
      "fs.writeFileSync(process.env.APPEND_READY, 'ready', { mode: 0o600 });",
      "appendObservationQueue(",
      "  process.env.QUEUE_PATH,",
      "  JSON.parse(Buffer.from(process.env.OBSERVATION_B64, 'base64').toString('utf8')),",
      "  { lockTimeoutMs: 5000, lockStaleMs: 60000 },",
      ");",
    ].join("\n"), {
      MODULE_PATH,
      QUEUE_PATH: queue,
      APPEND_READY: appendReady,
      OBSERVATION_B64: Buffer.from(JSON.stringify(observation(7))).toString("base64"),
    });
    await waitForFile(appendReady);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(appender.child.exitCode, null);
    fs.writeFileSync(release, "release", { mode: 0o600 });

    const [compactResult, appendResult] = await Promise.all([compactor.done, appender.done]);
    assert.equal(compactResult.code, 0, compactResult.stderr);
    assert.equal(appendResult.code, 0, appendResult.stderr);
  } finally {
    if (!fs.existsSync(release)) fs.writeFileSync(release, "release", { mode: 0o600 });
  }

  assert.deepEqual(readObservationQueue(queue).map(row => row.value), [7]);
  assert.equal(fs.existsSync(`${queue}.lock`), false);
});

test("여러 process의 동시 append도 유일 관측과 dedupe를 보존한다", async (t) => {
  const queue = temporaryQueue(t);
  const appendSource = [
    "const { appendObservationQueue } = require(process.env.MODULE_PATH);",
    "appendObservationQueue(",
    "  process.env.QUEUE_PATH,",
    "  JSON.parse(Buffer.from(process.env.OBSERVATION_B64, 'base64').toString('utf8')),",
    "  { lockTimeoutMs: 5000, lockStaleMs: 60000 },",
    ");",
  ].join("\n");
  const children = Array.from({ length: 4 }, (_value, index) => startNode(appendSource, {
    MODULE_PATH,
    QUEUE_PATH: queue,
    OBSERVATION_B64: Buffer.from(JSON.stringify(observation(index + 10))).toString("base64"),
  }));
  const results = await Promise.all(children.map(child => child.done));
  results.forEach(result => assert.equal(result.code, 0, result.stderr));
  assert.deepEqual(readObservationQueue(queue).map(row => row.value).sort((a, b) => a - b), [10, 11, 12, 13]);

  const duplicate = observation(20);
  const duplicates = Array.from({ length: 3 }, () => startNode(appendSource, {
    MODULE_PATH,
    QUEUE_PATH: queue,
    OBSERVATION_B64: Buffer.from(JSON.stringify(duplicate)).toString("base64"),
  }));
  const duplicateResults = await Promise.all(duplicates.map(child => child.done));
  duplicateResults.forEach(result => assert.equal(result.code, 0, result.stderr));
  assert.equal(readObservationQueue(queue).filter(row => row.value === 20).length, 1);
  assert.equal(fs.existsSync(`${queue}.lock`), false);
});
