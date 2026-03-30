import { createSupabase } from "../_shared/supabase.js";
import { BJ_LIST } from "../_shared/bj-list.js";

export async function onRequestGet(context) {
  const supabase = createSupabase(context.env);
  const url = new URL(context.request.url);

  const validIds = Object.keys(BJ_LIST);
  const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get("limit")) || 8));
  const offset = Math.max(0, parseInt(url.searchParams.get("offset")) || 0);

  const { data, error, count } = await supabase
    .from("notices")
    .select("*", { count: "exact" })
    .in("bj_id", validIds)
    .order("reg_date", { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  // 친구 버전과 동일한 grouped 형식
  const grouped = {};
  for (const row of data) {
    if (!grouped[row.bj_id]) {
      grouped[row.bj_id] = {
        name: row.bj_name,
        tag: null,
        notices: [],
      };
    }
    grouped[row.bj_id].notices.push({
      title_no: row.title_no,
      title_name: row.title_name,
      contentHtml: row.content_html,
      reg_date: row.reg_date,
      count: { read_cnt: row.read_cnt },
      is_pin: row.is_pin,
      is_notice: true,
    });
  }

  return new Response(JSON.stringify({ data: grouped, offset, limit, total: count }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "s-maxage=60, stale-while-revalidate=120",
    },
  });
}
