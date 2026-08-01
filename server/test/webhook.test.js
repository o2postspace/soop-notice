const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { createApp } = require("../app");
const { systemdEnvironment } = require("../routes/webhook")._test;

function signature(secret, body) {
  return `sha256=${crypto.createHmac("sha256", secret).update(body).digest("hex")}`;
}

test("webhook 배포 프로세스에는 앱 비밀값을 전달하지 않는다", () => {
  const filtered = systemdEnvironment({
    HOME: "/safe-home",
    PATH: "/usr/bin",
    DB_PASSWORD: "must-not-pass",
    WEBHOOK_SECRET: "must-not-pass",
  });
  assert.deepEqual(filtered, { HOME: "/safe-home", PATH: "/usr/bin" });
});

test("webhook은 JSON 파싱 전 원문으로 서명을 검증한다", { concurrency: false }, async t => {
  const previousSecret = process.env.WEBHOOK_SECRET;
  const secret = "webhook-test-secret-not-used-outside-tests";
  process.env.WEBHOOK_SECRET = secret;
  t.after(() => {
    if (previousSecret === undefined) delete process.env.WEBHOOK_SECRET;
    else process.env.WEBHOOK_SECRET = previousSecret;
  });

  const app = createApp();
  const server = await new Promise(resolve => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/webhook/deploy`;
  const body = JSON.stringify({
    ref: "refs/heads/not-master",
    repository: { name: "soop-notice" },
  });

  const invalid = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-hub-signature-256": `sha256=${"0".repeat(64)}`,
    },
    body,
  });
  assert.equal(invalid.status, 401);

  const valid = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-hub-signature-256": signature(secret, body),
    },
    body,
  });
  assert.equal(valid.status, 200);
  assert.deepEqual(await valid.json(), { ok: true, skipped: true });
});
