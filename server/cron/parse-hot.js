const { query, select, upsertSchedule, toMySQLDate, inPlaceholders } = require("../db");
const { POPULAR_BJ_IDS, BJ_LIST } = require("../lib/bj-list");

const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
const ALERT_EMAIL = "kck106@naver.com";
const GEMINI_TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS) || 30000;
const GEMINI_REQUEST_INTERVAL_MS = Number(process.env.GEMINI_REQUEST_INTERVAL_MS) || 7000;
const PARSE_BATCH_SIZE = Number(process.env.PARSE_BATCH_SIZE) || 180;
const GEMINI_BATCH_SIZE = Number(process.env.GEMINI_BATCH_SIZE) || 12;
const GEMINI_BATCH_MAX_IMAGES = Number(process.env.GEMINI_BATCH_MAX_IMAGES) || 7;
const GEMINI_MAX_IMAGE_BYTES = Number(process.env.GEMINI_MAX_IMAGE_BYTES) || 4000000;
const GEMINI_BATCH_MAX_IMAGE_BYTES = Number(process.env.GEMINI_BATCH_MAX_IMAGE_BYTES) || 10000000;
const GEMINI_NOTICE_TEXT_LIMIT = Number(process.env.GEMINI_NOTICE_TEXT_LIMIT) || 2000;
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

async function sendAlert(subject, body) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return;
  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10000),
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
    const contentLength = Number(resp.headers.get("content-length"));
    if (contentLength > GEMINI_MAX_IMAGE_BYTES) return null;
    const buffer = await resp.arrayBuffer();
    if (buffer.byteLength > GEMINI_MAX_IMAGE_BYTES) return null;
    return {
      byteLength: buffer.byteLength,
      part: {
        inlineData: {
          mimeType: contentType.split(";")[0],
          data: Buffer.from(buffer).toString("base64"),
        },
      },
    };
  } catch { return null; }
}

function hasScheduleKeyword(title, text) {
  const combined = (title || "") + " " + (text || "");
  return SCHEDULE_KEYWORDS.some(kw => combined.includes(kw));
}

function toKSTDateTime(isoStr, fallbackDate, fallbackTime = "00:00") {
  const date = new Date(isoStr);
  if (Number.isNaN(date.getTime())) {
    return { date: fallbackDate, time: fallbackTime };
  }
  const kst = new Date(date.getTime() + KST_OFFSET_MS);
  return {
    date: kst.toISOString().slice(0, 10),
    time: kst.toISOString().slice(11, 16),
  };
}

function parseGeminiPayload(data) {
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Gemini response has no content");
  const schedules = JSON.parse(text);
  if (!Array.isArray(schedules)) throw new Error("Gemini response is not an array");
  return schedules;
}

function selectBroadcastSchedules(schedules) {
  if (!Array.isArray(schedules)) return [];
  return schedules.filter(schedule => {
    if (!schedule || typeof schedule !== "object") return false;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(schedule.date || "")) return false;
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(schedule.start_time || "")) return false;
    return !Number.isNaN(new Date(`${schedule.date}T${schedule.start_time}:00+09:00`).getTime());
  }).slice(0, 1);
}

const SCHEDULE_SCHEMA = {
  type: "object",
  properties: {
    date: { type: "string", description: "YYYY-MM-DD" },
    start_time: { type: "string", description: "HH:MM in KST" },
    end_time: { type: "string", description: "HH:MM in KST; omit when unknown" },
    description: { type: "string" },
    mentioned_bjs: { type: "array", items: { type: "string" } },
  },
  required: ["date", "start_time", "description", "mentioned_bjs"],
};
const SCHEDULE_ARRAY_SCHEMA = { type: "array", items: SCHEDULE_SCHEMA };
const BATCH_RESPONSE_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    properties: {
      title_no: { type: "string" },
      schedules: SCHEDULE_ARRAY_SCHEMA,
    },
    required: ["title_no", "schedules"],
  },
};

async function requestGemini(parts, apiKey, parseResponse = parseGeminiPayload, responseSchema = null) {
  if (!apiKey) {
    return { ok: false, reason: "GEMINI_API_KEY missing" };
  }

  try {
    const resp = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: responseSchema
          ? { temperature: 0.1, responseFormat: { text: { mimeType: "APPLICATION_JSON", schema: responseSchema } } }
          : { responseMimeType: "application/json", temperature: 0.1 },
      }),
    });
    if (!resp.ok) {
      if (resp.status === 429) {
        await sendAlert("[SOOP] Gemini 무료 한도 초과", `Gemini API 429 에러\n시간: ${new Date().toISOString()}`);
      } else {
        await sendAlert("[SOOP] Gemini API 에러", `Gemini API ${resp.status} 에러\n시간: ${new Date().toISOString()}`);
      }
      const retryAfter = resp.headers.get("retry-after");
      let apiMessage = "";
      try {
        const errorBody = await resp.json();
        apiMessage = (errorBody.error?.message || "").split("\n")[0].slice(0, 240);
      } catch {}
      return {
        ok: false,
        reason: `Gemini ${GEMINI_MODEL} HTTP ${resp.status}${retryAfter ? ` (retry-after: ${retryAfter})` : ""}${apiMessage ? `: ${apiMessage}` : ""}`,
      };
    }
    const data = await resp.json();
    return { ok: true, value: parseResponse(data) };
  } catch (e) {
    await sendAlert("[SOOP] parse-hot 에러", `파싱 중 에러\n시간: ${new Date().toISOString()}\n에러: ${e.message}`);
    return { ok: false, reason: e.message };
  }
}

