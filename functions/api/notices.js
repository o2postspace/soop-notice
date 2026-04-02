import { createSupabase } from "../_shared/supabase.js";
import { BJ_LIST } from "../_shared/bj-list.js";

export async function onRequestGet(context) {
  const supabase = createSupabase(context.env);
  const validIds = Object.keys(BJ_LIST);

  const { data: d1, error: e1 } = await supabase
    .from("notices")
    .select("*")
    .in("bj_id", validIds)
    .order("reg_date", { ascending: false })
    .range(0, 999);

  const { data: d2, error: e2 } = await supabase
    .from("notices")
    .select("*")
    .in("bj_id", validIds)
    .order("reg_date", { ascending: false })
    .range(1000, 1999);

  const { data: d3, error: e3 } = await supabase
    .from("notices")
    .select("*")
    .in("bj_id", validIds)
    .order("reg_date", { ascending: false })
    .range(2000, 2999);

  const data = [...(d1 || []), ...(d2 || []), ...(d3 || [])];
  const error = e1 || e2 || e3;

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
