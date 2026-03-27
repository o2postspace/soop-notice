const { supabase } = require("../../lib/supabase");
const { POPULAR_BJ_IDS, BJ_LIST } = require("../../lib/bj-list");

const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";

// 인기 BJ 이름 목록 (합방 감지용)
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

// HTML에서 이미지 URL 추출 (최대 3개)
function extractImageUrls(html) {
  const urls = [];
  const regex = /(?:src|data-url)="(https?:\/\/[^"]+\.(?:jpg|jpeg|png|webp|gif)[^"]*)"/gi;
  let match;
  while ((match = regex.exec(html)) !== null && urls.length < 3) {
    const url = match[1];
    if (!url.includes('ogqmarket') && !url.includes('sticker')) urls.push(url);
  }
  return urls;
}

async function parseWithGemini(noticeText, today, imageUrls) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return [];

  const prompt = `SOOP BJ의 공지사항에서 "방송 시작 시간"을 추출해. 공지를 올린 시간이 아니라 실제 방송 시작 시간이야.
텍스트에 시간이 없으면 첨부된 이미지도 확인해.
오늘: ${today}

인기BJ 목록: ${POPULAR_NAMES.join(', ')}

${noticeText}

규칙:
- "오방공", "오늘 방송", "생방공지" → 공지 작성일 날짜
- "내일" → 작성일 다음날
- 시간은 반드시 본문/이미지에 명시된 방송 시작 시간만 추출 (공지 작성 시간 아님!)
- 본문/이미지에 시간이 명시되지 않으면 start_time: null
- BJ는 보통 오후~저녁에 방송함. "7시"→19:00, "5시"→17:00, "1시"→13:00, "2시"→14:00 (오전이 명시된 경우만 AM)
- "오후6시"→18:00, "저녁9시"→21:00, "점심"→12:00, "새벽2시"→02:00, "오전11시"→11:00
- "좌표" = 해당 BJ 방송으로 가라는 뜻 → 합방 의미
- 합방 상대가 인기BJ 목록에 있으면 mentioned_bjs에 해당 이름들 추가
- description: 방송 내용 요약 (합방 상대, 컨텐츠명, 대회명 등 10~20자)
- "쉽니다", "휴방", "오프" → 빈 배열 []
- 방송 일정이 아닌 글(일상, 홍보, 경기결과, 모집) → 빈 배열 []

JSON: [{"date":"YYYY-MM-DD","start_time":"HH:MM","end_time":null,"description":"요약","mentioned_bjs":["이름1"]}]`;

  // parts: 텍스트 + 이미지 URL
  const parts = [{ text: prompt }];
  for (const url of (imageUrls || [])) {
    parts.push({
      fileData: { mimeType: "image/jpeg", fileUri: url }
    });
  }

  try {
    const resp = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: {
          responseMimeType: "application/json",
          temperature: 0.1,
        },
      }),
    });

    if (!resp.ok) {
      console.error("Gemini error:", resp.status, await resp.text().catch(() => ""));
      return [];
    }
    const data = await resp.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "[]";
    return JSON.parse(text);
  } catch(e) {
    console.error("Parse error:", e.message);
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

  // 최근 3일 공지 가져오기 (인기 BJ 본인 공지 + 합방 언급 감지용 전체)
  const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();

  // 1) 인기 BJ 본인 공지
  const { data: popularNotices, error } = await supabase
    .from("notices")
    .select("bj_id, bj_name, title_no, title_name, content_html, reg_date")
    .in("bj_id", POPULAR_BJ_IDS)
    .gte("reg_date", threeDaysAgo)
    .order("reg_date", { ascending: false });

  // 2) 다른 BJ 공지 중 인기 BJ 이름이 언급된 것 (합방 감지)
  const { data: otherNotices } = await supabase
    .from("notices")
    .select("bj_id, bj_name, title_no, title_name, content_html, reg_date")
    .not("bj_id", "in", "(" + POPULAR_BJ_IDS.join(",") + ")")
    .gte("reg_date", threeDaysAgo)
    .order("reg_date", { ascending: false })
    .limit(100);

  // 인기 BJ 이름이 언급된 공지만 필터
  const collabNotices = (otherNotices || []).filter(n => {
    const text = (n.title_name || "") + " " + stripHtml(n.content_html);
    return POPULAR_NAMES.some(name => text.includes(name)) || text.includes("좌표");
  });

  const notices = [...(popularNotices || []), ...collabNotices];

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
    const imageUrls = extractImageUrls(notice.content_html);
    const schedules = await parseWithGemini(
      `[작성일: ${noticeDate}] [제목: ${notice.title_name}] ${plainText}`,
      today,
      imageUrls
    );

    // rate limit 방지: 1초 대기
    await new Promise(r => setTimeout(r, 1000));

    if (schedules.length === 0) continue;

    for (const s of schedules) {
      if (!s.date) continue;
      const startStr = s.start_time ? `${s.date}T${s.start_time}:00+09:00` : null;
      const endStr = s.end_time ? `${s.date}T${s.end_time}:00+09:00` : null;
      if (!startStr) continue;

      // 공지 작성자 본인 저장
      await supabase.from("schedules").upsert({
        bj_id: notice.bj_id,
        bj_name: notice.bj_name,
        title_no: notice.title_no,
        broadcast_start: startStr,
        broadcast_end: endStr,
        description: s.description || notice.title_name || "",
        raw_text: `${notice.title_name}: ${s.start_time}~${s.end_time || "?"}`,
        parsed_at: new Date().toISOString(),
      }, { onConflict: "title_no,broadcast_start" });
      totalParsed++;

      // 언급된 인기 BJ들도 캘린더에 추가
      const mentioned = s.mentioned_bjs || [];
      for (const bjName of mentioned) {
        const bjEntry = Object.entries(BJ_LIST).find(([, v]) => v.name === bjName);
        if (!bjEntry || !POPULAR_BJ_IDS.includes(bjEntry[0])) continue;
        if (bjEntry[0] === notice.bj_id) continue; // 본인은 이미 저장됨
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
        } catch(e) { /* 중복 무시 */ }
        totalParsed++;
      }
    }
  }

  res.status(200).json({ ok: true, parsed: totalParsed, checked: notices.length });
};
