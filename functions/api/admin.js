import { createSupabase } from "../_shared/supabase.js";

const ADMIN_KEY = "qowlstnrytnsla";

export async function onRequest(context) {
  const supabase = createSupabase(context.env);
  const url = new URL(context.request.url);
  const key = url.searchParams.get("key");
  if (key !== ADMIN_KEY) return new Response(JSON.stringify({ error: "Forbidden" }), { status: 403, headers: { "Content-Type": "application/json" } });

  const action = url.searchParams.get("action");
  const json = (d) => new Response(JSON.stringify(d), { status: 200, headers: { "Content-Type": "application/json" } });
  const err = (m, s=500) => new Response(JSON.stringify({ error: m }), { status: s, headers: { "Content-Type": "application/json" } });

  if (action === "delete-notice") {
    const titleNo = parseInt(url.searchParams.get("title_no"));
    if (!titleNo) return err("title_no required", 400);
    const { error } = await supabase.from("notices").delete().eq("title_no", titleNo);
    return error ? err(error.message) : json({ ok: true });
  }

  if (action === "delete-schedule") {
    const id = parseInt(url.searchParams.get("id"));
    if (!id) return err("id required", 400);
    const { error } = await supabase.from("schedules").delete().eq("id", id);
    return error ? err(error.message) : json({ ok: true });
  }

  if (action === "add-schedule") {
    const bj_name = url.searchParams.get("bj_name");
    const broadcast_start = url.searchParams.get("broadcast_start");
    const description = url.searchParams.get("description") || "";
    if (!bj_name || !broadcast_start) return err("bj_name, broadcast_start required", 400);
    const { error } = await supabase.from("schedules").insert({
      bj_id: "manual", bj_name, title_no: Date.now(), broadcast_start, description, raw_text: "수동 추가", parsed_at: new Date().toISOString(),
    });
    return error ? err(error.message) : json({ ok: true });
  }

  if (action === "edit-schedule") {
    const id = parseInt(url.searchParams.get("id"));
    if (!id) return err("id required", 400);
    const updates = {};
    if (url.searchParams.get("broadcast_start")) updates.broadcast_start = url.searchParams.get("broadcast_start");
    if (url.searchParams.get("description")) updates.description = url.searchParams.get("description");
    if (url.searchParams.get("bj_name")) updates.bj_name = url.searchParams.get("bj_name");
    const { error } = await supabase.from("schedules").update(updates).eq("id", id);
    return error ? err(error.message) : json({ ok: true });
  }

  if (action === "list-schedules") {
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await supabase.from("schedules").select("*").gte("broadcast_start", threeDaysAgo).order("broadcast_start", { ascending: false }).limit(100);
    return error ? err(error.message) : json(data);
  }

  return err("Unknown action", 400);
}
