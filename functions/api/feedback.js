import { createSupabase } from "../_shared/supabase.js";

export async function onRequest(context) {
  const supabase = createSupabase(context.env);
  const url = new URL(context.request.url);

  if (context.request.method === "POST") {
    const body = await context.request.json().catch(() => ({}));
    const subject = body.subject;
    const content = body.body;
    if (!subject || !content) return new Response(JSON.stringify({ error: "제목과 내용을 입력해주세요" }), { status: 400, headers: { "Content-Type": "application/json" } });

    const { error } = await supabase.from("feedback").insert({ subject, body: content });
    if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { "Content-Type": "application/json" } });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
  }

  // GET - 어드민 조회
  const key = url.searchParams.get("key");
  if (key !== (context.env.ADMIN_KEY || "qowlstnrytnsla")) return new Response(JSON.stringify({ error: "Forbidden" }), { status: 403, headers: { "Content-Type": "application/json" } });

  const { data, error } = await supabase.from("feedback").select("*").order("created_at", { ascending: false });
  if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { "Content-Type": "application/json" } });
  return new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
}
