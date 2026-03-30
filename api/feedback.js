const { supabase } = require("../lib/supabase");

module.exports = async function handler(req, res) {
  // POST만 허용 (CSRF 방지)
  if (req.method === "POST") {
    const subject = (req.body?.subject || "").trim().slice(0, 200);
    const body = (req.body?.body || "").trim().slice(0, 5000);
    if (!subject || subject.length < 2) return res.status(400).json({ error: "제목을 2자 이상 입력해주세요" });
    if (!body || body.length < 5) return res.status(400).json({ error: "내용을 5자 이상 입력해주세요" });

    const { error } = await supabase.from("feedback").insert({ subject, body });
    if (error) return res.status(500).json({ error: "전송 실패" });
    return res.status(200).json({ ok: true });
  }

  // 조회 (어드민용)
  const key = req.query.key;
  if (key !== (process.env.ADMIN_KEY || "qowlstnrytnsla")) return res.status(403).json({ error: "Forbidden" });

  const { data, error } = await supabase
    .from("feedback")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.status(200).json(data);
};
