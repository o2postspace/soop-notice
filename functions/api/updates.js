import { createSupabase } from "../_shared/supabase.js";

export async function onRequestGet(context) {
  const supabase = createSupabase(context.env);

  const { data, error } = await supabase
    .from("updates")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(50);

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
      "Cache-Control": "s-maxage=30, stale-while-revalidate=60",
    },
  });
}
