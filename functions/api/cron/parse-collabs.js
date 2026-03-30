import { createSupabase } from "../../_shared/supabase.js";
import { POPULAR_BJ_IDS, BJ_LIST } from "../../_shared/bj-list.js";

const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";
const POPULAR_NAMES = POPULAR_BJ_IDS.map(id => BJ_LIST[id]?.name).filter(Boolean);

function stripHtml(html) {
  return (html || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

async function parseCollab(noticeText, today, apiKey) {
  if (!apiKey) return [];

  const prompt = `SOOP BJ의 공지사항에서 합방/콜라보 정보를 추출해.
오늘: ${today}

인기BJ 목록: ${POPULAR_NAMES.join(', ')}

${noticeText}

규칙:
- 인기BJ 목록에 있는 이름이 공지에 언급되면 추출
- "좌표" = 해당 BJ 방송으로 이동 → 합방 의미
- 시간: "7시"→19:00, "5시"→17:00 (BJ는 보통 오후~저녁 방송)
- "오후6시"→18:00, "저녁9시"→21:00, "새벽2시"→02:00, "오전11시"→11:00
- 시간 없으면 start_time: null
- 인기BJ 언급이 없으면 빈 배열 []
- 방송 일정이 아닌 글 → 빈 배열 []

JSON: [{"date":"YYYY-MM-DD","start_time":"HH:MM","end_time":null,"description":"요약","mentioned_bjs":["인기BJ이름"]}]`;

  try {
    const resp = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: "application/json", temperature: 0.1 },
      }),
    });
    if (!resp.ok) return [];
    const data = await resp.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "[]";
    return JSON.parse(text);
  } catch {
    return [];
  }
}

export async function onRequest(context) {
  if (context.request.headers.get("Authorization") !== `Bearer ${context.env.CRON_SECRET}`) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const supabase = createSupabase(context.env);

  const today = new Date().toLocaleDateString("ko-KR", {
    timeZone: "Asia/Seoul",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).replace(/\. /g, "-").replace(".", "");

  const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();

  // 인기 BJ가 아닌 다른 BJ 공지 중 최근 것
  const { data: otherNotices, error } = await supabase
    .from("notices")
    .select("bj_id, bj_name, title_no, title_name, content_html, reg_date")
    .not("bj_id", "in", "(" + POPULAR_BJ_IDS.join(",") + ")")
    .gte("reg_date", threeDaysAgo)
    .order("reg_date", { ascending: false })
    .limit(200);

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  // 인기 BJ 이름이나 "좌표"가 언급된 공지만 필터
  const collabNotices = (otherNotices || []).filter(n => {
    const text = (n.title_name || "") + " " + stripHtml(n.content_html);
    return POPULAR_NAMES.some(name => text.includes(name)) || text.includes("좌표");
  });

  // 이미 파싱된 건 건너뛰기
  const titleNos = collabNotices.map(n => n.title_no);
  const { data: existing } = await supabase
    .from("schedules").select("title_no").in("title_no", titleNos.length > 0 ? titleNos : [0]);
  const parsedSet = new Set((existing || []).map(e => e.title_no));

  let totalParsed = 0;

  for (const notice of collabNotices) {
    if (parsedSet.has(notice.title_no)) continue;
    const plainText = stripHtml(notice.content_html);
    if (!plainText || plainText.length < 5) continue;

    const noticeDate = notice.reg_date ? notice.reg_date.slice(0, 10) : today;
    const schedules = await parseCollab(
      `[작성일: ${noticeDate}] [BJ: ${notice.bj_name}] [제목: ${notice.title_name}] ${plainText}`,
      today,
      context.env.GEMINI_API_KEY
    );
    await new Promise(r => setTimeout(r, 1000));
    if (schedules.length === 0) continue;

    for (const s of schedules) {
      if (!s.date) continue;
      const startStr = s.start_time ? `${s.date}T${s.start_time}:00+09:00` : null;
      const endStr = s.end_time ? `${s.date}T${s.end_time}:00+09:00` : null;

      // 언급된 인기 BJ들의 캘린더에 추가
      const mentioned = s.mentioned_bjs || [];
      for (const bjName of mentioned) {
        const bjEntry = Object.entries(BJ_LIST).find(([, v]) => v.name === bjName);
        if (!bjEntry || !POPULAR_BJ_IDS.includes(bjEntry[0])) continue;
        if (!startStr) continue;

        try {
          await supabase.from("schedules").upsert({
            bj_id: bjEntry[0],
            bj_name: bjName,
            title_no: notice.title_no,
            broadcast_start: startStr,
            broadcast_end: endStr,
            description: `${notice.bj_name} 합방: ${s.description || ""}`,
            raw_text: `합방(${notice.bj_name}): ${s.start_time}~${s.end_time || "?"}`,
            parsed_at: new Date().toISOString(),
          }, { onConflict: "title_no,broadcast_start" });
          totalParsed++;
        } catch(e) { /* 중복 무시 */ }
      }
    }
  }

  return new Response(JSON.stringify({ ok: true, parsed: totalParsed, collabCandidates: collabNotices.length }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
