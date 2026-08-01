const { Router } = require("express");
const { query, select } = require("../db");
const { requireAdmin } = require("../middleware/admin-auth");

const router = Router();

// POST - 유저 피드백 제출
router.post("/", async (req, res) => {
  const { subject, body: content } = req.body || {};
  if (!subject || !content) return res.status(400).json({ error: "제목과 내용을 입력해주세요" });
  try {
    await query("INSERT INTO feedback (subject, body) VALUES (?, ?)", [subject, content]);
    res.json({ ok: true });
  } catch (e) {
    console.error("feedback submission error", e);
    res.status(500).json({ error: "서버 오류가 발생했습니다" });
  }
});

// GET - 어드민 조회
router.get("/", requireAdmin, async (req, res) => {
  res.set("Cache-Control", "no-store");
  try {
    const data = await select("SELECT * FROM feedback ORDER BY created_at DESC");
    res.json(data);
  } catch (e) {
    console.error("feedback admin route error", e);
    res.status(500).json({ error: "서버 오류가 발생했습니다" });
  }
});

module.exports = router;
