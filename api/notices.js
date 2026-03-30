const { supabase } = require("../lib/supabase");
const { BJ_LIST } = require("../lib/bj-list");

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=120");

  const validIds = Object.keys(BJ_LIST);

  const { data, error } = await supabase
    .from("notices")
    .select("*")
    .in("bj_id", validIds)
    .order("reg_date", { ascending: false })
    .limit(1000);

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  // 이미지 최적화: 프록시로 축소 + lazy loading
  for (const row of data) {
    if (row.content_html) {
      row.content_html = row.content_html
        .replace(/src="(https?:\/\/[^"]+\.(?:jpg|jpeg|png|webp|gif)[^"]*)"/gi, (match, url) => {
          const proxy = 'https://wsrv.nl/?url=' + encodeURIComponent(url) + '&w=400&output=webp&q=75';
          return 'src="' + proxy + '" data-full="' + url + '"';
        })
        .replace(/<img(?![^>]*loading)/gi, '<img loading="lazy"');
    }
  }

  res.status(200).json(data);
};
