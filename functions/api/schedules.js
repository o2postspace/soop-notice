import { createSupabase } from "../_shared/supabase.js";
import { POPULAR_BJ_IDS, BJ_LIST } from "../_shared/bj-list.js";

export async function onRequestGet(context) {
  const supabase = createSupabase(context.env);
  const url = new URL(context.request.url);

  const dayOffset = parseInt(url.searchParams.get("day_offset")) || 0;

  // 오늘 (KST 기준) + offset
  const now = new Date();
  const kstNow = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const targetDay = new Date(kstNow);
  targetDay.setUTCDate(targetDay.getUTCDate() + dayOffset);
  targetDay.setUTCHours(0, 0, 0, 0);

  const dayEnd = new Date(targetDay);
  dayEnd.setUTCHours(23, 59, 59, 999);

  // KST -> UTC 변환
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
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  // 시간순 flat 배열
  const slots = data.map(row => ({
    bj_id: row.bj_id,
    bj_name: BJ_LIST[row.bj_id]?.name || row.bj_name,
    start: row.broadcast_start,
    end: row.broadcast_end,
    title_no: row.title_no,
    description: row.description || row.raw_text,
  }));

  const dateStr = targetDay.toISOString().slice(0, 10);
  const dayNames = ['일', '월', '화', '수', '목', '금', '토'];
  const dayName = dayNames[targetDay.getUTCDay()];

  return new Response(JSON.stringify({ date: dateStr, day_name: dayName, slots }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "s-maxage=300, stale-while-revalidate=600",
    },
  });
}
