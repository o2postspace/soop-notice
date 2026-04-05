/**
 * Vercel 없이 로컬 테스트용 서버
 * 사용법: node dev-server.js
 */
require("dotenv").config({ path: ".env.local" });
const http = require("http");
const fs = require("fs");
const path = require("path");
const { supabase } = require("./lib/supabase");
const { BJ_LIST, POPULAR_BJ_IDS } = require("./lib/bj-list");

const PORT = process.env.PORT || 3000;

// Cron 핸들러 (남아있는 api/ 파일)
const cronHandler = require("./api/cron/fetch-notices");
const parseHotHandler = require("./api/cron/parse-hot");

function mockRes() {
  const res = {
    statusCode: 200, headers: {}, body: null,
    setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    json(data) { this.body = JSON.stringify(data); return this; },
  };
  return res;
}

function jsonResp(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

function getDayRange(dayOffset) {
  const now = new Date();
  const kstNow = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  if (kstNow.getUTCHours() < 6) kstNow.setUTCDate(kstNow.getUTCDate() - 1);
  const targetDay = new Date(kstNow);
  targetDay.setUTCDate(targetDay.getUTCDate() + dayOffset);
  targetDay.setUTCHours(6, 0, 0, 0);
  const dayEnd = new Date(targetDay);
  dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);
  dayEnd.setUTCHours(5, 59, 59, 999);
  return {
    targetDay,
    dayStartUTC: new Date(targetDay.getTime() - 9 * 60 * 60 * 1000).toISOString(),
    dayEndUTC: new Date(dayEnd.getTime() - 9 * 60 * 60 * 1000).toISOString(),
  };
}

