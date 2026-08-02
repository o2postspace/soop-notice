const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  createSamgukSheetWriter,
  makeSignedRequest,
  validateWebhookUrl,
} = require("../lib/samguk-sheet-writer");

const SECRET = "s".repeat(32);

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "samguk-webhook-config-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function setEnvironment(t, values) {
  const previous = new Map(Object.keys(values).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

function writePrivateFile(filePath, value, mode = 0o600) {
  fs.writeFileSync(filePath, value, { mode });
  fs.chmodSync(filePath, mode);
}

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
  assert.throws(() => createSamgukSheetWriter({ mode: "unknown" }), /webhook 또는 oauth/);
});

test("webhook URL과 secret은 0400·0600 전용 파일에서 trim해 읽는다", async (t) => {
  const directory = temporaryDirectory(t);
  const urlPath = path.join(directory, "url");
  const secretPath = path.join(directory, "secret");
  const webhookUrl = "https://script.google.com/macros/s/file-config/exec";
  writePrivateFile(urlPath, `${webhookUrl}\n`, 0o400);
  writePrivateFile(secretPath, `${SECRET}\n`, 0o600);
  setEnvironment(t, {
    SAMGUK_SHEET_WRITE_MODE: "webhook",
    SAMGUK_SHEET_WEBHOOK_URL: undefined,
    SAMGUK_SHEET_WEBHOOK_SECRET: undefined,
    SAMGUK_SHEET_WEBHOOK_URL_PATH: urlPath,
    SAMGUK_SHEET_WEBHOOK_SECRET_PATH: secretPath,
  });
  let request;
  const writer = createSamgukSheetWriter({
    fetchImpl: async (url, init) => {
      request = { url, init };
      return new Response(JSON.stringify({ ok: true, appendedRow: 2 }), { status: 200 });
    },
  });

  assert.equal((await writer.appendSnapshot({ playerId: "P001" })).ok, true);
  assert.equal(request.url, webhookUrl);
  const signed = JSON.parse(request.init.body);
  assert.equal(signed.signature, crypto.createHmac("sha256", SECRET).update(signed.payload).digest("hex"));
});

test("webhook 설정 파일의 그룹·기타 권한을 거부한다", (t) => {
  const directory = temporaryDirectory(t);
  const urlPath = path.join(directory, "url");
  const secretPath = path.join(directory, "secret");
  writePrivateFile(urlPath, "https://script.google.com/macros/s/test/exec\n", 0o640);
  writePrivateFile(secretPath, `${SECRET}\n`);
  setEnvironment(t, {
    SAMGUK_SHEET_WRITE_MODE: "webhook",
    SAMGUK_SHEET_WEBHOOK_URL: undefined,
    SAMGUK_SHEET_WEBHOOK_SECRET: undefined,
    SAMGUK_SHEET_WEBHOOK_URL_PATH: urlPath,
    SAMGUK_SHEET_WEBHOOK_SECRET_PATH: secretPath,
  });

  assert.throws(() => createSamgukSheetWriter(), /0400 또는 0600/);
});

test("webhook 설정 파일 symlink는 따라가지 않는다", (t) => {
  const directory = temporaryDirectory(t);
  const targetPath = path.join(directory, "url-target");
  const urlPath = path.join(directory, "url-link");
  const secretPath = path.join(directory, "secret");
  writePrivateFile(targetPath, "https://script.google.com/macros/s/test/exec\n");
  writePrivateFile(secretPath, `${SECRET}\n`);
  fs.symlinkSync(targetPath, urlPath);
  setEnvironment(t, {
    SAMGUK_SHEET_WRITE_MODE: "webhook",
    SAMGUK_SHEET_WEBHOOK_URL: undefined,
    SAMGUK_SHEET_WEBHOOK_SECRET: undefined,
    SAMGUK_SHEET_WEBHOOK_URL_PATH: urlPath,
    SAMGUK_SHEET_WEBHOOK_SECRET_PATH: secretPath,
  });

  assert.throws(() => createSamgukSheetWriter(), /일반 파일/);
});

