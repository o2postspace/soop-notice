const { supabase } = require("../lib/supabase");
const { POPULAR_BJ_IDS, BJ_LIST } = require("../lib/bj-list");

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");

  const weekOffset = parseInt(req.query.week_offset) || 0;

  // 이번 주 월요일~일요일 (KST 기준)
  const now = new Date();
  const kstNow = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const day = kstNow.getUTCDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;

  const monday = new Date(kstNow);
  monday.setUTCDate(monday.getUTCDate() + mondayOffset + weekOffset * 7);
  monday.setUTCHours(0, 0, 0, 0);

  const sunday = new Date(monday);
  sunday.setUTCDate(sunday.getUTCDate() + 6);
  sunday.setUTCHours(23, 59, 59, 999);

  // KST 월요일 00:00 = UTC 전날 15:00, KST 일요일 23:59 = UTC 일요일 14:59
  const weekStart = new Date(monday.getTime() - 9 * 60 * 60 * 1000).toISOString();
  const weekEnd = new Date(sunday.getTime() - 9 * 60 * 60 * 1000).toISOString();


  const { data, error } = await supabase
    .from("schedules")
    .select("*")
    .in("bj_id", POPULAR_BJ_IDS)
    .gte("broadcast_start", weekStart)
    .lte("broadcast_start", weekEnd)
    .neq("raw_text", "파싱결과없음")
    .order("broadcast_start", { ascending: true });

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  // BJ별로 그룹핑
  const schedules = {};
  for (const bjId of POPULAR_BJ_IDS) {
    schedules[bjId] = {
      name: BJ_LIST[bjId]?.name || bjId,
      slots: [],
    };
  }

  for (const row of data) {
    if (!schedules[row.bj_id]) continue;
    schedules[row.bj_id].slots.push({
      start: row.broadcast_start,
      end: row.broadcast_end,
      title_no: row.title_no,
      description: row.description || row.raw_text,
    });
  }

  const weekStartKST = monday.toISOString().slice(0, 10);
  const weekEndKST = sunday.toISOString().slice(0, 10);

  res.status(200).json({ week_start: weekStartKST, week_end: weekEndKST, schedules });
};
