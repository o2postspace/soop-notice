const { query, select, upsertSchedule, toMySQLDate, inPlaceholders } = require("../db");
const { POPULAR_BJ_IDS, BJ_LIST } = require("../lib/bj-list");

const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";
const ALERT_EMAIL = "kck106@naver.com";

async function sendAlert(subject, body) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return;
  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        from: "SOOP Notice <onboarding@resend.dev>",
        to: ALERT_EMAIL,
        subject,
        text: body,
      }),
    });
  } catch {}
}

const POPULAR_NAMES = POPULAR_BJ_IDS.map(id => BJ_LIST[id]?.name).filter(Boolean);

const SCHEDULE_KEYWORDS = [
  "시", "방송", "오늘", "내일", "오방공", "생방", "시작", "킵니다", "킬게",
  "갑니다", "ON", "합방", "좌표", "경매", "대회", "대전", "시간", "오후",
  "오전", "저녁", "새벽", "점심", "뵙겠", "출격", "예정", "콜라보",
  "월요일", "화요일", "수요일", "목요일", "금요일", "토요일", "일요일",
];

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

function extractImageUrls(html) {
  const urls = [];
  const regex = /<img[^>]+src=["']([^"']+)["']/gi;
  let match;
  while ((match = regex.exec(html || "")) !== null) {
    const url = match[1];
    if (url.startsWith("http")) urls.push(url);
  }
  return urls.slice(0, 5);
}

async function fetchImageAsBase64(url) {
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) return null;
    const contentType = resp.headers.get("content-type") || "image/jpeg";
    const buffer = await resp.arrayBuffer();
    return {
      inlineData: {
        mimeType: contentType.split(";")[0],
        data: Buffer.from(buffer).toString("base64"),
      },
    };
  } catch { return null; }
}

function hasScheduleKeyword(title, text) {
  const combined = (title || "") + " " + (text || "");
  return SCHEDULE_KEYWORDS.some(kw => combined.includes(kw));
}

async function parseWithGemini(noticeText, images, today, apiKey) {
  if (!apiKey) return [];

  const prompt = `SOOP BJ의 공지사항에서 "방송 시작 시간"을 추출해. 공지를 올린 시간이 아니라 실제 방송 시작 시간이야.
텍스트와 이미지 모두 확인해서 일정을 추출해.
오늘: ${today}

인기BJ 목록: ${POPULAR_NAMES.join(', ')}

${noticeText}

규칙:
- date는 반드시 "방송하는 날짜"로 판단:
  - "오늘", "오방공", "금일" → 작성일
  - "내일" → 작성일+1일 (단, 작성시간이 00:00~05:59 새벽이면 "내일"은 당일 낮을 의미하므로 작성일 그대로)
  - "월요일"~"일요일" → 해당 요일의 실제 날짜로 변환
- 시간은 반드시 "방송 시작 시간"만 추출 (공지 작성 시간 아님!)
- 본문에 시간이 명시되지 않지만 "시작합니다", "갑니다", "킵니다", "지금", "바로" 등 즉시 시작 표현이 있으면 → start_time은 [작성시간]을 사용
- 시간 정보가 전혀 없고 즉시 시작도 아니면 start_time: null
- 상식적으로 시간 판단:
  - BJ는 보통 낮~밤(12시~24시)에 방송함
  - 숫자만 있으면 오후로: "6시"→18:00, "7시"→19:00, "5시"→17:00, "1시"→13:00
  - "자고 6시에 온다" → 자고 일어나서 저녁에 = 18:00
  - "오전", "아침" 명시된 경우만 AM
  - "새벽" 명시된 경우만 AM
- 합방 상대가 인기BJ 목록에 있으면 mentioned_bjs에 이름 추가
- "좌표" = 해당 BJ 방송으로 가라는 뜻 → 합방
- "제방" = 제 방송, 그 BJ의 방 → 합방 장소
- description: 방송 내용 요약 (10~20자)
- "쉽니다", "휴방", "오프" → 빈 배열 []
- 방송 일정이 아닌 글(일상, 홍보, 경기결과, 모집) → 빈 배열 []

JSON: [{"date":"YYYY-MM-DD","start_time":"HH:MM","end_time":null,"description":"요약","mentioned_bjs":["이름"]}]`;

  const parts = [{ text: prompt }, ...images];

  try {
    const resp = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: { responseMimeType: "application/json", temperature: 0.1 },
      }),
    });
    if (!resp.ok) {
      if (resp.status === 429) {
        await sendAlert("[SOOP] Gemini 무료 한도 초과", `Gemini API 429 에러\n시간: ${new Date().toISOString()}`);
      } else {
        await sendAlert("[SOOP] Gemini API 에러", `Gemini API ${resp.status} 에러\n시간: ${new Date().toISOString()}`);
      }
      return [];
    }
    const data = await resp.json();
    return JSON.parse(data.candidates?.[0]?.content?.parts?.[0]?.text || "[]");
  } catch (e) {
    await sendAlert("[SOOP] parse-hot 에러", `파싱 중 에러\n시간: ${new Date().toISOString()}\n에러: ${e.message}`);
    return [];
  }
}

