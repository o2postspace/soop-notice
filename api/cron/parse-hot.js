const { supabase } = require("../../lib/supabase");

const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";

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

async function parseWithGemini(noticeText, today, apiKey) {
  if (!apiKey) return [];

  const prompt = `SOOP BJ의 공지사항에서 "방송 시작 시간"을 추출해. 공지를 올린 시간이 아니라 실제 방송 시작 시간이야.
오늘: ${today}

${noticeText}

규칙:
- date는 반드시 "방송하는 날짜"로 판단:
  - "오늘", "오방공" → 작성일
  - "내일" → 작성일+1일
  - "월요일"~"일요일" → 해당 요일의 실제 날짜로 변환 (오늘 기준 이번주/다음주)
  - "목요일 방송", "수요일에" → 해당 요일 날짜
- 시간은 반드시 "방송 시작 시간"만 추출 (공지 작성 시간 아님!)
- 본문에 시간이 명시되지 않으면 start_time: null
- 상식적으로 시간 판단:
  - BJ는 보통 낮~밤(12시~24시)에 방송함
  - 숫자만 있으면 오후로: "6시"→18:00, "7시"→19:00, "5시"→17:00, "1시"→13:00, "2시"→14:00, "3시"→15:00
  - "자고 6시에 온다" → 자고 일어나서 저녁에 = 18:00
  - "오전", "아침" 명시된 경우만 AM: "오전11시"→11:00
  - "새벽" 명시된 경우만 AM: "새벽2시"→02:00
  - "오후6시"→18:00, "저녁9시"→21:00, "점심"→12:00, "밤12시"→00:00
  - "11시" → 문맥상 밤이면 23:00, 낮이면 11:00 (맥락으로 판단)
- description: 방송 내용 요약 (10~20자)
- "쉽니다", "휴방", "오프" → 빈 배열 []
- 방송 일정이 아닌 글(일상, 홍보, 경기결과, 모집) → 빈 배열 []

JSON: [{"date":"YYYY-MM-DD","start_time":"HH:MM","end_time":null,"description":"요약"}]`;

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

module.exports = async function handler(req, res) {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const today = new Date().toLocaleDateString("ko-KR", {
    timeZone: "Asia/Seoul",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).replace(/\. /g, "-").replace(".", "");

  const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();

  // 조회수 1000+ 공지 중 최근 3일
  const { data: notices, error } = await supabase
    .from("notices")
    .select("bj_id, bj_name, title_no, title_name, content_html, reg_date, read_cnt")
    .gte("reg_date", threeDaysAgo)
    .gte("read_cnt", 1000)
    .order("reg_date", { ascending: false })
    .limit(50);

  if (error) return res.status(500).json({ error: error.message });

  // 이미 파싱된 건 건너뛰기
  const titleNos = notices.map(n => n.title_no);
  const { data: existing } = await supabase
    .from("schedules").select("title_no").in("title_no", titleNos.length > 0 ? titleNos : [0]);
  const parsedSet = new Set((existing || []).map(e => e.title_no));

  let totalParsed = 0;

  for (const notice of notices) {
    if (parsedSet.has(notice.title_no)) continue;
    const plainText = stripHtml(notice.content_html);
    if (!plainText || plainText.length < 5) continue;

    const noticeDate = notice.reg_date ? notice.reg_date.slice(0, 10) : today;
    const schedules = await parseWithGemini(
      `[작성일: ${noticeDate}] [제목: ${notice.title_name}] ${plainText}`,
      today,
      process.env.GEMINI_API_KEY
    );
    await new Promise(r => setTimeout(r, 1000));
    if (schedules.length === 0) continue;

    for (const s of schedules) {
      if (!s.date || !s.start_time) continue;
      await supabase.from("schedules").upsert({
        bj_id: notice.bj_id,
        bj_name: notice.bj_name,
        title_no: notice.title_no,
        broadcast_start: `${s.date}T${s.start_time}:00+09:00`,
        broadcast_end: s.end_time ? `${s.date}T${s.end_time}:00+09:00` : null,
        description: s.description || notice.title_name || "",
        raw_text: `${notice.title_name}: ${s.start_time}~${s.end_time || "?"}`,
        parsed_at: new Date().toISOString(),
      }, { onConflict: "title_no,broadcast_start" });
      totalParsed++;
    }
  }

  res.status(200).json({ ok: true, parsed: totalParsed, checked: notices.length });
};
