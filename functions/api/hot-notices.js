import { createSupabase } from "../_shared/supabase.js";

export async function onRequestGet(context) {
  const supabase = createSupabase(context.env);
  const url = new URL(context.request.url);
  const dayOffset = parseInt(url.searchParams.get("day_offset")) || 0;

  // 하루 기준: 08:00 KST ~ 다음날 08:00 KST
  const now = new Date();
  const kstNow = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  if (kstNow.getUTCHours() < 8) kstNow.setUTCDate(kstNow.getUTCDate() - 1);
  const targetDay = new Date(kstNow);
  targetDay.setUTCDate(targetDay.getUTCDate() + dayOffset);
  targetDay.setUTCHours(8, 0, 0, 0);

  const dayEnd = new Date(targetDay);
  dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);
  dayEnd.setUTCHours(7, 59, 59, 999);

  const dayStartUTC = new Date(targetDay.getTime() - 9 * 60 * 60 * 1000).toISOString();
  const dayEndUTC = new Date(dayEnd.getTime() - 9 * 60 * 60 * 1000).toISOString();

  const { data: scheduleData } = await supabase
    .from("schedules")
    .select("bj_id, bj_name, title_no, broadcast_start, description")
    .gte("broadcast_start", dayStartUTC)
    .lte("broadcast_start", dayEndUTC)
    .neq("raw_text", "파싱결과없음")
    .order("broadcast_start", { ascending: true });

  const titleNos = (scheduleData || []).map(s => s.title_no);
  let hotTitleNos = new Map();
  if (titleNos.length > 0) {
    const { data: noticeData } = await supabase
      .from("notices")
      .select("title_no, read_cnt, title_name, reg_date")
      .in("title_no", titleNos)
      .gte("read_cnt", 1000);
    for (const n of (noticeData || [])) {
      hotTitleNos.set(n.title_no, n);
    }
  }

  const seen = new Set();
  const slots = [];
  for (const s of (scheduleData || [])) {
    if (!hotTitleNos.has(s.title_no)) continue;
    if (seen.has(s.title_no)) continue;
    seen.add(s.title_no);
    const notice = hotTitleNos.get(s.title_no);
    slots.push({
      bj_id: s.bj_id, bj_name: s.bj_name, title_no: s.title_no,
      broadcast_start: s.broadcast_start, description: s.description,
      title_name: notice?.title_name || "", read_cnt: notice?.read_cnt || 0,
      reg_date: notice?.reg_date || null,
    });
  }

  const dateStr = targetDay.toISOString().slice(0, 10);
  const dayNames = ['일', '월', '화', '수', '목', '금', '토'];
  const dayName = dayNames[targetDay.getUTCDay()];

  return new Response(JSON.stringify({ date: dateStr, day_name: dayName, slots }), {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "s-maxage=300, stale-while-revalidate=600" },
  });
}
