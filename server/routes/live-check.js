const { Router } = require("express");

const router = Router();
const HEADERS = {
  Referer: "https://www.sooplive.co.kr/",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  Accept: "application/json",
};

router.get("/", async (req, res) => {
  const bjIds = (req.query.ids || "").split(",").filter(Boolean).slice(0, 50);
  if (bjIds.length === 0) return res.json({});

  const results = {};
  for (let i = 0; i < bjIds.length; i += 10) {
    const batch = bjIds.slice(i, i + 10);
    await Promise.all(batch.map(async (bjId) => {
      try {
        const resp = await fetch(`https://chapi.sooplive.co.kr/api/${bjId}/station`, { headers: HEADERS });
        if (!resp.ok) { results[bjId] = false; return; }
        const data = await resp.json();
        results[bjId] = !!data.broad;
      } catch { results[bjId] = false; }
    }));
  }
  res.json(results);
});

module.exports = router;
