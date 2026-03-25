const { supabase } = require("../lib/supabase");

module.exports = async function handler(req, res) {
  // CDN 캐시 60초 + stale 120초
  res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=120");

  const { data, error } = await supabase
    .from("notices")
    .select("*")
    .order("reg_date", { ascending: false });

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  // 기존 프론트엔드 형식에 맞게 변환
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

  res.status(200).json(grouped);
};
