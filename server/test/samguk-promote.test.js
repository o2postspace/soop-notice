const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  appendObservationQueue,
  readObservationQueue,
} = require("../lib/samguk-observations");
const { readPromotionAudit } = require("../lib/samguk-promotion-audit");
const {
  baselineObservations,
  buildPromotionSnapshots,
  compactQueuedObservations,
  promote,
} = require("../scripts/samguk-promote-observations");

const FIXED_NOW = Date.parse("2026-08-02T10:30:00.000Z");

function temporaryQueue(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "samguk-promote-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, "queue.ndjson");
}

function payload() {
  return {
    source: "google-sheet",
    stale: false,
    sheetUrl: "https://docs.google.com/spreadsheets/d/test-sheet/edit",
    updatedAt: "2026-08-02T10:00:00.000Z",
    members: [{
      soopId: "cnsgkcnehd74",
      level: 10, horse: "백룡마", horseLevel: 1, weapon: 2, helmet: 1, armor: 1, shoes: 1,
      strength: 10, agility: 2, vitality: 3, intelligence: 4, powerScore: null,
      maxHealth: null, basicAttackDamage: null, basicAttackSampleCount: null,
      basicAttackTarget: null, combatConditions: null,
      observedAt: "2026-08-02T10:00:00.000Z",
    }],
  };
}

function candidate(sourceType, value, sourceId, observedAt = "2026-08-02T10:10:00.000Z") {
  const sourceUrl = sourceType === "fmkorea"
    ? "https://www.fmkorea.com/123"
    : "https://play.sooplive.com/cnsgkcnehd74";
  return {
    playerId: "P001", field: "strength", value, sourceType, sourceId, sourceUrl,
    observedAt, collectedAt: observedAt,
    ocrConfidence: sourceType === "broadcast" ? 0.98 : null,
  };
}

test("현재 Sheet를 player/field baseline 관측으로 만든다", () => {
  const rows = baselineObservations(payload(), Date.parse("2026-08-02T10:20:00Z"));
  assert.equal(rows.length, 11);
  assert.ok(rows.every(row => row.playerId === "P001" && row.sourceType === "sheet"));
  assert.equal(rows.find(row => row.field === "strength").value, 10);
});

test("단독 후보는 버리고 Sheet와 일치한 최신 후보만 완전 스냅샷으로 승격한다", () => {
  assert.deepEqual(buildPromotionSnapshots(payload(), [candidate("fmkorea", 11, "post-only")], {
    windowMs: 60 * 60 * 1000,
    now: Date.parse("2026-08-02T10:30:00Z"),
  }), []);

  const snapshots = buildPromotionSnapshots(payload(), [
    candidate("fmkorea", 11, "post-1"),
    candidate("broadcast", 11, "frame-1", "2026-08-02T10:11:00.000Z"),
  ], { windowMs: 60 * 60 * 1000, now: Date.parse("2026-08-02T10:30:00Z") });
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].fields.strength, 11);
  assert.equal(snapshots[0].fields.weapon, 2);
  assert.equal(Object.keys(snapshots[0].fields).length, 17);
  assert.equal(snapshots[0].sourceCount, 2);
  assert.equal(snapshots[0].verification, "cross-source");
  assert.ok(snapshots[0].sourceTypes.includes(snapshots[0].primarySourceType));
  assert.deepEqual(snapshots[0].sourceTypes, ["fmkorea", "broadcast"]);
});

test("write 모드는 승격 스냅샷만 writer에 전달한다", async () => {
  const written = [];
  const result = await promote({
    observations: [
      candidate("fmkorea", 11, "post-write"),
      candidate("broadcast", 11, "frame-write", "2026-08-02T10:11:00.000Z"),
    ],
    write: true,
    service: { load: async () => payload() },
    writer: { appendSnapshot: async snapshot => { written.push(snapshot); return { ok: true }; } },
    windowMs: 60 * 60 * 1000,
    now: () => FIXED_NOW,
  });
  assert.equal(result.written, 1);
  assert.equal(written.length, 1);
  assert.equal(written[0].fields.strength, 11);
  assert.deepEqual(written[0].sourceTypes, ["fmkorea", "broadcast"]);
  assert.equal(result.compaction, null);
});