async function parseWithGemini(noticeText, images, today, apiKey) {
  const prompt = `SOOP BJ 공지에서 실제 방송 시작 시간만 추출해.
오늘: ${today}
인기BJ 목록: ${POPULAR_NAMES.join(', ')}
${noticeText}
공지 1개당 방송 시작 일정은 최대 1개만 반환하고 합방·연습·대회 시각보다 방송을 켜는 시각을 우선해.
시간 정보가 없거나 휴방·일상·홍보 글이면 빈 배열을 반환해.
JSON: [{"date":"YYYY-MM-DD","start_time":"HH:MM","description":"요약","mentioned_bjs":["이름"]}]`;
  const result = await requestGemini([{ text: prompt }, ...images], apiKey, parseGeminiPayload, SCHEDULE_ARRAY_SCHEMA);
  return result.ok
    ? { ok: true, schedules: result.value }
    : { ok: false, schedules: [], reason: result.reason };
}

async function parseBatchWithGemini(items, today, apiKey) {
  const expectedIds = new Set(items.map(item => String(item.notice.title_no)));
  const parts = [{ text: `SOOP BJ 공지 여러 개에서 각각의 실제 방송 시작 시간만 추출해.
오늘: ${today}
인기BJ 목록: ${POPULAR_NAMES.join(', ')}

규칙:
- 공지별로 독립 분석하고 반드시 입력 title_no를 그대로 반환
- 공지 1개당 실제 방송 시작 일정은 최대 1개
- 합방·연습·대회·콘텐츠 시작 시각보다 방송을 켜는 시각을 우선
- "방송 켭니다", "만나요", "오겠습니다", "뵙겠습니다" 같은 시청자 대상 방송 시작 표현을 우선
- "오늘"은 작성일, "내일"은 작성일 다음 날. 단 작성시간 00:00~05:59의 "내일"은 작성일 당일 낮
- 숫자만 있는 시각은 오후로 해석하되 오전·아침·새벽이 명시되면 AM
- 휴방·일상·홍보·경기결과·모집 글이나 시간 정보가 없는 글은 schedules: []
- 출력에는 모든 입력 title_no를 한 번씩 포함

JSON: [{"title_no":"입력값","schedules":[{"date":"YYYY-MM-DD","start_time":"HH:MM","description":"요약","mentioned_bjs":["이름"]}]}]` }];

  for (const item of items) {
    parts.push({ text: `[NOTICE title_no=${item.notice.title_no}]\n[작성일: ${item.noticeDate}] [작성시간: ${item.noticeTime} KST] [BJ: ${item.notice.bj_name}] [제목: ${item.notice.title_name}]\n${item.plainText.slice(0, GEMINI_NOTICE_TEXT_LIMIT)}` });
    parts.push(...item.imageParts);
    parts.push({ text: `[END NOTICE title_no=${item.notice.title_no}]` });
  }

  const result = await requestGemini(parts, apiKey, parseGeminiPayload, BATCH_RESPONSE_SCHEMA);
  if (!result.ok) return { ok: false, results: new Map(), reason: result.reason };

  try {
    const results = new Map();
    for (const row of result.value) {
      if (!row || typeof row !== "object") throw new Error("Invalid row in Gemini response");
      const id = String(row.title_no);
      if (!expectedIds.has(id)) throw new Error(`Unexpected title_no in Gemini response: ${id}`);
      if (results.has(id)) throw new Error(`Duplicate title_no in Gemini response: ${id}`);
      if (!Array.isArray(row.schedules)) throw new Error(`Missing schedules array for title_no: ${id}`);
      results.set(id, row.schedules);
    }
    return { ok: true, results };
  } catch (error) {
    return { ok: false, results: new Map(), reason: error.message };
  }
}

