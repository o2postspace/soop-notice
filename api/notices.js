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

  // 친구 버전과 동일한 grouped 형식
  const grouped = {};
  for (const row of data) {
    if (!grouped[row.bj_id]) {
      grouped[row.bj_id] = {
        name: row.bj_name,
        tag: row.bj_tag,
        notices: [],
      };
    }
    grouped[row.bj_id].notices.push({
      title_no: row.title_no,
      title_name: row.title_name,
      contentHtml: row.content_html,
      reg_date: row.reg_date,
      count: { read_cnt: row.read_cnt },
      is_pin: row.is_pin,
      is_notice: true,
    });
  }

  res.status(200).json({ data: grouped, offset, limit, total: count });
};
