const { supabase } = require("../lib/supabase");

const ADMIN_KEY = process.env.ADMIN_KEY || "qowlstnrytnsla";

module.exports = async function handler(req, res) {
  if (req.query.key !== ADMIN_KEY) return res.status(403).json({ error: "Forbidden" });

  const action = req.query.action;

  // 공지 삭제
  if (action === "delete-notice") {
    const titleNo = parseInt(req.query.title_no);
    if (!titleNo) return res.status(400).json({ error: "title_no required" });
    const { error } = await supabase.from("notices").delete().eq("title_no", titleNo);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true });
  }

  // 캘린더 일정 삭제
  if (action === "delete-schedule") {
    const id = parseInt(req.query.id);
    if (!id) return res.status(400).json({ error: "id required" });
    const { error } = await supabase.from("schedules").delete().eq("id", id);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true });
  }

  // 캘린더 일정 수동 추가
  if (action === "add-schedule") {
    const { bj_name, broadcast_start, description } = req.query;
    if (!bj_name || !broadcast_start) return res.status(400).json({ error: "bj_name, broadcast_start required" });
    const { error } = await supabase.from("schedules").insert({
      bj_id: "manual",
      bj_name,
      title_no: Date.now(),
      broadcast_start,
      description: description || "",
      raw_text: "수동 추가",
      parsed_at: new Date().toISOString(),
    });
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true });
  }

  // 캘린더 일정 수정
  if (action === "edit-schedule") {
    const id = parseInt(req.query.id);
    if (!id) return res.status(400).json({ error: "id required" });
    const updates = {};
    if (req.query.broadcast_start) updates.broadcast_start = req.query.broadcast_start;
    if (req.query.description) updates.description = req.query.description;
    if (req.query.bj_name) updates.bj_name = req.query.bj_name;
    const { error } = await supabase.from("schedules").update(updates).eq("id", id);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true });
  }

  // 캘린더 일정 목록 (최근 3일)
  if (action === "list-schedules") {
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await supabase.from("schedules").select("*")
      .gte("broadcast_start", threeDaysAgo).order("broadcast_start", { ascending: false }).limit(100);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json(data);
  }

  return res.status(400).json({ error: "Unknown action" });
};
