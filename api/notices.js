const { supabase } = require("../lib/supabase");

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=120");

  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 8));
  const offset = Math.max(0, parseInt(req.query.offset) || 0);

  const { data, error, count } = await supabase
    .from("notices")
    .select("*", { count: "exact" })
    .order("reg_date", { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  const notices = data.map((row) => ({
    bjId: row.bj_id,
    name: row.bj_name,
    tag: row.bj_tag,
    title_no: row.title_no,
    title_name: row.title_name,
    contentHtml: row.content_html,
    reg_date: row.reg_date,
    read_cnt: row.read_cnt,
    is_pin: row.is_pin,
  }));

  res.status(200).json({ notices, offset, limit, total: count });
};
