const { Router } = require("express");
const { select, inPlaceholders } = require("../db");
const { BJ_LIST, POPULAR_BJ_IDS } = require("../lib/bj-list");

const router = Router();

function getDayRange(dayOffset) {
  const now = new Date();
  const kstNow = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  if (kstNow.getUTCHours() < 6) kstNow.setUTCDate(kstNow.getUTCDate() - 1);
  const targetDay = new Date(kstNow);
  targetDay.setUTCDate(targetDay.getUTCDate() + dayOffset);
  targetDay.setUTCHours(6, 0, 0, 0);
  const dayEnd = new Date(targetDay);
  dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);
  dayEnd.setUTCHours(5, 59, 59, 999);
  return {
    targetDay,
    dayStartUTC: new Date(targetDay.getTime() - 9 * 60 * 60 * 1000).toISOString().slice(0, 19).replace("T", " "),
    dayEndUTC: new Date(dayEnd.getTime() - 9 * 60 * 60 * 1000).toISOString().slice(0, 19).replace("T", " "),
  };
}

router.get("/", async (req, res) => {
  try {
    const dayOffset = parseInt(req.query.day_offset) || 0;
    const { targetDay, dayStartUTC, dayEndUTC } = getDayRange(dayOffset);

    const sql = `SELECT s.*, n.reg_date AS notice_reg_date
      FROM schedules s LEFT JOIN notices n ON s.title_no = n.title_no
      WHERE s.bj_id IN (${inPlaceholders(POPULAR_BJ_IDS)})
      AND s.broadcast_start >= ? AND s.broadcast_start <= ?
      AND s.raw_text != '파싱결과없음'
      ORDER BY s.broadcast_start ASC`;
    const rows = await select(sql, [...POPULAR_BJ_IDS, dayStartUTC, dayEndUTC]);

    const seen = new Set();
    const slots = [];
    for (const row of rows) {
      if (seen.has(row.title_no)) continue;
      seen.add(row.title_no);
      slots.push({
        bj_id: row.bj_id,
        bj_name: BJ_LIST[row.bj_id]?.name || row.bj_name,
        start: row.broadcast_start,
        end: row.broadcast_end,
        title_no: row.title_no,
        description: row.description || row.raw_text,
        reg_date: row.notice_reg_date || null,
      });
    }

    const dateStr = targetDay.toISOString().slice(0, 10);
    const dayNames = ["일", "월", "화", "수", "목", "금", "토"];
    res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=600");
    res.json({ date: dateStr, day_name: dayNames[targetDay.getUTCDay()], slots });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
