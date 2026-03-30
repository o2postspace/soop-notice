import { createSupabase } from "../_shared/supabase.js";
import { BJ_LIST } from "../_shared/bj-list.js";

export async function onRequestGet(context) {
  const supabase = createSupabase(context.env);
  const validIds = Object.keys(BJ_LIST);

  const { data, error } = await supabase
    .from("notices")
    .select("*")
    .in("bj_id", validIds)
    .order("reg_date", { ascending: false })
    .limit(1000);

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
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

  return new Response(JSON.stringify(data), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "s-maxage=60, stale-while-revalidate=120",
    },
  });
}
