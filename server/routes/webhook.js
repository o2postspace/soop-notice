const { Router } = require("express");
const crypto = require("crypto");
const { exec } = require("child_process");

const router = Router();

router.post("/deploy", express_raw(), (req, res) => {
  const secret = process.env.WEBHOOK_SECRET;
  if (!secret) return res.status(500).json({ error: "WEBHOOK_SECRET not set" });

  const signature = req.headers["x-hub-signature-256"];
  if (!signature) return res.status(401).json({ error: "No signature" });

  const expected = "sha256=" + crypto.createHmac("sha256", secret).update(req.rawBody).digest("hex");
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    return res.status(401).json({ error: "Invalid signature" });
  }

  const payload = JSON.parse(req.rawBody);

  // master push만 배포
  if (payload.ref !== "refs/heads/master") {
    return res.json({ ok: true, skipped: true });
  }

  const repoName = payload.repository?.name || "";
  const scriptDir = __dirname.replace(/routes$/, "scripts");

  exec(`bash ${scriptDir}/deploy.sh ${repoName}`, (err, stdout, stderr) => {
    if (err) console.error(`[webhook] deploy error for ${repoName}:`, stderr);
    else console.log(`[webhook] deployed ${repoName}:`, stdout.trim());
  });

  res.json({ ok: true, deploying: true, repo: repoName });
});

// raw body를 보존하는 미들웨어 (시그니처 검증용)
function express_raw() {
  return (req, res, next) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", chunk => { data += chunk; });
    req.on("end", () => {
      req.rawBody = data;
      try { req.body = JSON.parse(data); } catch { req.body = {}; }
      next();
    });
  };
}

module.exports = router;