async function run() {
  const startTime = Date.now();
  try {
    const today = new Date().toLocaleDateString("ko-KR", {
      timeZone: "Asia/Seoul",
      year: "numeric", month: "2-digit", day: "2-digit",
    }).replace(/\. /g, "-").replace(".", "");

    const threeDaysAgo = toMySQLDate(new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString());

    // 글쓴이와 다른 BJ로 잘못 저장된 스케줄 정리
    const allSchedules = await query(
      "SELECT s.id, s.bj_id, s.title_no FROM schedules s WHERE s.broadcast_start >= ?",
      [threeDaysAgo]
    );
    if (allSchedules.length > 0) {
      const titleNos = [...new Set(allSchedules.map(s => s.title_no))];
      const noticeOwners = await query(
        `SELECT title_no, bj_id FROM notices WHERE title_no IN (${inPlaceholders(titleNos)})`,
        titleNos
      );
      const ownerMap = {};
      noticeOwners.forEach(n => { ownerMap[n.title_no] = n.bj_id; });
      const badIds = allSchedules
        .filter(s => ownerMap[s.title_no] && ownerMap[s.title_no] !== s.bj_id)
        .map(s => s.id);
      if (badIds.length > 0) {
        await query(`DELETE FROM schedules WHERE id IN (${inPlaceholders(badIds)})`, badIds);
      }
    }

    // 조회수 1000+ 공지 (3일간)
    const notices = await select(
      `SELECT bj_id, bj_name, title_no, title_name, content_html, reg_date, read_cnt
       FROM notices WHERE reg_date >= ? AND read_cnt >= 1000
       ORDER BY reg_date DESC LIMIT 300`,
      [threeDaysAgo]
    );

    // 이미 파싱된 title_no 스킵
    const allTitleNos = notices.map(n => n.title_no);
    let parsedSet = new Set();
    if (allTitleNos.length > 0) {
      const existing = await query(
        `SELECT DISTINCT title_no FROM schedules WHERE title_no IN (${inPlaceholders(allTitleNos)})`,
        allTitleNos
      );
      parsedSet = new Set(existing.map(e => e.title_no));
    }

    const toParse = notices.filter(n => {
      if (parsedSet.has(n.title_no)) return false;
      const plainText = stripHtml(n.content_html);
      if (!plainText || plainText.length < 5) return false;
      return hasScheduleKeyword(n.title_name, plainText);
    });

    let totalParsed = 0;

    for (const notice of toParse) {
      const plainText = stripHtml(notice.content_html);
      const noticeDate = notice.reg_date ? notice.reg_date.slice(0, 10) : today;
      const noticeTime = notice.reg_date ? notice.reg_date.slice(11, 16) : "00:00";

      const imageUrls = extractImageUrls(notice.content_html);
      const imageParts = (await Promise.all(imageUrls.map(fetchImageAsBase64))).filter(Boolean);

      const schedules = await parseWithGemini(
        `[작성일: ${noticeDate}] [작성시간: ${noticeTime} KST] [BJ: ${notice.bj_name}] [제목: ${notice.title_name}] ${plainText}`,
        imageParts,
        today,
        process.env.GEMINI_API_KEY
      );
      await new Promise(r => setTimeout(r, 500));
      if (schedules.length === 0) continue;

      for (const s of schedules) {
        if (!s.date || !s.start_time) continue;
        const startStr = `${s.date}T${s.start_time}:00+09:00`;
        const endStr = s.end_time ? `${s.date}T${s.end_time}:00+09:00` : null;

        await upsertSchedule({
          bj_id: notice.bj_id,
          bj_name: notice.bj_name,
          title_no: notice.title_no,
          broadcast_start: startStr,
          broadcast_end: endStr,
          description: s.description || notice.title_name || "",
          raw_text: `${notice.title_name}: ${s.start_time}~${s.end_time || "?"}`,
          parsed_at: new Date().toISOString(),
        });
        totalParsed++;

        // 언급된 인기 BJ도 캘린더에 추가
        for (const bjName of (s.mentioned_bjs || [])) {
          const bjEntry = Object.entries(BJ_LIST).find(([, v]) => v.name === bjName);
          if (!bjEntry) continue;
          if (bjEntry[0] === notice.bj_id) continue;

          const ownNotice = await query(
            "SELECT title_no FROM notices WHERE bj_id = ? AND reg_date >= ? ORDER BY reg_date DESC LIMIT 1",
            [bjEntry[0], threeDaysAgo]
          );
          const collabTitleNo = ownNotice[0]?.title_no || null;
          if (!collabTitleNo) continue;

          try {
            await upsertSchedule({
              bj_id: bjEntry[0],
              bj_name: bjName,
              title_no: collabTitleNo,
              broadcast_start: startStr,
              broadcast_end: endStr,
              description: `${notice.bj_name} 합방: ${s.description || ""}`,
              raw_text: `합방(${notice.bj_name}): ${s.start_time}~${s.end_time || "?"}`,
              parsed_at: new Date().toISOString(),
            });
            totalParsed++;
          } catch {}
        }
      }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[parse-hot] ${totalParsed} parsed, ${notices.length} checked, ${toParse.length} filtered, ${parsedSet.size} skipped (${elapsed}s)`);
  } catch (e) {
    console.error("[parse-hot] error:", e.message);
    await sendAlert("[SOOP] parse-hot 에러", `에러: ${e.message}\n시간: ${new Date().toISOString()}`);
  }
}

module.exports = run;
