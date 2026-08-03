"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createCandidateFrameArchive } = require("../lib/samguk-candidate-frame-archive");

const PNG = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  Buffer.from("candidate-frame"),
]);
const HASH = crypto.createHash("sha256").update(PNG).digest("hex");

test("후보 PNG를 0600 파일로 보존하고 다시 읽은 뒤 보존시간·개수 상한으로 정리한다", async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "samguk-frame-archive-"));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  let now = Date.now();
  const store = createCandidateFrameArchive({
    stateDir,
    retentionMs: 60_000,
    maxFiles: 2,
    clock: () => now,
  });
  const context = sampleIndex => ({
    playerId: "P001",
    targetId: "P001",
    observedAtMs: now,
    mediaSequence: 100,
    sampleIndex,
    evidenceHash: HASH,
  });
  const first = await store.archive(PNG, context(1));
  assert.equal(fs.statSync(path.join(store.directory, first)).mode & 0o777, 0o600);
  assert.deepEqual(await store.read(first), PNG);
  now += 1_000;
  await store.archive(PNG, context(2));
  now += 1_000;
  await store.archive(PNG, context(3));
  assert.equal(fs.readdirSync(store.directory).filter(name => name.endsWith(".png")).length, 2);
  now += 61_000;
  assert.equal(await store.cleanup(now, true), 2);
  assert.deepEqual(fs.readdirSync(store.directory), []);
});

test("PNG hash나 player context가 다르면 파일을 만들지 않는다", async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "samguk-frame-invalid-"));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const now = Date.now();
  const store = createCandidateFrameArchive({ stateDir, clock: () => now });
  assert.throws(() => store.archive(PNG, {
    playerId: "bad",
    targetId: "bad",
    observedAtMs: now,
    mediaSequence: 1,
    sampleIndex: 0,
    evidenceHash: "0".repeat(64),
  }), error => error.code === "invalid_context");
  await assert.rejects(store.read("../../outside.png"), error => error.code === "invalid_reference");
  assert.deepEqual(fs.readdirSync(store.directory), []);
});
