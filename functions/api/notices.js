import { createSupabase } from "../_shared/supabase.js";
import { BJ_LIST } from "../_shared/bj-list.js";

export async function onRequestGet(context) {
  const supabase = createSupabase(context.env);
  const validIds = Object.keys(BJ_LIST);

  const { data, error } = await supabase
    .from("notices")
    .select("*")
    .in("bj_id", validIds)
    .order("reg_date", { ascending: false })
    .limit(3000);

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  return new Response(JSON.stringify(data), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "s-maxage=60, stale-while-revalidate=120",
    },
  });
}