test("compaction은 반영된 값만 제거하고 충돌·미해결 관측은 보존한다", () => {
  const accepted = [
    candidate("fmkorea", 11, "post-accepted"),
    candidate("broadcast", 11, "frame-accepted", "2026-08-02T10:11:00.000Z"),
  ];
  const snapshots = buildPromotionSnapshots(payload(), accepted, {
    windowMs: 60 * 60 * 1000,
    now: FIXED_NOW,
  });
  const conflict = candidate("broadcast", 12, "frame-conflict", "2026-08-02T10:12:00.000Z");
  const compacted = compactQueuedObservations(payload(), snapshots, [...accepted, conflict], {
    now: FIXED_NOW,
  });

  assert.deepEqual(compacted.removed.map(row => row.value), [11, 11]);
  assert.deepEqual(compacted.retained.map(row => row.value), [12]);

  const unresolved = compactQueuedObservations(payload(), [], [
    candidate("fmkorea", 10, "sheet-match"),
    candidate("broadcast", 12, "unresolved-conflict"),
    { ...candidate("fmkorea", 20, "unknown-player"), playerId: "P999" },
  ], { now: FIXED_NOW });
  assert.equal(unresolved.removed.length, 0);
  assert.equal(unresolved.retained.length, 3);

  const alreadyCurrent = compactQueuedObservations(payload(), [], [
    candidate("fmkorea", 10, "already-current"),
  ], { now: FIXED_NOW });
  assert.equal(alreadyCurrent.removed.length, 1);
  assert.equal(alreadyCurrent.retained.length, 0);
});

test("주입 관측은 명시한 rewriteFn만 snapshot 완료 뒤 호출한다", async () => {
  const events = [];
  let retained;
  const result = await promote({
    observations: [
      candidate("fmkorea", 11, "post-explicit"),
      candidate("broadcast", 11, "frame-explicit", "2026-08-02T10:11:00.000Z"),
      candidate("broadcast", 12, "frame-unresolved", "2026-08-02T10:12:00.000Z"),
    ],
    write: true,
    service: { load: async () => payload() },
    writer: { appendSnapshot: async () => { events.push("write"); return { ok: true }; } },
    rewriteFn: async (_queuePath, observations) => {
      events.push("rewrite");
      retained = observations;
      return { ok: true };
    },
    windowMs: 60 * 60 * 1000,
    now: () => FIXED_NOW,
  });

  assert.deepEqual(events, ["write", "rewrite"]);
  assert.deepEqual(retained.map(row => row.value), [12]);
  assert.equal(result.compaction.removed, 2);
  assert.equal(result.compaction.retained, 1);
});

test("snapshot write 실패 시 queue rewrite를 호출하지 않는다", async () => {
  let rewriteCalls = 0;
  await assert.rejects(promote({
    observations: [
      candidate("fmkorea", 11, "post-failure"),
      candidate("broadcast", 11, "frame-failure", "2026-08-02T10:11:00.000Z"),
    ],
    write: true,
    service: { load: async () => payload() },
    writer: { appendSnapshot: async () => { throw new Error("writer failed"); } },
    rewriteFn: async () => { rewriteCalls += 1; },
    windowMs: 60 * 60 * 1000,
    now: () => FIXED_NOW,
  }), /writer failed/);
  assert.equal(rewriteCalls, 0);
});

test("실제 queue는 write 중 추가된 관측까지 다시 읽어 원자 compact한다", async (t) => {
  const queuePath = temporaryQueue(t);
  const archivePath = `${queuePath}.promoted`;
  appendObservationQueue(queuePath, [
    candidate("fmkorea", 11, "post-file"),
    candidate("broadcast", 11, "frame-file", "2026-08-02T10:11:00.000Z"),
  ], { now: FIXED_NOW });

  const result = await promote({
    queuePath,
    archivePath,
    write: true,
    service: { load: async () => payload() },
    writer: {
      appendSnapshot: async () => {
        appendObservationQueue(queuePath, candidate(
          "broadcast",
          12,
          "late-frame",
          "2026-08-02T10:12:00.000Z",
        ), { now: FIXED_NOW });
        return { ok: true };
      },
    },
    windowMs: 60 * 60 * 1000,
    now: () => FIXED_NOW,
  });

  const remaining = readObservationQueue(queuePath);
  assert.equal(result.compaction.scanned, 3);
  assert.equal(result.compaction.removed, 2);
  assert.equal(result.compaction.retained, 1);
  assert.equal(result.compaction.archived, 2);
  assert.deepEqual(remaining.map(row => row.value), [12]);
  assert.deepEqual(readPromotionAudit(archivePath).map(row => row.value), [11, 11]);
  assert.equal(fs.statSync(queuePath).mode & 0o777, 0o600);
});

test("실제 queue의 audit 기록은 queue lock 안에서 동기 완료한다", async (t) => {
  const queuePath = temporaryQueue(t);
  const archivePath = `${queuePath}.promoted`;
  appendObservationQueue(queuePath, [
    candidate("fmkorea", 11, "post-lock"),
    candidate("broadcast", 11, "frame-lock", "2026-08-02T10:11:00.000Z"),
  ], { now: FIXED_NOW });
  let archiveCalled = false;

  const result = await promote({
    queuePath,
    archivePath,
    write: true,
    service: { load: async () => payload() },
    writer: { appendSnapshot: async () => ({ ok: true }) },
    archiveFn: (_path, rows) => {
      archiveCalled = true;
      assert.equal(fs.existsSync(`${queuePath}.lock`), true);
      assert.equal(rows.length, 2);
      return { inserted: rows, duplicates: [] };
    },
    windowMs: 60 * 60 * 1000,
    now: () => FIXED_NOW,
  });

  assert.equal(archiveCalled, true);
  assert.equal(result.compaction.archived, 2);
  assert.deepEqual(readObservationQueue(queuePath), []);
});

