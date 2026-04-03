import { createSupabase } from "../../_shared/supabase.js";

const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";
const ALERT_EMAIL = "kck106@naver.com";

async function sendAlert(subject, body, resendKey) {
  if (!resendKey) return;
  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${resendKey}` },
      body: JSON.stringify({ from: "SOOP Notice <onboarding@resend.dev>", to: ALERT_EMAIL, subject, text: body }),
    });
  } catch {}
}

function stripHtml(html) {
  return (html || "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();
}

function extractImageUrls(html) {
  const urls = [];
  const regex = /<img[^>]+src=["']([^"']+)["']/gi;
  let match;
  while ((match = regex.exec(html || "")) !== null) {
    if (match[1].startsWith("http")) urls.push(match[1]);
  }
  return urls.slice(0, 5);
}

async function fetchImageAsBase64(url) {
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) return null;
    const contentType = (resp.headers.get("content-type") || "image/jpeg").split(";")[0];
    const buffer = await resp.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return { inlineData: { mimeType: contentType, data: btoa(binary) } };
  } catch { return null; }
}

async function parseWithGemini(noticeText, images, today, apiKey, resendKey) {
  if (!apiKey) return [];
  const prompt = `SOOP BJ의 공지사항에서 "방송 시작 시간"을 추출해. 공지를 올린 시간이 아니라 실제 방송 시작 시간이야.
텍스트와 이미지 모두 확인해서 일정을 추출해.
오늘: ${today}
${noticeText}
규칙:
- "오방공", "오늘 방송", "생방공지" → 공지 작성일 날짜
- "내일" → 작성일 다음날 (단, 작성시간이 00:00~05:59 새벽이면 "내일"은 당일 낮을 의미하므로 작성일 그대로)
- 시간은 본문에 명시된 방송 시작 시간만 (공지 작성 시간 아님!)
- 본문에 시간이 없으면 start_time: null
- BJ는 보통 오후~저녁에 방송. "7시"→19:00, "5시"→17:00, "1시"→13:00
- description: 방송 내용 요약 (10~20자)
- "쉽니다", "휴방" → 빈 배열 []
- 방송 일정 아닌 글 → 빈 배열 []
JSON: [{"date":"YYYY-MM-DD","start_time":"HH:MM","end_time":null,"description":"요약"}]`;
  const parts = [{ text: prompt }, ...images];
  try {
    const resp = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts }], generationConfig: { responseMimeType: "application/json", temperature: 0.1 } }),
    });
    if (!resp.ok) {
      if (resp.status === 429) await sendAlert("[SOOP] Gemini 무료 한도 초과", `Gemini API 429 에러\n시간: ${new Date().toISOString()}`, resendKey);
      else await sendAlert("[SOOP] Gemini API 에러", `Gemini API ${resp.status} 에러\n시간: ${new Date().toISOString()}`, resendKey);
      return [];
    }
    const data = await resp.json();
    return JSON.parse(data.candidates?.[0]?.content?.parts?.[0]?.text || "[]");
  } catch (e) {
    await sendAlert("[SOOP] parse-hot 에러", `파싱 중 에러\n시간: ${new Date().toISOString()}\n에러: ${e.message}`, resendKey);
    return [];
  }
}

export async function onRequest(context) {
  if (context.request.headers.get("Authorization") !== `Bearer ${context.env.CRON_SECRET}`) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });
  }
  const supabase = createSupabase(context.env);
  const today = new Date().toLocaleDateString("ko-KR", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).replace(/\. /g, "-").replace(".", "");
  const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();

  // 글쓴이와 다른 BJ로 잘못 저장된 스케줄 정리
  const { data: allSch } = await supabase.from("schedules").select("id, bj_id, title_no").gte("broadcast_start", threeDaysAgo);
  if (allSch && allSch.length > 0) {
    const tNos = [...new Set(allSch.map(s => s.title_no))];
    const { data: owners } = await supabase.from("notices").select("title_no, bj_id").in("title_no", tNos);
    if (owners) {
      const om = {}; owners.forEach(n => { om[n.title_no] = n.bj_id; });
      const badIds = allSch.filter(s => om[s.title_no] && om[s.title_no] !== s.bj_id).map(s => s.id);
      if (badIds.length > 0) await supabase.from("schedules").delete().in("id", badIds);
    }
  }

  const { data: notices, error } = await supabase.from("notices").select("bj_id, bj_name, title_no, title_name, content_html, reg_date, read_cnt").gte("reg_date", threeDaysAgo).gte("read_cnt", 1000).order("reg_date", { ascending: false }).limit(50);
  if (error) {
    await sendAlert("[SOOP] Supabase 에러", `notices 조회 실패\n시간: ${new Date().toISOString()}\n에러: ${error.message}`, context.env.RESEND_API_KEY);
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { "Content-Type": "application/json" } });
  }

  const titleNos = notices.map(n => n.title_no);
  const { data: existing } = await supabase.from("schedules").select("title_no").in("title_no", titleNos.length > 0 ? titleNos : [0]);
  const parsedSet = new Set((existing || []).map(e => e.title_no));
  let totalParsed = 0;

  for (const notice of notices) {
    if (parsedSet.has(notice.title_no)) continue;
    const plainText = stripHtml(notice.content_html);
    if (!plainText || plainText.length < 5) continue;
    const noticeDate = notice.reg_date ? notice.reg_date.slice(0, 10) : today;
    const imageUrls = extractImageUrls(notice.content_html);
    const imageParts = (await Promise.all(imageUrls.map(fetchImageAsBase64))).filter(Boolean);
    const schedules = await parseWithGemini(`[작성일: ${noticeDate}] [제목: ${notice.title_name}] ${plainText}`, imageParts, today, context.env.GEMINI_API_KEY, context.env.RESEND_API_KEY);
    await new Promise(r => setTimeout(r, 1000));
    if (schedules.length === 0) continue;
    for (const s of schedules) {
      if (!s.date || !s.start_time) continue;
      await supabase.from("schedules").upsert({ bj_id: notice.bj_id, bj_name: notice.bj_name, title_no: notice.title_no, broadcast_start: `${s.date}T${s.start_time}:00+09:00`, broadcast_end: s.end_time ? `${s.date}T${s.end_time}:00+09:00` : null, description: s.description || notice.title_name || "", raw_text: `${notice.title_name}: ${s.start_time}~${s.end_time || "?"}`, parsed_at: new Date().toISOString() }, { onConflict: "title_no,broadcast_start" });
      totalParsed++;
    }
  }
  return new Response(JSON.stringify({ ok: true, parsed: totalParsed, checked: notices.length }), { status: 200, headers: { "Content-Type": "application/json" } });
}
