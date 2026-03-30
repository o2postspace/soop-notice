const { supabase } = require("../lib/supabase");

module.exports = async function handler(req, res) {
  // 본문은 자주 안 바뀌니 5분 캐시
  res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");

  const titleNo = parseInt(req.query.title_no);
  if (!titleNo) {
    return res.status(400).json({ error: "title_no required" });
  }

  const { data, error } = await supabase
    .from("notices")
    .select("content_html, reg_date")
    .eq("title_no", titleNo)
    .single();

  if (error) {
    return res.status(404).json({ error: "Not found" });
  }

  res.status(200).json({ content_html: data.content_html, reg_date: data.reg_date });
};
