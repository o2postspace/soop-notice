"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  EXPECTED_HEADERS,
  GOOGLE_SHEETS_SCOPE,
  createSamgukGoogleSheetWriter,
  normalizeSnapshot,
  readPrivateTokenFile,
  sheetSerial,
  snapshotRow,
} = require("../lib/samguk-google-sheet-writer");
const { NUMERIC_FIELD_MAXIMUMS } = require("../lib/samguk-observations");

const NOW = Date.parse("2026-08-02T07:00:00.000Z");

function temporaryToken(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "samguk-google-writer-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const tokenPath = path.join(directory, "token.json");
  fs.writeFileSync(tokenPath, JSON.stringify({
    version: 1,
    client_id: "test.apps.googleusercontent.com",
    client_secret: "client-secret-value",
    refresh_token: "refresh-token-value-long-enough",
    scope: GOOGLE_SHEETS_SCOPE,
    token_uri: "https://oauth2.googleapis.com/token",
  }), { mode: 0o600 });
  return { directory, tokenPath };
}

function snapshot(overrides = {}) {
  return {
    observationId: "OBS-CROSS-1234567890ABCDEF",
    playerId: "P001",
    fields: {
      level: 10,
      horse: "백룡마",
      horseLevel: 1,
      weapon: 2,
      helmet: 3,
      armor: 4,
      shoes: 5,
      strength: 11,
      agility: 12,
      vitality: 13,
      intelligence: 14,
      powerScore: null,
    },
    observedAt: "2026-08-02T06:00:00.000Z",
    verification: "broadcast-repeat",
    primarySourceType: "broadcast",
    sourceTypes: ["broadcast"],
    sourceCount: 2,
    sourceUrls: ["https://play.sooplive.com/testbj/1"],
    evidenceHash: "a".repeat(64),
    batchId: "PROMOTE-20260802-ABCDEF12",
    ocrConfidence: 0.95,
    note: "자동 승격",
    ...overrides,
  };
}

