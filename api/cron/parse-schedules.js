const { supabase } = require("../../lib/supabase");
const { POPULAR_BJ_IDS, BJ_LIST } = require("../../lib/bj-list");

const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent";

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

async function parseWithGemini(noticeText, today) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return [];

  const prompt = `SOOP BJ의 공지사항에서 방송 일정(날짜와 시간)을 추출해.
오늘: ${today}

${noticeText}

규칙:
- "오방공", "오늘 방송", "생방공지" → 공지 작성일
- "내일" → 작성일 다음날
- 시간 변환: "오후6시"→18:00, "5시"→17:00, "저녁9시"→21:00, "점심"→12:00, "새벽"→02:00
- 시간 없으면 start_time: null
- "쉽니다", "휴방", "오프" → 빈 배열 []
- 방송 일정이 아닌 글(일상, 홍보, 결과) → 빈 배열 []

JSON 배열로 응답: [{"date":"YYYY-MM-DD","start_time":"HH:MM","end_time":null}]`;

  try {
    const resp = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: "application/json",
          temperature: 0.1,
        },
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

module.exports = async function handler(req, res) {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const today = new Date().toLocaleDateString("ko-KR", {
    timeZone: "Asia/Seoul",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).replace(/\. /g, "-").replace(".", "");

  // 최근 3일 공지 중 인기 BJ 것만 가져오기
  const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
  const { data: notices, error } = await supabase
    .from("notices")
    .select("bj_id, bj_name, title_no, title_name, content_html, reg_date")
    .in("bj_id", POPULAR_BJ_IDS)
    .gte("reg_date", threeDaysAgo)
    .order("reg_date", { ascending: false });

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  // 이미 파싱된 title_no 확인
  const titleNos = notices.map((n) => n.title_no);
  const { data: existing } = await supabase
    .from("schedules")
    .select("title_no")
    .in("title_no", titleNos);
  const parsedSet = new Set((existing || []).map((e) => e.title_no));

  let totalParsed = 0;

  for (const notice of notices) {
    if (parsedSet.has(notice.title_no)) continue;

    const plainText = stripHtml(notice.content_html);
    if (!plainText || plainText.length < 5) continue;

    const noticeDate = notice.reg_date ? notice.reg_date.slice(0, 10) : today;
    const schedules = await parseWithGemini(
      `[작성일: ${noticeDate}] [제목: ${notice.title_name}] ${plainText}`,
      today
    );

    // rate limit 방지: 1초 대기
    await new Promise(r => setTimeout(r, 1000));

    if (schedules.length === 0) {
      // 파싱 결과 없음도 기록 (재파싱 방지)
      await supabase.from("schedules").upsert({
        bj_id: notice.bj_id,
        bj_name: notice.bj_name,
        title_no: notice.title_no,
        broadcast_start: notice.reg_date, // 공지 시간으로 대체
        raw_text: "파싱결과없음",
        parsed_at: new Date().toISOString(),
      }, { onConflict: "title_no,broadcast_start" });
      continue;
    }

    for (const s of schedules) {
      if (!s.date) continue;
      const startStr = s.start_time ? `${s.date}T${s.start_time}:00+09:00` : null;
      const endStr = s.end_time ? `${s.date}T${s.end_time}:00+09:00` : null;
      if (!startStr) continue;

      await supabase.from("schedules").upsert({
        bj_id: notice.bj_id,
        bj_name: notice.bj_name,
        title_no: notice.title_no,
        broadcast_start: startStr,
        broadcast_end: endStr,
        raw_text: `${notice.title_name}: ${s.start_time}~${s.end_time || "?"}`,
        parsed_at: new Date().toISOString(),
      }, { onConflict: "title_no,broadcast_start" });

      totalParsed++;
    }
  }

  res.status(200).json({ ok: true, parsed: totalParsed, checked: notices.length });
};
