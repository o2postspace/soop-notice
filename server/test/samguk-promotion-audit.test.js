const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  appendPromotionAudit,
  readPromotionAudit,
} = require("../lib/samguk-promotion-audit");
const { CURRENT_SEASON_ID, normalizeObservation } = require("../lib/samguk-observations");

const FIXED_NOW = Date.parse("2026-08-02T10:30:00.000Z");

function temporaryAudit(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "samguk-promotion-audit-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, "promoted.ndjson");
}

function candidate(index, overrides = {}) {
  const second = String(index).padStart(2, "0");
  return {
    seasonId: CURRENT_SEASON_ID,
    playerId: "P001",
    field: "strength",
    value: 10 + index,
    sourceType: "broadcast",
    sourceId: `screen:P001:1785665400000:0123456789abcdef:${index}`,
    sourceUrl: "https://play.sooplive.com/cnsgkcnehd74",
    observedAt: `2026-08-02T10:10:${second}.000Z`,
    collectedAt: `2026-08-02T10:10:${second}.000Z`,
    ocrConfidence: 0.98,
    ...overrides,
  };
}

function serializedBytes(observation) {
  return Buffer.byteLength(`${JSON.stringify(normalizeObservation(observation, { now: FIXED_NOW }))}\n`);
}

test("audit는 기존 파일을 다시 쓰지 않고 append하며 재시도 중복을 제거한다", (t) => {
  const archivePath = temporaryAudit(t);
  const first = candidate(1);
  const second = candidate(2);

  const initial = appendPromotionAudit(archivePath, first, { now: FIXED_NOW });
  const initialStat = fs.statSync(archivePath);
  const retried = appendPromotionAudit(archivePath, [first, second], { now: FIXED_NOW });
  const finalStat = fs.statSync(archivePath);

  assert.equal(initial.inserted.length, 1);
  assert.equal(retried.inserted.length, 1);
  assert.equal(retried.duplicates.length, 1);
  assert.equal(initialStat.ino, finalStat.ino);
  assert.equal(finalStat.mode & 0o777, 0o600);
  assert.deepEqual(readPromotionAudit(archivePath).map(row => row.value), [11, 12]);
  assert.equal(fs.readFileSync(archivePath, "utf8").split("\n").filter(Boolean).length, 2);
});

test("segment 한도에 닿으면 이전 파일을 보존하고 순번 part로 회전한다", (t) => {
  const archivePath = temporaryAudit(t);
  const observations = [candidate(1), candidate(2), candidate(3)];
  const segmentMaxBytes = serializedBytes(observations[0]);

  const result = appendPromotionAudit(archivePath, observations, {
    now: FIXED_NOW,
    segmentMaxBytes,
  });

  const expectedPaths = [
    archivePath,
    `${archivePath}.part-000001`,
    `${archivePath}.part-000002`,
  ];
  assert.deepEqual(result.segmentPaths, expectedPaths);
  for (const filePath of expectedPaths) {
    const stat = fs.statSync(filePath);
    assert.ok(stat.size <= segmentMaxBytes);
    assert.equal(stat.mode & 0o777, 0o600);
  }
  assert.deepEqual(readPromotionAudit(archivePath, { segmentMaxBytes }).map(row => row.value), [11, 12, 13]);

  const baseStat = fs.statSync(archivePath);
  const retried = appendPromotionAudit(archivePath, [observations[1], candidate(4)], {
    now: FIXED_NOW,
    segmentMaxBytes,
  });
  assert.equal(retried.duplicates.length, 1);
  assert.equal(retried.inserted.length, 1);
  assert.equal(fs.statSync(archivePath).ino, baseStat.ino);
  assert.ok(fs.existsSync(`${archivePath}.part-000003`));
  assert.deepEqual(
    readPromotionAudit(archivePath, { segmentMaxBytes }).map(row => row.value),
    [11, 12, 13, 14],
  );
});

test("마지막에 불완전한 행이 남아도 원본 bytes를 보존하고 다음 part에 재시도한다", (t) => {
  const archivePath = temporaryAudit(t);
  const segmentMaxBytes = 4_096;
  appendPromotionAudit(archivePath, candidate(1), { now: FIXED_NOW, segmentMaxBytes });
  fs.appendFileSync(archivePath, "{\"observationId\":\"partial");
  const preserved = fs.readFileSync(archivePath);

  appendPromotionAudit(archivePath, candidate(2), { now: FIXED_NOW, segmentMaxBytes });

  assert.deepEqual(fs.readFileSync(archivePath), preserved);
  assert.ok(fs.existsSync(`${archivePath}.part-000001`));
  assert.deepEqual(
    readPromotionAudit(archivePath, { segmentMaxBytes }).map(row => row.value),
    [11, 12],
  );
});

test("같은 observationId의 다른 내용은 audit conflict로 중단한다", (t) => {
  const archivePath = temporaryAudit(t);
  appendPromotionAudit(archivePath, candidate(1, { observationId: "OBS-CONFLICT" }), {
    now: FIXED_NOW,
  });

  assert.throws(() => appendPromotionAudit(
    archivePath,
    candidate(2, { observationId: "OBS-CONFLICT" }),
    { now: FIXED_NOW },
  ), error => error.code === "observation_id_conflict");
  assert.equal(readPromotionAudit(archivePath).length, 1);
});

test("archive 본체와 회전 segment의 symlink를 거부한다", (t) => {
  const archivePath = temporaryAudit(t);
  const targetPath = path.join(path.dirname(archivePath), "target.ndjson");
  fs.writeFileSync(targetPath, "safe\n", { mode: 0o600 });
  fs.symlinkSync(targetPath, archivePath);

  assert.throws(
    () => appendPromotionAudit(archivePath, candidate(1), { now: FIXED_NOW }),
    error => error.code === "invalid_path",
  );
  assert.equal(fs.readFileSync(targetPath, "utf8"), "safe\n");

  fs.unlinkSync(archivePath);
  const segmentMaxBytes = serializedBytes(candidate(1));
  appendPromotionAudit(archivePath, candidate(1), { now: FIXED_NOW, segmentMaxBytes });
  fs.symlinkSync(targetPath, `${archivePath}.part-000001`);
  assert.throws(
    () => appendPromotionAudit(archivePath, candidate(2), { now: FIXED_NOW, segmentMaxBytes }),
    error => error.code === "invalid_path",
  );
  assert.equal(fs.readFileSync(targetPath, "utf8"), "safe\n");
});

test("상대 경로와 segment보다 큰 행은 기록 전에 거부한다", (t) => {
  const archivePath = temporaryAudit(t);
  assert.throws(
    () => appendPromotionAudit("relative.ndjson", candidate(1), { now: FIXED_NOW }),
    error => error.code === "invalid_path",
  );
  assert.throws(
    () => appendPromotionAudit(archivePath, candidate(1), { now: FIXED_NOW, segmentMaxBytes: 1 }),
    error => error.code === "audit_line_too_large",
  );
  assert.equal(fs.existsSync(archivePath), false);
});

test("queue의 단일 append 한도였던 1,000건을 넘어도 전체 compact 근거를 보존한다", (t) => {
  const archivePath = temporaryAudit(t);
  const observations = Array.from({ length: 1_001 }, (_value, index) => candidate(1, {
    sourceId: `bulk-source-${String(index).padStart(4, "0")}`,
  }));

  const result = appendPromotionAudit(archivePath, observations, { now: FIXED_NOW });

  assert.equal(result.inserted.length, 1_001);
  assert.equal(result.duplicates.length, 0);
  assert.equal(readPromotionAudit(archivePath).length, 1_001);
});
