const { supabase } = require("../lib/supabase");

module.exports = async function handler(req, res) {
  // CDN 캐시: 60초 신선 + 120초 stale 허용
  // 만명이 접속해도 Supabase는 1분에 1번만 쿼리
  res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=120");

  const { data, error } = await supabase
    .from("notices")
    .select("bj_id,bj_name,bj_tag,title_no,title_name,reg_date,read_cnt,is_pin")
    .order("reg_date", { ascending: false });

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  res.status(200).json(data);
};
