const { Router } = require("express");
const { select } = require("../db");

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

    const sql = `SELECT s.bj_id, s.bj_name, s.title_no, s.broadcast_start, s.description,
        n.title_name, n.read_cnt, n.reg_date
      FROM schedules s INNER JOIN notices n ON s.title_no = n.title_no
      WHERE s.broadcast_start >= ? AND s.broadcast_start <= ?
      AND s.raw_text != '파싱결과없음' AND n.read_cnt >= 1000
      ORDER BY s.broadcast_start ASC`;
    const rows = await select(sql, [dayStartUTC, dayEndUTC]);

    const seen = new Set();
    const slots = [];
    for (const row of rows) {
      if (seen.has(row.title_no)) continue;
      seen.add(row.title_no);
      slots.push({
        bj_id: row.bj_id, bj_name: row.bj_name, title_no: row.title_no,
        broadcast_start: row.broadcast_start, description: row.description,
        title_name: row.title_name || "", read_cnt: row.read_cnt || 0,
        reg_date: row.reg_date || null,
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
