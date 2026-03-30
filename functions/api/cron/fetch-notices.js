import { createSupabase } from "../../_shared/supabase.js";
import { BJ_LIST } from "../../_shared/bj-list.js";

const API_URL = "https://chapi.sooplive.co.kr/api/{bj_id}/home";
const POST_API_URL = "https://api-channel.sooplive.co.kr/v1.1/channel/{bj_id}/post/{title_no}";
const HEADERS = {
  Referer: "https://www.sooplive.co.kr/",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  Accept: "application/json",
};

async function fetchNotices(bjId) {
  try {
    const url = API_URL.replace("{bj_id}", bjId);
    const resp = await fetch(url, { headers: HEADERS });
    if (!resp.ok) return [];
    const data = await resp.json();
    return data.boards || [];
  } catch {
    return [];
  }
}

async function fetchPostContent(bjId, titleNo) {
  try {
    const url = POST_API_URL.replace("{bj_id}", bjId).replace("{title_no}", titleNo);
    const resp = await fetch(url, { headers: HEADERS });
    if (!resp.ok) return "";
    const data = await resp.json();
    return data.content?.content || "";
  } catch {
    return "";
  }
}

export async function onRequest(context) {
  // Cron 인증
  if (context.request.headers.get("Authorization") !== `Bearer ${context.env.CRON_SECRET}`) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const supabase = createSupabase(context.env);
  const bjIds = Object.keys(BJ_LIST);
  let totalUpserted = 0;

  // 10개씩 배치로 처리 (rate limit 방지)
  const BATCH_SIZE = 10;
  for (let i = 0; i < bjIds.length; i += BATCH_SIZE) {
    const batch = bjIds.slice(i, i + BATCH_SIZE);

    const results = await Promise.all(
      batch.map(async (bjId) => {
        const info = BJ_LIST[bjId];
        const notices = await fetchNotices(bjId);

        const rows = await Promise.all(
          notices.map(async (n) => {
            const contentHtml = await fetchPostContent(bjId, n.title_no);
            return {
              bj_id: bjId,
              bj_name: info.name,
              bj_tag: "",
              title_no: n.title_no,
              title_name: n.title_name || "",
              content_html: contentHtml,
              reg_date: n.reg_date,
              read_cnt: n.count?.read_cnt || 0,
              is_pin: !!n.is_pin,
              updated_at: new Date().toISOString(),
            };
          })
        );
        return rows;
      })
    );

    const allRows = results.flat();
    if (allRows.length > 0) {
      const { error } = await supabase
        .from("notices")
        .upsert(allRows, { onConflict: "title_no" });

      if (error) console.error("Upsert error:", error.message);
      else totalUpserted += allRows.length;
    }
  }

  return new Response(JSON.stringify({ ok: true, upserted: totalUpserted }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
