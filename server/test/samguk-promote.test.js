const test = require("node:test");
const assert = require("node:assert/strict");
const {
  baselineObservations,
  buildPromotionSnapshots,
  promote,
} = require("../scripts/samguk-promote-observations");

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
  assert.equal(Object.keys(snapshots[0].fields).length, 12);
  assert.equal(snapshots[0].sourceCount, 2);
  assert.equal(snapshots[0].verification, "cross-source");
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
  });
  assert.equal(result.written, 1);
  assert.equal(written.length, 1);
  assert.equal(written[0].fields.strength, 11);
});
