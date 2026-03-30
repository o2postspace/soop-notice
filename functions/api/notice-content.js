import { createSupabase } from "../_shared/supabase.js";

export async function onRequestGet(context) {
  const supabase = createSupabase(context.env);
  const url = new URL(context.request.url);

  const titleNo = parseInt(url.searchParams.get("title_no"));
  if (!titleNo) {
    return new Response(JSON.stringify({ error: "title_no required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const { data, error } = await supabase
    .from("notices")
    .select("content_html")
    .eq("title_no", titleNo)
    .single();

  if (error) {
    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  return new Response(JSON.stringify({ content_html: data.content_html }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "s-maxage=300, stale-while-revalidate=600",
    },
  });
}
