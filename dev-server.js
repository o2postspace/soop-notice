/**
 * Vercel 없이 로컬 테스트용 서버
 * 사용법: node dev-server.js
 */
require("dotenv").config({ path: ".env.local" });
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;

// API 핸들러 로드
const noticesHandler = require("./api/notices");
const noticeContentHandler = require("./api/notice-content");
const cronHandler = require("./api/cron/fetch-notices");
const parseSchedulesHandler = require("./api/cron/parse-schedules");
const parseCollabsHandler = require("./api/cron/parse-collabs");
const schedulesHandler = require("./api/schedules");

function mockRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    json(data) { this.body = JSON.stringify(data); return this; },
  };
  return res;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // API 라우팅
  if (url.pathname === "/api/notices") {
    const mockR = mockRes();
    const mockReq = { query: Object.fromEntries(url.searchParams), headers: req.headers };
    await noticesHandler(mockReq, mockR);
    res.writeHead(mockR.statusCode, { "Content-Type": "application/json; charset=utf-8" });
    res.end(mockR.body);
    return;
  }

  if (url.pathname === "/api/notice-content") {
    const mockR = mockRes();
    const mockReq = { query: Object.fromEntries(url.searchParams), headers: req.headers };
    await noticeContentHandler(mockReq, mockR);
    res.writeHead(mockR.statusCode, { "Content-Type": "application/json; charset=utf-8" });
    res.end(mockR.body);
    return;
  }

  if (url.pathname === "/api/schedules") {
    const mockR = mockRes();
    const mockReq = { query: Object.fromEntries(url.searchParams), headers: req.headers };
    await schedulesHandler(mockReq, mockR);
    res.writeHead(mockR.statusCode, { "Content-Type": "application/json; charset=utf-8" });
    res.end(mockR.body);
    return;
  }

  if (url.pathname === "/api/cron/parse-schedules") {
    const mockR = mockRes();
    const mockReq = { query: Object.fromEntries(url.searchParams), headers: req.headers };
    await parseSchedulesHandler(mockReq, mockR);
    res.writeHead(mockR.statusCode, { "Content-Type": "application/json; charset=utf-8" });
    res.end(mockR.body);
    return;
  }

  if (url.pathname === "/api/cron/parse-collabs") {
    const mockR = mockRes();
    const mockReq = { query: Object.fromEntries(url.searchParams), headers: req.headers };
    await parseCollabsHandler(mockReq, mockR);
    res.writeHead(mockR.statusCode, { "Content-Type": "application/json; charset=utf-8" });
    res.end(mockR.body);
    return;
  }

  if (url.pathname === "/api/cron/fetch-notices") {
    const mockR = mockRes();
    const mockReq = { query: Object.fromEntries(url.searchParams), headers: req.headers };
    await cronHandler(mockReq, mockR);
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