test("실제 queue에서는 비동기 archive 구현을 거부하고 queue를 보존한다", async (t) => {
  const queuePath = temporaryQueue(t);
  const archivePath = `${queuePath}.promoted`;
  appendObservationQueue(queuePath, [
    candidate("fmkorea", 11, "post-async-archive"),
    candidate("broadcast", 11, "frame-async-archive", "2026-08-02T10:11:00.000Z"),
  ], { now: FIXED_NOW });

  await assert.rejects(promote({
    queuePath,
    archivePath,
    write: true,
    service: { load: async () => payload() },
    writer: { appendSnapshot: async () => ({ ok: true }) },
    archiveFn: async () => ({ inserted: [], duplicates: [] }),
    windowMs: 60 * 60 * 1000,
    now: () => FIXED_NOW,
  }), /archiveFn은 동기 함수/);

  assert.equal(readObservationQueue(queuePath).length, 2);
});

test("audit가 제거 대상 전체를 확인하지 않으면 queue를 보존한다", async (t) => {
  const queuePath = temporaryQueue(t);
  const archivePath = `${queuePath}.promoted`;
  appendObservationQueue(queuePath, [
    candidate("fmkorea", 11, "post-incomplete-archive"),
    candidate("broadcast", 11, "frame-incomplete-archive", "2026-08-02T10:11:00.000Z"),
  ], { now: FIXED_NOW });

  await assert.rejects(promote({
    queuePath,
    archivePath,
    write: true,
    service: { load: async () => payload() },
    writer: { appendSnapshot: async () => ({ ok: true }) },
    archiveFn: () => ({ inserted: [], duplicates: [] }),
    windowMs: 60 * 60 * 1000,
    now: () => FIXED_NOW,
  }), /제거 대상 전체/);

  assert.equal(readObservationQueue(queuePath).length, 2);
});

test("현재 Sheet와 같은 값은 재기록하지 않고 webhook 근거 상한을 지킨다", () => {
  const sameValue = buildPromotionSnapshots(payload(), [
    candidate("broadcast", 10, "same-frame-1"),
    candidate("broadcast", 10, "same-frame-2", "2026-08-02T10:11:00.000Z"),
  ], { windowMs: 60 * 60 * 1000, now: Date.parse("2026-08-02T10:30:00Z") });
  assert.deepEqual(sameValue, []);

  const manyFrames = Array.from({ length: 12 }, (_value, index) => ({
    ...candidate(
      "broadcast",
      12,
      `frame-${index}`,
      `2026-08-02T10:${String(index).padStart(2, "0")}:00.000Z`,
    ),
    sourceUrl: `https://play.sooplive.com/cnsgkcnehd74/${index}`,
  }));
  const snapshots = buildPromotionSnapshots(payload(), manyFrames, {
    windowMs: 60 * 60 * 1000,
    now: Date.parse("2026-08-02T10:30:00Z"),
  });
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].sourceCount, 10);
  assert.equal(snapshots[0].sourceUrls.length, 10);
});

test("snapshot sourceCount는 여러 변경 field 중 최소 독립 근거 수를 사용한다", () => {
  const rows = [
    candidate("broadcast", 11, "strength-frame-1"),
    candidate("broadcast", 11, "strength-frame-2", "2026-08-02T10:11:00.000Z"),
    { ...candidate("broadcast", 4, "vitality-frame-1"), field: "vitality" },
    { ...candidate("broadcast", 4, "vitality-frame-2", "2026-08-02T10:11:00.000Z"), field: "vitality" },
    { ...candidate("broadcast", 4, "vitality-frame-3", "2026-08-02T10:12:00.000Z"), field: "vitality" },
  ];
  const snapshots = buildPromotionSnapshots(payload(), rows, {
    windowMs: 60 * 60 * 1000,
    now: FIXED_NOW,
  });
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].fields.strength, 11);
  assert.equal(snapshots[0].fields.vitality, 4);
  assert.equal(snapshots[0].sourceCount, 2);
});

test("promotion은 현재 시각 기준 window보다 오래된 합의를 쓰지 않는다", () => {
  const snapshots = buildPromotionSnapshots(payload(), [
    candidate("broadcast", 11, "old-frame-1"),
    candidate("broadcast", 11, "old-frame-2", "2026-08-02T10:11:00.000Z"),
  ], {
    windowMs: 60 * 60 * 1000,
    now: Date.parse("2026-08-02T11:11:01.000Z"),
  });
  assert.deepEqual(snapshots, []);
});
