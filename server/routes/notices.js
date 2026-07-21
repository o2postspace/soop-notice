const { Router } = require("express");
const { select, inPlaceholders } = require("../db");
const { BJ_LIST } = require("../lib/bj-list");

const router = Router();

router.get("/", async (req, res) => {
  try {
    const validIds = Object.keys(BJ_LIST);
    // 원문 전체는 일정 추출에만 내부 사용하고 공개 목록에는 재게시하지 않는다.
    const sql = `SELECT bj_id, bj_name, bj_tag, title_no, title_name, reg_date,
        read_cnt, is_pin, updated_at
      FROM notices WHERE bj_id IN (${inPlaceholders(validIds)})
      ORDER BY reg_date DESC LIMIT 3000`;
    const data = await select(sql, validIds);
    res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=120");
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
