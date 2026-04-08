const { Router } = require("express");
const { select } = require("../db");

const router = Router();

router.get("/", async (req, res) => {
  try {
    const data = await select("SELECT * FROM updates ORDER BY created_at DESC LIMIT 50");
    res.setHeader("Cache-Control", "public, s-maxage=30, stale-while-revalidate=60");
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