function response(body, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

function plainResponse(body, status) {
  return new Response(body, { status, headers: { "Content-Type": "text/plain" } });
}

function assertInvalidSnapshot(input) {
  assert.throws(
    () => normalizeSnapshot(input, NOW),
    error => error?.code === "invalid_snapshot",
  );
}

test("OAuth token은 전용 scope와 0600 일반 파일만 허용한다", (t) => {
  const { directory, tokenPath } = temporaryToken(t);
  assert.equal(readPrivateTokenFile(tokenPath).scope, GOOGLE_SHEETS_SCOPE);
  fs.chmodSync(tokenPath, 0o640);
  assert.throws(() => readPrivateTokenFile(tokenPath), /0600/);
  fs.chmodSync(tokenPath, 0o600);
  fs.chmodSync(directory, 0o750);
  assert.throws(() => readPrivateTokenFile(tokenPath), /0700/);
  fs.chmodSync(directory, 0o700);

  const originalReadSync = fs.readSync;
  let changed = false;
  try {
    fs.readSync = (...args) => {
      const count = originalReadSync(...args);
      if (!changed) {
        changed = true;
        fs.chmodSync(tokenPath, 0o400);
      }
      return count;
    };
    assert.throws(() => readPrivateTokenFile(tokenPath), /읽는 중 변경/);
  } finally {
    fs.readSync = originalReadSync;
    fs.chmodSync(tokenPath, 0o600);
  }
});

test("KST Sheet serial은 절대시각을 Asia\/Seoul wall time으로 변환한다", () => {
  const serial = sheetSerial("2026-08-02T06:00:00.000Z", "관측");
  const utcMidnight = Date.parse("2026-08-02T00:00:00.000Z") / 86_400_000 + 25_569;
  assert.equal(serial, utcMidnight + 15 / 24);
});

test("snapshot 숫자는 Sheet 필드별 상한과 정수 조건을 지킨다", () => {
  const maximumFields = {
    ...snapshot().fields,
    ...NUMERIC_FIELD_MAXIMUMS,
    powerScore: 999_999.5,
  };
  assert.deepEqual(normalizeSnapshot(snapshot({ fields: maximumFields }), NOW).fields, maximumFields);

  for (const [field, maximum] of Object.entries(NUMERIC_FIELD_MAXIMUMS)) {
    assertInvalidSnapshot(snapshot({
      fields: { ...snapshot().fields, [field]: maximum + 1 },
    }));
    if (field !== "powerScore") {
      assertInvalidSnapshot(snapshot({
        fields: { ...snapshot().fields, [field]: 1.5 },
      }));
    }
  }
});

test("snapshot은 출처 중복·검증 의미 불일치와 2000년 이전 관측을 거부한다", () => {
  assertInvalidSnapshot(snapshot({ sourceTypes: ["broadcast", "broadcast"] }));
  assertInvalidSnapshot(snapshot({ primarySourceType: "sheet" }));
  assertInvalidSnapshot(snapshot({
    verification: "cross-source",
    sourceTypes: ["broadcast"],
  }));
  assertInvalidSnapshot(snapshot({
    verification: "cross-source",
    primarySourceType: "broadcast",
    sourceTypes: ["broadcast", "fmkorea"],
    sourceCount: 3,
  }));
  assertInvalidSnapshot(snapshot({
    sourceTypes: ["broadcast", "fmkorea"],
  }));
  assertInvalidSnapshot(snapshot({ observedAt: "1999-12-31T23:59:59.999Z" }));

  const crossSource = normalizeSnapshot(snapshot({
    verification: "cross-source",
    primarySourceType: "broadcast",
    sourceTypes: ["broadcast", "fmkorea"],
    sourceCount: 2,
  }), NOW);
  assert.deepEqual(crossSource.sourceTypes, ["broadcast", "fmkorea"]);
});

test("OAuth writer는 첫 A:Y 완전 빈행만 정확히 쓰고 전체 행을 재검증한다", async (t) => {
  const { directory, tokenPath } = temporaryToken(t);
  const indexRows = Array.from({ length: 90 }, (_value, index) => [
    `OBS-SEED-${String(index + 1).padStart(4, "0")}`,
    `P${String(index + 1).padStart(3, "0")}`,
  ]);
  let writtenRow = null;
  let released = 0;
  const requests = [];
  const writer = createSamgukGoogleSheetWriter({
    tokenPath,
    sheetId: "1xC3leW9fFl4ytHI6i2UkQ8iViBFIwjLrug66lYmVckY",
    lockPath: path.join(directory, "writer.guard"),
    now: () => NOW,
    acquireLock: () => ({ release() { released += 1; } }),
    fetchImpl: async (url, init = {}) => {
      requests.push({ url, method: init.method || "GET" });
      if (url === "https://oauth2.googleapis.com/token") {
        return response({ access_token: "access-token", expires_in: 3600 });
      }
      if (url.includes("fields=properties%28timeZone%29")) {
        return response({ properties: { timeZone: "Asia/Seoul" } });
      }
      if (url.includes("/values:batchGet")) {
        return response({ valueRanges: [
          { values: [EXPECTED_HEADERS] },
          { values: indexRows },
          { values: [["P001"], ["P002"]] },
        ] });
      }
      if (init.method === "PUT") {
        writtenRow = JSON.parse(init.body).values[0];
        return response({ updatedRows: 1, updatedRange: "관측입력!A92:Y92" });
      }
      if (url.includes("A92%3AY92")) return response({ values: [writtenRow] });
      throw new Error(`unexpected request: ${url}`);
    },
  });

  assert.deepEqual(await writer.appendSnapshot(snapshot()), {
    ok: true,
    duplicate: false,
    appendedRow: 92,
  });
  assert.equal(released, 1);
  assert.equal(writtenRow.length, 25);
  assert.equal(writtenRow[0], "OBS-CROSS-1234567890ABCDEF");
  assert.equal(writtenRow[1], "P001");
  assert.equal(writtenRow[22], 95);
  assert.equal(writtenRow[24], sheetSerial(NOW, "입력"));
  assert.equal(requests.filter(item => item.method === "PUT").length, 1);
});

test("기존 observationId는 내용이 같을 때만 duplicate로 처리한다", async (t) => {
  const { directory, tokenPath } = temporaryToken(t);
  let expectedRow;
  const writer = createSamgukGoogleSheetWriter({
    tokenPath,
    sheetId: "1xC3leW9fFl4ytHI6i2UkQ8iViBFIwjLrug66lYmVckY",
    lockPath: path.join(directory, "writer.guard"),
    now: () => NOW,
    acquireLock: () => ({ release() {} }),
    fetchImpl: async (url, init = {}) => {
      if (url === "https://oauth2.googleapis.com/token") return response({ access_token: "token", expires_in: 3600 });
      if (url.includes("fields=properties%28timeZone%29")) return response({ properties: { timeZone: "Asia/Seoul" } });
      if (url.includes("/values:batchGet")) return response({ valueRanges: [
        { values: [EXPECTED_HEADERS] },
        { values: [["OBS-CROSS-1234567890ABCDEF", "P001"]] },
        { values: [["P001"]] },
      ] });
      if (url.includes("A2%3AY2")) return response({ values: [expectedRow] });
      assert.notEqual(init.method, "PUT");
      throw new Error(`unexpected request: ${url}`);
    },
  });
  const normalized = normalizeSnapshot(snapshot(), NOW);
  expectedRow = snapshotRow(normalized);
  expectedRow[24] -= 1;

  assert.deepEqual(await writer.appendSnapshot(snapshot()), {
    ok: true,
    duplicate: true,
    appendedRow: 2,
  });
});

test("첫 완전 빈 A:Y 행만 고르고 쓰기 직전 부분 점유를 다시 확인한다", async (t) => {
  const { directory, tokenPath } = temporaryToken(t);
  const partialRow = Array(EXPECTED_HEADERS.length).fill("");
  partialRow[23] = "수동 메모";
  let writtenRow = null;
  let putCalls = 0;
  const requestedUrls = [];
  const writer = createSamgukGoogleSheetWriter({
    tokenPath,
    sheetId: "1xC3leW9fFl4ytHI6i2UkQ8iViBFIwjLrug66lYmVckY",
    lockPath: path.join(directory, "writer.guard"),
    now: () => NOW,
    acquireLock: () => ({ release() {} }),
    fetchImpl: async (url, init = {}) => {
      requestedUrls.push(url);
      if (url === "https://oauth2.googleapis.com/token") {
        return response({ access_token: "access-token", expires_in: 3600 });
      }
      if (url.includes("fields=properties%28timeZone%29")) {
        return response({ properties: { timeZone: "Asia/Seoul" } });
      }
      if (url.includes("/values:batchGet")) return response({ valueRanges: [
        { values: [EXPECTED_HEADERS] },
        { values: [partialRow, []] },
        { values: [["P001"]] },
      ] });
      if (url.includes("A3%3AY3") && init.method !== "PUT") {
        return response({ values: [writtenRow] });
      }
      if (init.method === "PUT") {
        putCalls += 1;
        writtenRow = JSON.parse(init.body).values[0];
        return response({ updatedRows: 1, updatedRange: "관측입력!A3:Y3" });
      }
      throw new Error(`unexpected request: ${url}`);
    },
  });

  assert.deepEqual(await writer.appendSnapshot(snapshot()), {
    ok: true,
    duplicate: false,
    appendedRow: 3,
  });
  assert.equal(putCalls, 1);
  assert.ok(requestedUrls.some(url => url.includes("A2%3AY5001")));
  assert.ok(requestedUrls.some(url => url.includes("valueRenderOption=FORMULA")));

  let racePutCalls = 0;
  let released = 0;
  const racingWriter = createSamgukGoogleSheetWriter({
    tokenPath,
    sheetId: "1xC3leW9fFl4ytHI6i2UkQ8iViBFIwjLrug66lYmVckY",
    lockPath: path.join(directory, "race-writer.guard"),
    now: () => NOW,
    acquireLock: () => ({ release() { released += 1; } }),
    fetchImpl: async (url, init = {}) => {
      if (url === "https://oauth2.googleapis.com/token") {
        return response({ access_token: "access-token", expires_in: 3600 });
      }
      if (url.includes("fields=properties%28timeZone%29")) {
        return response({ properties: { timeZone: "Asia/Seoul" } });
      }
      if (url.includes("/values:batchGet")) return response({ valueRanges: [
        { values: [EXPECTED_HEADERS] },
        { values: [[]] },
        { values: [["P001"]] },
      ] });
      if (url.includes("A2%3AY2") && init.method !== "PUT") {
        return response({ values: [partialRow] });
      }
      if (init.method === "PUT") racePutCalls += 1;
      throw new Error(`unexpected request: ${url}`);
    },
  });

  await assert.rejects(
    racingWriter.appendSnapshot(snapshot()),
    error => error?.code === "target_row_conflict",
  );
  assert.equal(racePutCalls, 0);
  assert.equal(released, 1);
});

test("비JSON 429·5xx는 최대 3회 안에서 재시도하고 성공 응답만 사용한다", async (t) => {
  const { directory, tokenPath } = temporaryToken(t);
  const expectedRow = snapshotRow(normalizeSnapshot(snapshot(), NOW));
  expectedRow[24] -= 1;
  let metadataCalls = 0;
  const writer = createSamgukGoogleSheetWriter({
    tokenPath,
    sheetId: "1xC3leW9fFl4ytHI6i2UkQ8iViBFIwjLrug66lYmVckY",
    lockPath: path.join(directory, "writer.guard"),
    now: () => NOW,
    acquireLock: () => ({ release() {} }),
    fetchImpl: async (url) => {
      if (url === "https://oauth2.googleapis.com/token") {
        return response({ access_token: "access-token", expires_in: 3600 });
      }
      if (url.includes("fields=properties%28timeZone%29")) {
        metadataCalls += 1;
        if (metadataCalls === 1) return plainResponse("rate limited", 429);
        if (metadataCalls === 2) return plainResponse("unavailable", 503);
        return response({ properties: { timeZone: "Asia/Seoul" } });
      }
      if (url.includes("/values:batchGet")) return response({ valueRanges: [
        { values: [EXPECTED_HEADERS] },
        { values: [[snapshot().observationId, "P001"]] },
        { values: [["P001"]] },
      ] });
      if (url.includes("A2%3AY2")) return response({ values: [expectedRow] });
      throw new Error(`unexpected request: ${url}`);
    },
  });

  assert.equal((await writer.appendSnapshot(snapshot())).duplicate, true);
  assert.equal(metadataCalls, 3);
});

test("AbortError는 3회까지만 재시도한 뒤 timeout으로 닫힌다", async (t) => {
  const { directory, tokenPath } = temporaryToken(t);
  let metadataCalls = 0;
  let released = 0;
  const writer = createSamgukGoogleSheetWriter({
    tokenPath,
    sheetId: "1xC3leW9fFl4ytHI6i2UkQ8iViBFIwjLrug66lYmVckY",
    lockPath: path.join(directory, "writer.guard"),
    now: () => NOW,
    acquireLock: () => ({ release() { released += 1; } }),
    fetchImpl: async (url) => {
      if (url === "https://oauth2.googleapis.com/token") {
        return response({ access_token: "access-token", expires_in: 3600 });
      }
      metadataCalls += 1;
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    },
  });

  await assert.rejects(
    writer.appendSnapshot(snapshot()),
    error => error?.code === "upstream_timeout",
  );
  assert.equal(metadataCalls, 3);
  assert.equal(released, 1);
});

test("401은 access token을 한 번만 새로 받고 요청을 다시 인증한다", async (t) => {
  const { directory, tokenPath } = temporaryToken(t);
  const expectedRow = snapshotRow(normalizeSnapshot(snapshot(), NOW));
  expectedRow[24] -= 1;
  const authorizations = [];
  let tokenCalls = 0;
  let metadataCalls = 0;
  const writer = createSamgukGoogleSheetWriter({
    tokenPath,
    sheetId: "1xC3leW9fFl4ytHI6i2UkQ8iViBFIwjLrug66lYmVckY",
    lockPath: path.join(directory, "writer.guard"),
    now: () => NOW,
    acquireLock: () => ({ release() {} }),
    fetchImpl: async (url, init = {}) => {
      if (url === "https://oauth2.googleapis.com/token") {
        tokenCalls += 1;
        return response({ access_token: `token-${tokenCalls}`, expires_in: 3600 });
      }
      if (url.includes("fields=properties%28timeZone%29")) {
        metadataCalls += 1;
        authorizations.push(init.headers.Authorization);
        if (metadataCalls === 1) return response({ error: "expired" }, 401);
        return response({ properties: { timeZone: "Asia/Seoul" } });
      }
      if (url.includes("/values:batchGet")) return response({ valueRanges: [
        { values: [EXPECTED_HEADERS] },
        { values: [[snapshot().observationId, "P001"]] },
        { values: [["P001"]] },
      ] });
      if (url.includes("A2%3AY2")) return response({ values: [expectedRow] });
      throw new Error(`unexpected request: ${url}`);
    },
  });

  assert.equal((await writer.appendSnapshot(snapshot())).duplicate, true);
  assert.equal(tokenCalls, 2);
  assert.equal(metadataCalls, 2);
  assert.deepEqual(authorizations, ["Bearer token-1", "Bearer token-2"]);
});

test("비재시도 상태의 비JSON과 response cap 초과는 즉시 실패한다", async (t) => {
  const { directory, tokenPath } = temporaryToken(t);
  let invalidCalls = 0;
  const invalidWriter = createSamgukGoogleSheetWriter({
    tokenPath,
    sheetId: "1xC3leW9fFl4ytHI6i2UkQ8iViBFIwjLrug66lYmVckY",
    lockPath: path.join(directory, "invalid.guard"),
    now: () => NOW,
    acquireLock: () => ({ release() {} }),
    fetchImpl: async (url) => {
      if (url === "https://oauth2.googleapis.com/token") {
        return response({ access_token: "access-token", expires_in: 3600 });
      }
      invalidCalls += 1;
      return plainResponse("bad request", 400);
    },
  });
  await assert.rejects(
    invalidWriter.appendSnapshot(snapshot()),
    error => error?.code === "invalid_response",
  );
  assert.equal(invalidCalls, 1);

  let oversizedCalls = 0;
  const cappedWriter = createSamgukGoogleSheetWriter({
    tokenPath,
    sheetId: "1xC3leW9fFl4ytHI6i2UkQ8iViBFIwjLrug66lYmVckY",
    lockPath: path.join(directory, "capped.guard"),
    now: () => NOW,
    maxResponseBytes: 32,
    acquireLock: () => ({ release() {} }),
    fetchImpl: async (url) => {
      if (url === "https://oauth2.googleapis.com/token") return response({ access_token: "x" });
      oversizedCalls += 1;
      return response({ payload: "x".repeat(64) });
    },
  });
  await assert.rejects(
    cappedWriter.appendSnapshot(snapshot()),
    error => error?.code === "response_too_large",
  );
  assert.equal(oversizedCalls, 1);
});
