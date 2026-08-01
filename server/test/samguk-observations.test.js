const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const {
  SamgukObservationError,
  acceptSheetBaseline,
  appendObservationQueue,
  findAcceptedConsensus,
  normalizeObservation,
  observationFingerprint,
  readObservationQueue,
  resolveLatestAccepted,
} = require("../lib/samguk-observations");

const FIXED_NOW = Date.parse("2026-08-02T12:00:00.000Z");

function observation(overrides = {}) {
  const sourceType = overrides.sourceType || "sheet";
  const urls = {
    sheet: "https://docs.google.com/spreadsheets/d/test/edit",
    fmkorea: "https://www.fmkorea.com/123456",
    broadcast: "https://play.sooplive.co.kr/testbj/1234",
  };
  return {
    playerId: "P001",
    field: "strength",
    value: 10,
    sourceType,
    sourceId: `${sourceType}-1`,
    sourceUrl: urls[sourceType],
    observedAt: "2026-08-02T10:00:00.000Z",
    collectedAt: "2026-08-02T10:01:00.000Z",
    ocrConfidence: null,
    ...overrides,
  };
}

function temporaryQueue(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "samguk-observations-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, "queue.ndjson");
}

test("관측 스키마를 정규화하고 같은 근거는 결정적인 ID와 hash를 만든다", () => {
  const first = normalizeObservation(observation({ value: "1,234" }), { now: FIXED_NOW });
  const second = normalizeObservation(observation({
    value: 1234,
    collectedAt: "2026-08-02T11:59:00.000Z",
  }), { now: FIXED_NOW });

  assert.deepEqual(Object.keys(first), [
    "observationId", "playerId", "field", "value", "sourceType", "sourceId", "sourceUrl",
    "observedAt", "collectedAt", "evidenceHash", "ocrConfidence",
  ]);
  assert.equal(first.value, 1234);
  assert.match(first.observationId, /^OBS-[A-F0-9]{24}$/);
  assert.match(first.evidenceHash, /^[a-f0-9]{64}$/);
  assert.equal(first.observationId, second.observationId);
  assert.equal(observationFingerprint(first), observationFingerprint(second));
  assert.equal(first.sourceUrl, "https://docs.google.com/spreadsheets/d/test/edit");
});

test("허용 필드, 값, URL host와 임의 상태 필드를 엄격히 검증한다", () => {
  assert.throws(
    () => normalizeObservation(observation({ field: "territory" })),
    error => error instanceof SamgukObservationError && error.code === "invalid_field",
  );
  assert.throws(
    () => normalizeObservation(observation({ sourceUrl: "https://evil.example/sheet" })),
    error => error.code === "invalid_url",
  );
  assert.throws(
    () => normalizeObservation(observation({ value: -1 })),
    error => error.code === "invalid_value",
  );
  assert.throws(
    () => normalizeObservation({ ...observation(), status: "검수대기" }),
    error => error.code === "invalid_schema",
  );

  const broadcast = normalizeObservation(observation({
    sourceType: "broadcast",
    sourceId: "frame-1",
    sourceUrl: "https://vod.sooplive.co.kr/player/1",
    ocrConfidence: "0.97",
  }));
  assert.equal(broadcast.ocrConfidence, 0.97);
});

test("서로 다른 두 출처가 window 안에서 같은 값을 관측해야 교차검증된다", () => {
  const sheet = observation();
  const fmkorea = observation({
    sourceType: "fmkorea",
    sourceId: "post-123",
    sourceUrl: "https://m.fmkorea.com/123",
    observedAt: "2026-08-02T10:30:00.000Z",
  });
  const accepted = findAcceptedConsensus([sheet, fmkorea], { windowMs: 60 * 60 * 1000 });

  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].verification, "cross-source");
  assert.deepEqual(accepted[0].sourceTypes, ["fmkorea", "sheet"]);
  assert.equal(accepted[0].value, 10);

  assert.deepEqual(findAcceptedConsensus([
    sheet,
    { ...fmkorea, value: 11 },
  ]), []);
  assert.deepEqual(findAcceptedConsensus([
    sheet,
    { ...fmkorea, observedAt: "2026-08-03T12:00:00.000Z" },
  ], { windowMs: 60 * 60 * 1000 }), []);
});

test("고신뢰 방송은 서로 다른 frame 두 개가 같은 값을 잡을 때만 교차검증된다", () => {
  const frame1 = observation({
    sourceType: "broadcast",
    sourceId: "vod-1@00:10:01#frame-1",
    sourceUrl: "https://play.sooplive.co.kr/testbj/1",
    ocrConfidence: 0.96,
  });
  const frame2 = observation({
    sourceType: "broadcast",
    sourceId: "vod-1@00:10:03#frame-2",
    sourceUrl: "https://play.sooplive.co.kr/testbj/1",
    observedAt: "2026-08-02T10:00:02.000Z",
    ocrConfidence: 0.99,
  });
  const accepted = findAcceptedConsensus([frame1, frame2]);
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].verification, "broadcast-repeat");

  assert.deepEqual(findAcceptedConsensus([frame1, { ...frame2, sourceId: frame1.sourceId }]), []);
  assert.deepEqual(findAcceptedConsensus([frame1, { ...frame2, ocrConfidence: 0.94 }]), []);
  assert.deepEqual(findAcceptedConsensus([frame1, { ...frame2, value: 11 }]), []);
});