async function run() {
  const startTime = Date.now();
  try {
    const today = toKSTDateTime(new Date().toISOString()).date;

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

    // 조회수 3000+이면서 아직 파싱되지 않은 공지 (3일간)
    const notices = await select(
      `SELECT n.bj_id, n.bj_name, n.title_no, n.title_name, n.content_html, n.reg_date, n.read_cnt
       FROM notices n
       LEFT JOIN (
         SELECT DISTINCT title_no FROM schedules
         WHERE raw_text NOT LIKE '합방(%'
       ) s ON s.title_no = n.title_no
       WHERE n.reg_date >= ? AND n.read_cnt >= 3000 AND s.title_no IS NULL
       ORDER BY n.reg_date DESC LIMIT 300`,
      [threeDaysAgo]
    );

    const candidates = notices.filter(n => {
      const plainText = stripHtml(n.content_html);
      if (!`${n.title_name || ""} ${plainText}`.trim()) return false;
      return hasScheduleKeyword(n.title_name, plainText);
    });
    const toParse = candidates.slice(0, PARSE_BATCH_SIZE);

    let totalParsed = 0;
    let processed = 0;
    let deferred = 0;
    let failedReason = null;

    const prepared = toParse.map(notice => {
      const noticeDateTime = toKSTDateTime(notice.reg_date, today);
      return {
        notice,
        noticeDate: noticeDateTime.date,
        noticeTime: noticeDateTime.time,
        plainText: stripHtml(notice.content_html),
        imageUrls: extractImageUrls(notice.content_html),
        imageParts: [],
        imageIncluded: false,
        imageOmittedByCap: false,
      };
    });

    for (let batchStart = 0; batchStart < prepared.length; batchStart += GEMINI_BATCH_SIZE) {
      const batch = prepared.slice(batchStart, batchStart + GEMINI_BATCH_SIZE);
      const imageItems = batch.filter(item => item.imageUrls.length > 0);
      const images = await Promise.all(imageItems.map(item => fetchImageAsBase64(item.imageUrls[0])));
      let batchImageBytes = 0;
      let batchImageCount = 0;
      imageItems.forEach((item, index) => {
        const image = images[index];
        if (image && batchImageCount < GEMINI_BATCH_MAX_IMAGES && batchImageBytes + image.byteLength <= GEMINI_BATCH_MAX_IMAGE_BYTES) {
          item.imageParts = [image.part];
          item.imageIncluded = true;
          batchImageBytes += image.byteLength;
          batchImageCount++;
        } else if (image) {
          item.imageOmittedByCap = true;
        }
      });

      const result = await parseBatchWithGemini(batch, today, process.env.GEMINI_API_KEY);
      if (!result.ok) {
        failedReason = result.reason;
        console.error(`[parse-hot] API failure; batch paused without marking ${batch.length} notices: ${result.reason}`);
        break;
      }

      for (const item of batch) {
        const resultId = String(item.notice.title_no);
        if (!result.results.has(resultId)) {
          deferred++;
          continue;
        }

        const schedules = result.results.get(resultId);
        const validSchedules = selectBroadcastSchedules(schedules);
        if (validSchedules.length === 0 && item.imageOmittedByCap) {
          deferred++;
          continue;
        }

        processed++;
        if (validSchedules.length === 0) {
          await upsertSchedule({
            bj_id: item.notice.bj_id,
            bj_name: item.notice.bj_name,
            title_no: item.notice.title_no,
            broadcast_start: item.noticeDate + "T00:00:00+09:00",
            description: "",
            raw_text: "파싱결과없음",
            parsed_at: new Date().toISOString(),
          });
          continue;
        }

        for (const schedule of validSchedules) {
          const startStr = `${schedule.date}T${schedule.start_time}:00+09:00`;
          const endStr = schedule.end_time ? `${schedule.date}T${schedule.end_time}:00+09:00` : null;

          await upsertSchedule({
            bj_id: item.notice.bj_id,
            bj_name: item.notice.bj_name,
            title_no: item.notice.title_no,
            broadcast_start: startStr,
            broadcast_end: endStr,
            description: schedule.description || item.notice.title_name || "",
            raw_text: `${item.notice.title_name}: ${schedule.start_time}~${schedule.end_time || "?"}`,
            parsed_at: new Date().toISOString(),
          });
          totalParsed++;

          for (const bjName of (schedule.mentioned_bjs || [])) {
            const bjEntry = Object.entries(BJ_LIST).find(([, value]) => value.name === bjName);
            if (!bjEntry || bjEntry[0] === item.notice.bj_id) continue;

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
                description: `${item.notice.bj_name} 합방: ${schedule.description || ""}`,
                raw_text: `합방(${item.notice.bj_name}): ${schedule.start_time}~${schedule.end_time || "?"}`,
                parsed_at: new Date().toISOString(),
              });
              totalParsed++;
            } catch {}
          }
        }
      }

      if (batchStart + GEMINI_BATCH_SIZE < prepared.length) {
        await new Promise(resolve => setTimeout(resolve, GEMINI_REQUEST_INTERVAL_MS));
      }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const failure = failedReason ? `, paused=${failedReason}` : "";
    console.log(`[parse-hot] ${totalParsed} parsed, ${notices.length} checked, ${processed}/${candidates.length} processed, ${deferred} deferred${failure} (${elapsed}s)`);
  } catch (e) {
    console.error("[parse-hot] error:", e.message);
    await sendAlert("[SOOP] parse-hot 에러", `에러: ${e.message}\n시간: ${new Date().toISOString()}`);
  }
}

module.exports = run;
module.exports.parseBatchWithGemini = parseBatchWithGemini;
module.exports.parseWithGemini = parseWithGemini;
module.exports.parseGeminiPayload = parseGeminiPayload;
module.exports.selectBroadcastSchedules = selectBroadcastSchedules;
module.exports.toKSTDateTime = toKSTDateTime;