test("options와 평문 env는 *_PATH보다 우선한다", async (t) => {
  setEnvironment(t, {
    SAMGUK_SHEET_WRITE_MODE: "webhook",
    SAMGUK_SHEET_WEBHOOK_URL: "https://script.google.com/macros/s/env/exec\n",
    SAMGUK_SHEET_WEBHOOK_SECRET: `${"e".repeat(32)}\n`,
    SAMGUK_SHEET_WEBHOOK_URL_PATH: "/missing/url",
    SAMGUK_SHEET_WEBHOOK_SECRET_PATH: "/missing/secret",
  });
  const requestedUrls = [];
  const envWriter = createSamgukSheetWriter({
    fetchImpl: async (url) => {
      requestedUrls.push(url);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    },
  });
  await envWriter.appendSnapshot({ playerId: "P001" });

  const optionWriter = createSamgukSheetWriter({
    webhookUrl: "https://script.google.com/macros/s/option/exec\n",
    secret: `${SECRET}\n`,
    fetchImpl: async (url) => {
      requestedUrls.push(url);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    },
  });
  await optionWriter.appendSnapshot({ playerId: "P001" });
  assert.deepEqual(requestedUrls, [
    "https://script.google.com/macros/s/env/exec",
    "https://script.google.com/macros/s/option/exec",
  ]);
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

test("webhook timeout은 env로 조정하고 60초를 넘길 수 없다", async (t) => {
  setEnvironment(t, { SAMGUK_SHEET_WEBHOOK_TIMEOUT_MS: "10" });
  const writer = createSamgukSheetWriter({
    webhookUrl: "https://script.google.com/macros/s/test/exec",
    secret: SECRET,
    fetchImpl: async (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      }, { once: true });
    }),
  });
  await assert.rejects(
    writer.appendSnapshot({ playerId: "P001" }),
    error => error.code === "upstream_timeout",
  );

  assert.throws(() => createSamgukSheetWriter({
    webhookUrl: "https://script.google.com/macros/s/test/exec",
    secret: SECRET,
    timeoutMs: 60_001,
  }), /1~60000/);
});

test("writer는 redirect마다 Google host를 재검증한다", async () => {
  const requested = [];
  const writer = createSamgukSheetWriter({
    webhookUrl: "https://script.google.com/macros/s/test/exec",
    secret: SECRET,
    fetchImpl: async (url, init) => {
      requested.push({ url, method: init.method, body: init.body });
      if (requested.length === 1) {
        return new Response(null, {
          status: 302,
          headers: { Location: "https://script.googleusercontent.com/macros/echo?x=1" },
        });
      }
      return new Response(JSON.stringify({ ok: true, appendedRow: 3 }), { status: 200 });
    },
  });
  assert.equal((await writer.appendSnapshot({ playerId: "P001" })).ok, true);
  assert.equal(requested.length, 2);
  assert.equal(requested[0].method, "POST");
  assert.equal(requested[1].method, "GET");
  assert.equal(requested[1].body, undefined);

  const blocked = createSamgukSheetWriter({
    webhookUrl: "https://script.google.com/macros/s/test/exec",
    secret: SECRET,
    fetchImpl: async () => new Response(null, {
      status: 307,
      headers: { Location: "https://example.com/private" },
    }),
  });
  await assert.rejects(blocked.appendSnapshot({ playerId: "P001" }), /허용된 Google Apps Script/);
});

test("writer는 Content-Length 없이 흘러오는 큰 응답도 즉시 차단한다", async () => {
  const writer = createSamgukSheetWriter({
    webhookUrl: "https://script.google.com/macros/s/test/exec",
    secret: SECRET,
    maxResponseBytes: 8,
    fetchImpl: async () => new Response('{"ok":true,"padding":"large"}', { status: 200 }),
  });
  await assert.rejects(writer.appendSnapshot({ playerId: "P001" }), /응답이 너무 큽니다/);
});
