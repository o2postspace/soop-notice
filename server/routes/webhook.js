const express = require("express");
const crypto = require("node:crypto");
const path = require("node:path");
const { execFile } = require("node:child_process");

const router = express.Router();
const allowedRepositories = new Set(["soop-notice", "afreecanotice", "game2017v-web"]);
const deployUnits = new Map([
  ["soop-notice", "soop-notice-deploy"],
  ["afreecanotice", "soop-notice-deploy"],
  ["game2017v-web", "game2017v-deploy"],
]);

function systemdEnvironment(env = process.env) {
  const allowed = ["HOME", "PATH", "LANG", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"];
  return Object.fromEntries(allowed.filter(name => env[name]).map(name => [name, env[name]]));
}

router.post("/deploy", express.raw({ type: "application/json", limit: "1mb" }), (req, res) => {
  const secret = process.env.WEBHOOK_SECRET;
  if (!secret) return res.status(500).json({ error: "WEBHOOK_SECRET not set" });
  if (!Buffer.isBuffer(req.body)) return res.status(400).json({ error: "Invalid body" });

  const signature = String(req.headers["x-hub-signature-256"] || "");
  if (!/^sha256=[0-9a-f]{64}$/i.test(signature)) {
    return res.status(401).json({ error: "Invalid signature" });
  }

  const expected = "sha256=" + crypto.createHmac("sha256", secret).update(req.body).digest("hex");
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    return res.status(401).json({ error: "Invalid signature" });
  }

  let payload;
  try {
    payload = JSON.parse(req.body.toString("utf8"));
  } catch {
    return res.status(400).json({ error: "Invalid JSON" });
  }

  // master push만 배포
  if (payload.ref !== "refs/heads/master") {
    return res.json({ ok: true, skipped: true });
  }

  const repoName = payload.repository?.name || "";
  if (!allowedRepositories.has(repoName)) {
    return res.status(400).json({ error: "Unknown repository" });
  }
  const scriptPath = path.resolve(__dirname, "..", "scripts", "deploy.sh");
  const unit = deployUnits.get(repoName);
  const args = [
    "--user",
    "--collect",
    "--quiet",
    "--no-ask-password",
    `--unit=${unit}`,
    "--property=RuntimeMaxSec=15min",
    "/bin/bash",
    scriptPath,
    repoName,
  ];

  execFile("/usr/bin/systemd-run", args, {
    env: systemdEnvironment(),
    timeout: 10_000,
  }, (error, stdout, stderr) => {
    if (error) {
      console.error(`[webhook] failed to queue deploy for ${repoName}:`, stderr.trim() || error.message);
      if (!res.headersSent) res.status(503).json({ error: "Deploy queue unavailable" });
      return;
    }
    res.status(202).json({ ok: true, deploying: true, repo: repoName });
  });
});

module.exports = router;
module.exports._test = { systemdEnvironment };
