const { Router } = require("express");
const { select, inPlaceholders } = require("../db");
const { BJ_LIST } = require("../lib/bj-list");
const {
  createEncodedJsonCache,
  sendEncodedJson,
} = require("../lib/encoded-json-cache");

const router = Router();
const validIds = Object.keys(BJ_LIST);
const sql = `SELECT * FROM notices WHERE bj_id IN (${inPlaceholders(validIds)})
  ORDER BY reg_date DESC LIMIT 3000`;
const noticesCache = createEncodedJsonCache({
  load: () => select(sql, validIds),
  ttlMs: 60_000,
  staleIfErrorMs: 15_000,
  onRefreshError: error => console.error("[notices] cache refresh failed:", error.message),
});

router.get("/", async (req, res) => {
  try {
    const entry = await noticesCache.get();
    sendEncodedJson(req, res, entry);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
