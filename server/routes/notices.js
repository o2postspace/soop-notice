const { Router } = require("express");
const { select, inPlaceholders } = require("../db");
const { BJ_LIST } = require("../lib/bj-list");

const router = Router();

router.get("/", async (req, res) => {
  try {
    const validIds = Object.keys(BJ_LIST);
    const sql = `SELECT * FROM notices WHERE bj_id IN (${inPlaceholders(validIds)})
      ORDER BY reg_date DESC LIMIT 3000`;
    const data = await select(sql, validIds);
    res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=120");
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
