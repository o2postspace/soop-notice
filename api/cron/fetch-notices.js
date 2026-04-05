const { supabase } = require("../../lib/supabase");
const { BJ_LIST, POPULAR_BJ_IDS } = require("../../lib/bj-list");

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

async function getExistingTitleNos() {
  const all = [];
  for (let i = 0; ; i += 1000) {
    const { data } = await supabase
      .from("notices")
      .select("title_no")
      .range(i, i + 999);
    if (!data || data.length === 0) break;
    all.push(...data.map((r) => r.title_no));
    if (data.length < 1000) break;
  }
  return new Set(all);
}

module.exports = async function handler(req, res) {
  // Vercel Cron 인증
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  // 1) DB에 이미 있는 title_no 조회
  const existingIds = await getExistingTitleNos();

  // group 파라미터로 인기 BJ / 나머지 분리
  const group = req.query.group;
  const allBjIds = Object.keys(BJ_LIST);
  const popularSet = new Set(POPULAR_BJ_IDS);
  const bjIds = group === "popular"
    ? allBjIds.filter((id) => popularSet.has(id))
    : group === "rest"
    ? allBjIds.filter((id) => !popularSet.has(id))
    : allBjIds;
  let totalUpserted = 0;
  let newCount = 0;

  // 20개씩 배치로 처리
  const BATCH_SIZE = 30;
  for (let i = 0; i < bjIds.length; i += BATCH_SIZE) {
    const batch = bjIds.slice(i, i + BATCH_SIZE);

    const results = await Promise.all(
      batch.map(async (bjId) => {
        const info = BJ_LIST[bjId];
        const notices = await fetchNotices(bjId);

        const rows = await Promise.all(
          notices.map(async (n) => {
            const isNew = !existingIds.has(n.title_no);
            // 새 공지만 본문 가져오기 (기존 공지는 메타데이터만 업데이트)
            const contentHtml = isNew
              ? await fetchPostContent(bjId, n.title_no)
              : undefined;
            if (isNew) newCount++;

            const row = {
              bj_id: bjId,
              bj_name: info.name,
              bj_tag: "",
              title_no: n.title_no,
              title_name: n.title_name || "",
              reg_date: n.reg_date,
              read_cnt: n.count?.read_cnt || 0,
              is_pin: !!n.is_pin,
              updated_at: new Date().toISOString(),
            };
            if (isNew) row.content_html = contentHtml;
            return row;
          })
        );
        return rows;
      })
    );

    const allRows = results.flat();
    if (allRows.length > 0) {
      // 새 공지 (content_html 포함)와 기존 공지 (메타만) 분리
      const newRows = allRows.filter((r) => r.content_html !== undefined);
      const existingRows = allRows.filter((r) => r.content_html === undefined);

      if (newRows.length > 0) {
        const { error } = await supabase
          .from("notices")
          .upsert(newRows, { onConflict: "title_no" });
        if (error) console.error("Upsert new error:", error.message);
        else totalUpserted += newRows.length;
      }

      if (existingRows.length > 0) {
        // 기존 공지는 content_html 건드리지 않고 메타만 업데이트
        const { error } = await supabase
          .from("notices")
          .upsert(existingRows, { onConflict: "title_no", ignoreDuplicates: false });
        if (error) console.error("Upsert existing error:", error.message);
        else totalUpserted += existingRows.length;
      }
    }
  }

  res.status(200).json({ ok: true, upserted: totalUpserted, new: newCount });
};