function dayLabel(targetDay) {
  const dateStr = targetDay.toISOString().slice(0, 10);
  const dayNames = ['일','월','화','수','목','금','토'];
  return { date: dateStr, day_name: dayNames[targetDay.getUTCDay()] };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // --- /api/notices ---
  if (url.pathname === "/api/notices") {
    try {
      const validIds = Object.keys(BJ_LIST);
      const { data, error } = await supabase.from("notices").select("*").in("bj_id", validIds).order("reg_date", { ascending: false }).limit(1000);
      if (error) return jsonResp(res, 500, { error: error.message });
      return jsonResp(res, 200, data);
    } catch (e) { return jsonResp(res, 500, { error: e.message }); }
  }

  // --- /api/notice-content ---
  if (url.pathname === "/api/notice-content") {
    const titleNo = parseInt(url.searchParams.get("title_no"));
    if (!titleNo) return jsonResp(res, 400, { error: "title_no required" });
    try {
      const { data, error } = await supabase.from("notices").select("content_html").eq("title_no", titleNo).single();
      if (error) return jsonResp(res, 404, { error: "Not found" });
      return jsonResp(res, 200, { content_html: data.content_html });
    } catch (e) { return jsonResp(res, 500, { error: e.message }); }
  }

  // --- /api/schedules ---
  if (url.pathname === "/api/schedules") {
    try {
      const dayOffset = parseInt(url.searchParams.get("day_offset")) || 0;
      const { targetDay, dayStartUTC, dayEndUTC } = getDayRange(dayOffset);
      const { data, error } = await supabase.from("schedules").select("*").in("bj_id", POPULAR_BJ_IDS).gte("broadcast_start", dayStartUTC).lte("broadcast_start", dayEndUTC).neq("raw_text", "파싱결과없음").order("broadcast_start", { ascending: true });
      if (error) return jsonResp(res, 500, { error: error.message });

      const titleNos = data.map(r => r.title_no).filter(Boolean);
      let regDateMap = {};
      if (titleNos.length > 0) {
        const { data: notices } = await supabase.from("notices").select("title_no, reg_date").in("title_no", titleNos);
        if (notices) notices.forEach(n => { regDateMap[n.title_no] = n.reg_date; });
      }

      const seen = new Set();
      const slots = [];
      for (const row of data) {
        if (seen.has(row.title_no)) continue;
        seen.add(row.title_no);
        slots.push({ bj_id: row.bj_id, bj_name: BJ_LIST[row.bj_id]?.name || row.bj_name, start: row.broadcast_start, end: row.broadcast_end, title_no: row.title_no, description: row.description || row.raw_text, reg_date: regDateMap[row.title_no] || null });
      }

      return jsonResp(res, 200, { ...dayLabel(targetDay), slots });
    } catch (e) { return jsonResp(res, 500, { error: e.message }); }
  }

  // --- /api/hot-notices ---
  if (url.pathname === "/api/hot-notices") {
    try {
      const dayOffset = parseInt(url.searchParams.get("day_offset")) || 0;
      const { targetDay, dayStartUTC, dayEndUTC } = getDayRange(dayOffset);
      const { data: scheduleData } = await supabase.from("schedules").select("bj_id, bj_name, title_no, broadcast_start, description").gte("broadcast_start", dayStartUTC).lte("broadcast_start", dayEndUTC).neq("raw_text", "파싱결과없음").order("broadcast_start", { ascending: true });

      const titleNos = (scheduleData || []).map(s => s.title_no);
      let hotTitleNos = new Map();
      if (titleNos.length > 0) {
        const { data: noticeData } = await supabase.from("notices").select("title_no, read_cnt, title_name, reg_date").in("title_no", titleNos).gte("read_cnt", 1000);
        for (const n of (noticeData || [])) hotTitleNos.set(n.title_no, n);
      }

      const seen = new Set();
      const slots = [];
      for (const s of (scheduleData || [])) {
        if (!hotTitleNos.has(s.title_no)) continue;
        if (seen.has(s.title_no)) continue;
        seen.add(s.title_no);
        const notice = hotTitleNos.get(s.title_no);
        slots.push({ bj_id: s.bj_id, bj_name: s.bj_name, title_no: s.title_no, broadcast_start: s.broadcast_start, description: s.description, title_name: notice?.title_name || "", read_cnt: notice?.read_cnt || 0, reg_date: notice?.reg_date || null });
      }

      return jsonResp(res, 200, { ...dayLabel(targetDay), slots });
    } catch (e) { return jsonResp(res, 500, { error: e.message }); }
  }

  // --- /api/crew ---
  if (url.pathname === "/api/crew") {
    const { CREW_LIST } = require("./lib/crew-list");
    const { getCrewWithSheet } = require("./lib/fetch-sheet");
    try {
      const data = await getCrewWithSheet(CREW_LIST);
      return jsonResp(res, 200, data);
    } catch (e) {
      console.error("Sheet fetch error:", e.message);
      return jsonResp(res, 200, CREW_LIST);
    }
  }

  // --- /api/sheet ---
  if (url.pathname === "/api/sheet") {
    try {
      const resp = await fetch('https://docs.google.com/spreadsheets/d/1v3MgOlW6UGvoYMGbOvWTTrp6TQ5Z5VywIXBDZYQRKA0/gviz/tq?tqx=out:csv&gid=296314716');
      const text = await resp.text();
      res.writeHead(200, { "Content-Type": "text/csv; charset=utf-8" });
      res.end(text);
    } catch (e) { return jsonResp(res, 500, { error: e.message }); }
    return;
  }

  // --- /api/live-check ---
  if (url.pathname === "/api/live-check") {
    const bjIds = (url.searchParams.get("ids") || "").split(",").filter(Boolean).slice(0, 50);
    if (bjIds.length === 0) return jsonResp(res, 200, {});
    const results = {};
    const HEADERS = { Referer: "https://www.sooplive.co.kr/", "User-Agent": "Mozilla/5.0", Accept: "application/json" };
    for (let i = 0; i < bjIds.length; i += 10) {
      const batch = bjIds.slice(i, i + 10);
      await Promise.all(batch.map(async (bjId) => {
        try {
          const resp = await fetch(`https://chapi.sooplive.co.kr/api/${bjId}/station`, { headers: HEADERS });
          if (!resp.ok) { results[bjId] = false; return; }
          const data = await resp.json();
          results[bjId] = !!data.broad;
        } catch { results[bjId] = false; }
      }));
    }
    return jsonResp(res, 200, results);
  }

  // --- Cron 핸들러 ---
  if (url.pathname === "/api/cron/fetch-notices") {
    const mockR = mockRes();
    await cronHandler({ query: Object.fromEntries(url.searchParams), headers: req.headers }, mockR);
    res.writeHead(mockR.statusCode, { "Content-Type": "application/json; charset=utf-8" });
    res.end(mockR.body);
    return;
  }
  if (url.pathname === "/api/cron/parse-hot") {
    const mockR = mockRes();
    await parseHotHandler({ query: Object.fromEntries(url.searchParams), headers: req.headers }, mockR);
    res.writeHead(mockR.statusCode, { "Content-Type": "application/json; charset=utf-8" });
    res.end(mockR.body);
    return;
  }

  // 정적 파일 서빙
  let filePath = url.pathname === "/" ? "/index.html" : url.pathname;
  filePath = path.join(__dirname, "public", filePath);

  try {
    const content = fs.readFileSync(filePath);
    const ext = path.extname(filePath);
    const types = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".png": "image/png", ".jpg": "image/jpeg" };
    res.writeHead(200, { "Content-Type": (types[ext] || "text/plain") + "; charset=utf-8" });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end("Not Found");
  }
});

server.listen(PORT, () => {
  console.log(`\n  로컬 테스트 서버 실행 중!`);
  console.log(`  http://localhost:${PORT}\n`);
});
