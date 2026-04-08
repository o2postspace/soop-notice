const { Router } = require("express");
const { select } = require("../db");

const router = Router();

router.get("/", async (req, res) => {
  const titleNo = parseInt(req.query.title_no);
  if (!titleNo) return res.status(400).json({ error: "title_no required" });
  try {
    const rows = await select("SELECT content_html FROM notices WHERE title_no = ? LIMIT 1", [titleNo]);
    if (rows.length === 0) return res.status(404).json({ error: "Not found" });
    res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=600");
    res.json({ content_html: rows[0].content_html });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
