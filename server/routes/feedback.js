const { Router } = require("express");
const { query, select } = require("../db");

const router = Router();

// POST - 유저 피드백 제출
router.post("/", async (req, res) => {
  const { subject, body: content } = req.body || {};
  if (!subject || !content) return res.status(400).json({ error: "제목과 내용을 입력해주세요" });
  try {
    await query("INSERT INTO feedback (subject, body) VALUES (?, ?)", [subject, content]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET - 어드민 조회
router.get("/", async (req, res) => {
  const ADMIN_KEY = process.env.ADMIN_KEY || "qowlstnrytnsla";
  if (req.query.key !== ADMIN_KEY) return res.status(403).json({ error: "Forbidden" });
  try {
    const data = await select("SELECT * FROM feedback ORDER BY created_at DESC");
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