test("sheet baseline은 즉시 채택하지만 새 값은 교차검증된 경우에만 덮어쓴다", () => {
  const baseline = observation({
    sourceId: "sheet-baseline-row-1",
    observedAt: "2026-08-02T08:00:00.000Z",
  });
  assert.equal(acceptSheetBaseline(baseline).verification, "sheet-baseline");
  assert.throws(
    () => acceptSheetBaseline(observation({ sourceType: "fmkorea", sourceUrl: "https://www.fmkorea.com/1" })),
    error => error.code === "invalid_baseline",
  );

  const unverifiedNew = observation({
    sourceType: "fmkorea",
    sourceId: "post-new",
    sourceUrl: "https://www.fmkorea.com/2",
    observedAt: "2026-08-02T10:00:00.000Z",
    value: 11,
  });
  let latest = resolveLatestAccepted([unverifiedNew], { baselines: [baseline] });
  assert.equal(latest.length, 1);
  assert.equal(latest[0].value, 10);
  assert.equal(latest[0].verification, "sheet-baseline");

  const broadcastNew = observation({
    sourceType: "broadcast",
    sourceId: "frame-new",
    sourceUrl: "https://play.sooplive.co.kr/testbj/2",
    observedAt: "2026-08-02T10:05:00.000Z",
    value: 11,
    ocrConfidence: 0.98,
  });
  latest = resolveLatestAccepted([unverifiedNew, broadcastNew], { baselines: [baseline] });
  assert.equal(latest[0].value, 11);
  assert.equal(latest[0].verification, "cross-source");
});

test("같은 최신 시각의 검증 결과가 충돌하면 그 값들은 버리고 직전 accepted를 유지한다", () => {
  const baseline = observation({ observedAt: "2026-08-02T08:00:00.000Z" });
  const conflicting = [
    observation({
      sourceType: "sheet",
      sourceId: "sheet-11",
      observedAt: "2026-08-02T10:00:00.000Z",
      value: 11,
    }),
    observation({
      sourceType: "fmkorea",
      sourceId: "fmk-11",
      sourceUrl: "https://www.fmkorea.com/11",
      observedAt: "2026-08-02T10:00:00.000Z",
      value: 11,
    }),
    observation({
      sourceType: "sheet",
      sourceId: "sheet-12",
      observedAt: "2026-08-02T10:00:00.000Z",
      value: 12,
    }),
    observation({
      sourceType: "broadcast",
      sourceId: "frame-12",
      sourceUrl: "https://play.sooplive.co.kr/testbj/12",
      observedAt: "2026-08-02T10:00:00.000Z",
      value: 12,
      ocrConfidence: 0.99,
    }),
  ];
  const latest = resolveLatestAccepted(conflicting, { baselines: [baseline] });
  assert.equal(latest.length, 1);
  assert.equal(latest[0].value, 10);
  assert.equal(latest[0].verification, "sheet-baseline");
});

test("동일 관측은 NDJSON queue에 한 번만 append하고 ID 충돌과 손상 파일을 거부한다", (t) => {
  const queue = temporaryQueue(t);
  const first = appendObservationQueue(queue, observation(), { now: FIXED_NOW });
  const second = appendObservationQueue(queue, observation({
    collectedAt: "2026-08-02T11:00:00.000Z",
  }), { now: FIXED_NOW });

  assert.equal(first.inserted.length, 1);
  assert.equal(second.inserted.length, 0);
  assert.equal(second.duplicates.length, 1);
  assert.equal(readObservationQueue(queue).length, 1);
  assert.equal(fs.readFileSync(queue, "utf8").trim().split("\n").length, 1);

  assert.throws(
    () => appendObservationQueue(queue, observation({
      observationId: first.inserted[0].observationId,
      sourceId: "different-source-row",
    })),
    error => error.code === "observation_id_conflict",
  );

  const corrupt = temporaryQueue(t);
  fs.writeFileSync(corrupt, "not-json\n", { mode: 0o600 });
  assert.throws(() => readObservationQueue(corrupt), error => error.code === "queue_corrupt");
});

test("CLI는 stdin 입력을 append하고 교차검증 결과를 JSON으로 출력한다", (t) => {
  const queue = temporaryQueue(t);
  const script = path.resolve(__dirname, "../scripts/samguk-submit-observation.js");
  const first = spawnSync(process.execPath, [script, "--queue", queue, "--baseline-sheet"], {
    input: JSON.stringify(observation()),
    encoding: "utf8",
  });
  assert.equal(first.status, 0, first.stderr);
  const firstResult = JSON.parse(first.stdout);
  assert.equal(firstResult.inserted, 1);
  assert.equal(firstResult.accepted[0].verification, "sheet-baseline");

  const second = spawnSync(process.execPath, [script, "--queue", queue], {
    input: JSON.stringify(observation({
      sourceType: "fmkorea",
      sourceId: "post-cli",
      sourceUrl: "https://www.fmkorea.com/777",
      observedAt: "2026-08-02T10:10:00.000Z",
    })),
    encoding: "utf8",
  });
  assert.equal(second.status, 0, second.stderr);
  const secondResult = JSON.parse(second.stdout);
  assert.equal(secondResult.inserted, 1);
  assert.equal(secondResult.accepted[0].verification, "cross-source");
  assert.equal(readObservationQueue(queue).length, 2);
});
