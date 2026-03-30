const { supabase } = require("../lib/supabase");

module.exports = async function handler(req, res) {
  if (req.method === "POST" || req.query.subject) {
    // 저장
    const subject = req.query.subject || req.body?.subject;
    const body = req.query.body || req.body?.body;
    if (!subject || !body) return res.status(400).json({ error: "제목과 내용을 입력해주세요" });

    const { error } = await supabase.from("feedback").insert({ subject, body });
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true });
  }

  // 조회 (어드민용)
  const key = req.query.key;
  if (key !== "qowlstnrytnsla") return res.status(403).json({ error: "Forbidden" });

  const { data, error } = await supabase
    .from("feedback")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.status(200).json(data);
};
