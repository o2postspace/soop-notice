const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const {
  createSamgukSheetWriter,
  makeSignedRequest,
  validateWebhookUrl,
} = require("../lib/samguk-sheet-writer");

const SECRET = "s".repeat(32);

test("Apps Script payload는 원문 HMAC으로 서명한다", () => {
  const body = JSON.parse(makeSignedRequest({ playerId: "P001" }, {
    secret: SECRET,
    now: Date.parse("2026-08-02T00:00:00Z"),
  }));
  assert.deepEqual(JSON.parse(body.payload), {
    version: 1,
    issuedAt: "2026-08-02T00:00:00.000Z",
    snapshot: { playerId: "P001" },
  });
  assert.equal(
    body.signature,
    crypto.createHmac("sha256", SECRET).update(body.payload).digest("hex"),
  );
});

test("Google Apps Script 외 webhook URL은 거부한다", () => {
  assert.match(validateWebhookUrl("https://script.google.com/macros/s/test/exec"), /^https:/);
  assert.throws(() => validateWebhookUrl("https://example.com/hook"), /허용된/);
  assert.throws(() => validateWebhookUrl("http://script.google.com/hook"), /허용된/);
});

test("writer는 성공 응답을 반환하고 실패·timeout을 구분한다", async () => {
  let request;
  const writer = createSamgukSheetWriter({
    webhookUrl: "https://script.google.com/macros/s/test/exec",
    secret: SECRET,
    now: () => Date.parse("2026-08-02T00:00:00Z"),
    fetchImpl: async (url, init) => {
      request = { url, init };
      return new Response(JSON.stringify({ ok: true, appendedRow: 3 }), { status: 200 });
    },
  });
  assert.deepEqual(await writer.appendSnapshot({ playerId: "P001" }), {
    ok: true,
    appendedRow: 3,
  });
  assert.equal(request.init.method, "POST");
  assert.equal(JSON.parse(JSON.parse(request.init.body).payload).snapshot.playerId, "P001");

  const failing = createSamgukSheetWriter({
    webhookUrl: "https://script.google.com/macros/s/test/exec",
    secret: SECRET,
    fetchImpl: async () => new Response(JSON.stringify({ ok: false, error: "bad" }), { status: 200 }),
  });
  await assert.rejects(failing.appendSnapshot({ playerId: "P001" }), /저장 실패: bad/);
});
