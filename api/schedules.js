const { supabase } = require("../lib/supabase");
const { POPULAR_BJ_IDS, BJ_LIST } = require("../lib/bj-list");

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");

  const dayOffset = parseInt(req.query.day_offset) || 0;

  // 오늘 (KST 기준) + offset — 하루 기준: 08:00 ~ 다음날 08:00
  const now = new Date();
  const kstNow = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  // 현재 KST가 08시 이전이면 전날로 판단
  if (kstNow.getUTCHours() < 8) kstNow.setUTCDate(kstNow.getUTCDate() - 1);
  const targetDay = new Date(kstNow);
  targetDay.setUTCDate(targetDay.getUTCDate() + dayOffset);
  targetDay.setUTCHours(8, 0, 0, 0); // 당일 08:00 KST

  const dayEnd = new Date(targetDay);
  dayEnd.setUTCDate(dayEnd.getUTCDate() + 1); // 다음날 08:00 KST
  dayEnd.setUTCHours(7, 59, 59, 999);

  // KST → UTC 변환
  const dayStartUTC = new Date(targetDay.getTime() - 9 * 60 * 60 * 1000).toISOString();
  const dayEndUTC = new Date(dayEnd.getTime() - 9 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from("schedules")
    .select("*")
    .in("bj_id", POPULAR_BJ_IDS)
    .gte("broadcast_start", dayStartUTC)
    .lte("broadcast_start", dayEndUTC)
    .neq("raw_text", "파싱결과없음")
    .order("broadcast_start", { ascending: true });

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  // title_no 목록으로 notices에서 reg_date 가져오기
  const titleNos = data.map(r => r.title_no).filter(Boolean);
  let regDateMap = {};
  if (titleNos.length > 0) {
    const { data: notices } = await supabase
      .from("notices")
      .select("title_no, reg_date")
      .in("title_no", titleNos);
    if (notices) {
      notices.forEach(n => { regDateMap[n.title_no] = n.reg_date; });
    }
  }

  // 시간순 flat 배열 → title_no 기준 중복 제거 (첫 번째 시간만)
  const seen = new Set();
  const slots = [];
  for (const row of data) {
    if (seen.has(row.title_no)) continue;
    seen.add(row.title_no);
    slots.push({
      bj_id: row.bj_id,
      bj_name: BJ_LIST[row.bj_id]?.name || row.bj_name,
      start: row.broadcast_start,
      end: row.broadcast_end,
      title_no: row.title_no,
      description: row.description || row.raw_text,
      reg_date: regDateMap[row.title_no] || null,
    });
  }

  const dateStr = targetDay.toISOString().slice(0, 10);
  const dayNames = ['일', '월', '화', '수', '목', '금', '토'];
  const dayName = dayNames[targetDay.getUTCDay()];

  res.status(200).json({ date: dateStr, day_name: dayName, slots });
};
