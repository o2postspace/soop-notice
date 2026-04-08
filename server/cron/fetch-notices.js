const { query, upsertNotices } = require("../db");
const { BJ_LIST, POPULAR_BJ_IDS } = require("../lib/bj-list");

const API_URL = "https://chapi.sooplive.co.kr/api/{bj_id}/home";
const POST_API_URL = "https://api-channel.sooplive.co.kr/v1.1/channel/{bj_id}/post/{title_no}";
const HEADERS = {
  Referer: "https://www.sooplive.co.kr/",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  Accept: "application/json",
};

async function fetchNoticesFromAPI(bjId) {
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
  const rows = await query("SELECT title_no FROM notices");
  return new Set(rows.map(r => r.title_no));
}

async function run(group) {
  const startTime = Date.now();
  try {
    const existingIds = await getExistingTitleNos();

    const allBjIds = Object.keys(BJ_LIST);
    const popularSet = new Set(POPULAR_BJ_IDS);
    const bjIds = group === "popular"
      ? allBjIds.filter(id => popularSet.has(id))
      : group === "rest"
      ? allBjIds.filter(id => !popularSet.has(id))
      : allBjIds;

    let totalUpserted = 0;
    let newCount = 0;
    const BATCH_SIZE = 30;

    for (let i = 0; i < bjIds.length; i += BATCH_SIZE) {
      const batch = bjIds.slice(i, i + BATCH_SIZE);

      const results = await Promise.all(
        batch.map(async (bjId) => {
          const info = BJ_LIST[bjId];
          const notices = await fetchNoticesFromAPI(bjId);

          const rows = await Promise.all(
            notices.map(async (n) => {
              const isNew = !existingIds.has(n.title_no);
              const contentHtml = isNew ? await fetchPostContent(bjId, n.title_no) : undefined;
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
        await upsertNotices(allRows);
        totalUpserted += allRows.length;
      }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[fetch-notices:${group}] ${totalUpserted} upserted, ${newCount} new (${elapsed}s)`);
  } catch (e) {
    console.error(`[fetch-notices:${group}] error:`, e.message);
  }
}

module.exports = run;
