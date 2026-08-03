#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { calculateRosterPowerIndexes, POWER_INDEX_VERSION } = require("../lib/samguk-power-index");

const API_URL = "http://127.0.0.1:4000/api/samguk?refresh=1";
const DISPLAY_MULTIPLIER = 125;
const WIDTH = 1800;
const HEIGHT = 2400;
const NATIONS = Object.freeze({
  "위": { hanja: "魏", color: "#315f89", light: "#dceaf4" },
  "촉": { hanja: "蜀", color: "#397452", light: "#dcecdf" },
  "오": { hanja: "吳", color: "#a86f28", light: "#f2e3c2" },
});

function fail(message) {
  const error = new Error(message);
  error.code = "render_failed";
  throw error;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function displayNumber(value) {
  if (value === null || value === undefined || value === "") return "—";
  return Number.isFinite(Number(value)) ? Number(value).toLocaleString("ko-KR") : "—";
}

function displayLevel(value) {
  if (value === null || value === undefined || value === "") return "—";
  return Number.isFinite(Number(value)) ? `${Number(value)}강` : "—";
}

function kstTimestamp(now = new Date()) {
  const parts = new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}.${values.month}.${values.day} ${values.hour}:${values.minute} KST`;
}

function normalizeRanking(payload) {
  if (!payload || payload.source !== "google-sheet" || payload.stale === true
      || !Array.isArray(payload.members) || payload.members.length !== 90) {
    fail("최신 Google Sheet 90명 payload가 아니어서 이미지를 만들지 않습니다.");
  }
  const names = new Set(payload.members.map(member => String(member?.name || "").trim()));
  if (names.size !== 90 || [...names].some(name => !name)) {
    fail("참가자 이름이 누락되거나 중복되었습니다.");
  }
  for (const nation of Object.keys(NATIONS)) {
    if (payload.members.filter(member => member.nation === nation).length !== 30) {
      fail(`${nation}나라 참가자 수가 30명이 아닙니다.`);
    }
  }

  const recalculated = calculateRosterPowerIndexes(payload.members);
  const entries = payload.members.map((member, index) => {
    const power = recalculated[index];
    const apiLower = Number(member?.powerRange?.lower);
    const apiCoverage = Number(member?.powerCoverage);
    if (!Number.isFinite(apiLower) || Math.abs(apiLower - power.lower) > 1e-9
        || !Number.isFinite(apiCoverage) || Math.abs(apiCoverage - power.coverage) > 1e-9) {
      fail(`${member.name} 파워 계산값이 API와 일치하지 않습니다.`);
    }
    return {
      member,
      lower: power.lower,
      score: power.score,
      coverage: power.coverage,
      points: Math.round(power.lower * DISPLAY_MULTIPLIER),
    };
  }).sort((left, right) => (
    right.lower - left.lower
      || right.coverage - left.coverage
      || right.score - left.score
      || left.member.name.localeCompare(right.member.name, "ko")
  ));

  let previous = null;
  let sharedRank = 0;
  return entries.map((entry, index) => {
    if (entry.lower !== previous) sharedRank = index + 1;
    previous = entry.lower;
    return { ...entry, rank: sharedRank };
  });
}

function nationBadge(nation) {
  const meta = NATIONS[nation] || { hanja: nation || "?", color: "#69645b", light: "#eee9df" };
  return `<span class="nation" style="--nation:${meta.color};--nation-light:${meta.light}">${escapeHtml(meta.hanja)}</span>`;
}

function topCard(entry, place) {
  const member = entry.member;
  const medal = ["", "壹", "貳", "參"][place];
  return `<article class="top-card place-${place}">
    <div class="top-rank"><span>${medal}</span><small>RANK</small></div>
    <div class="top-main">
      <div class="top-meta">${nationBadge(member.nation)}<span>${escapeHtml(member.nation)}나라 · ${escapeHtml(member.job || "장수 미확인")}</span></div>
      <h2>${escapeHtml(member.name)}</h2>
      <div class="top-score"><b>${displayNumber(entry.points)}</b><span>POWER</span></div>
    </div>
    <div class="top-detail">
      <span>무 ${displayNumber(member.strength)}</span><span>민 ${displayNumber(member.agility)}</span>
      <span>력 ${displayNumber(member.vitality)}</span><span>모 ${displayNumber(member.intelligence)}</span>
      <i></i>
      <span>무기 ${displayLevel(member.weapon)}</span><span>흉갑 ${displayLevel(member.armor)}</span><span>각갑 ${displayLevel(member.shoes)}</span>
    </div>
  </article>`;
}

function rankingRow(entry) {
  const member = entry.member;
  return `<div class="rank-row">
    <span class="rank-no">${entry.rank}</span>
    ${nationBadge(member.nation)}
    <span class="person"><b>${escapeHtml(member.name)}</b><small>${escapeHtml(member.job || "장수 미확인")}</small></span>
    <span class="row-score"><b>${displayNumber(entry.points)}</b><small>PWR</small></span>
  </div>`;
}

function rankingColumn(entries, columnIndex) {
  const start = entries[0]?.rank ?? 0;
  const end = entries.at(-1)?.rank ?? 0;
  return `<section class="rank-column">
    <header><span>戰力序列 ${columnIndex + 1}</span><small>${start}–${end}위</small></header>
    ${entries.map(rankingRow).join("\n")}
  </section>`;
}

function buildHtml(ranking, renderedAt) {
  const top = ranking.slice(0, 3);
  const remainder = ranking.slice(3);
  const columns = [remainder.slice(0, 29), remainder.slice(29, 58), remainder.slice(58, 87)];
  const minPoints = ranking.at(-1).points;
  const maxPoints = ranking[0].points;
  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><style>
  *{box-sizing:border-box}html,body{margin:0;width:${WIDTH}px;height:${HEIGHT}px;overflow:hidden}
  body{font-family:"Noto Sans CJK KR","Noto Sans KR",sans-serif;color:#211b14;background:#100d09}
  .poster{position:relative;width:${WIDTH}px;height:${HEIGHT}px;padding:64px 70px 54px;overflow:hidden;
    background:
      radial-gradient(circle at 12% 8%,rgba(183,123,53,.22),transparent 25%),
      radial-gradient(circle at 88% 14%,rgba(105,31,22,.30),transparent 30%),
      linear-gradient(145deg,#18130d 0%,#2a1b11 55%,#130e0b 100%)}
  .poster:before{content:"三國志";position:absolute;right:-38px;top:450px;writing-mode:vertical-rl;
    font-family:"Noto Serif CJK KR",serif;font-weight:900;font-size:300px;letter-spacing:22px;color:rgba(232,202,140,.035)}
  .frame{position:absolute;inset:28px;border:1px solid rgba(213,170,89,.55);pointer-events:none}
  .frame:before,.frame:after{content:"";position:absolute;width:110px;height:110px;border-color:#b68a43;border-style:solid}
  .frame:before{left:12px;top:12px;border-width:3px 0 0 3px}.frame:after{right:12px;bottom:12px;border-width:0 3px 3px 0}
  .masthead{position:relative;height:200px;padding:0 4px;color:#f2e4c6;border-bottom:1px solid rgba(218,176,96,.5)}
  .eyebrow{display:flex;align-items:center;gap:18px;color:#d1a95e;font-size:21px;font-weight:800;letter-spacing:7px}
  .eyebrow:before{content:"";width:46px;height:2px;background:#bc8c45}.title-line{display:flex;align-items:flex-end;justify-content:space-between;margin-top:15px}
  h1{margin:0;font-family:"Noto Serif CJK KR",serif;font-size:78px;line-height:1;font-weight:900;letter-spacing:-3px}
  h1 em{font-style:normal;color:#d3a75a}.seal{display:flex;align-items:center;justify-content:center;width:92px;height:92px;
    border:3px double #c35542;color:#d86a55;font-family:"Noto Serif CJK KR",serif;font-size:24px;font-weight:900;line-height:1.2;text-align:center;transform:rotate(-3deg)}
  .subtitle{margin:18px 0 0;color:#bfb097;font-size:19px;letter-spacing:.2px}.subtitle b{color:#ead5ad}
  .asof{position:absolute;right:120px;bottom:24px;color:#9f927e;font-size:17px;font-variant-numeric:tabular-nums}
  .podium{position:relative;display:grid;grid-template-columns:repeat(3,1fr);gap:20px;height:298px;padding:22px 0 19px}
  .top-card{position:relative;display:grid;grid-template-columns:82px 1fr;grid-template-rows:1fr 68px;overflow:hidden;
    border:1px solid #806b48;background:#e4d3aa;box-shadow:0 9px 22px rgba(0,0,0,.25)}
  .top-card:after{content:"";position:absolute;right:-35px;top:-50px;width:170px;height:170px;border:25px solid rgba(85,52,23,.06);border-radius:50%}
  .place-1{border-color:#c79b47;background:#ecd9aa}.place-2{background:#ddd8ca}.place-3{background:#dfc4a7}
  .top-rank{grid-row:1/3;display:flex;flex-direction:column;align-items:center;justify-content:center;color:#f5e7c8;background:#291b11;border-right:1px solid #8e7046}
  .top-rank span{font-family:"Noto Serif CJK KR",serif;font-size:52px;font-weight:900;color:#d7ac5c}.top-rank small{font-size:10px;letter-spacing:3px;color:#8f7d62}
  .top-main{position:relative;padding:22px 22px 8px}.top-meta{display:flex;align-items:center;gap:9px;color:#615543;font-size:14px;font-weight:700}
  .nation{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;flex:0 0 30px;border:1px solid var(--nation);border-radius:50%;background:var(--nation-light);color:var(--nation);font-family:"Noto Serif CJK KR",serif;font-weight:900;font-size:16px}
  .top-main h2{margin:10px 0 0;font-family:"Noto Serif CJK KR",serif;font-size:39px;line-height:1.1;letter-spacing:-1px}.top-score{position:absolute;right:22px;bottom:12px;text-align:right}
  .top-score b{display:block;color:#762f24;font-size:47px;line-height:1;font-variant-numeric:tabular-nums}.top-score span{font-size:10px;font-weight:900;letter-spacing:4px;color:#817157}
  .top-detail{grid-column:2;display:flex;align-items:center;gap:10px;padding:10px 20px;border-top:1px solid rgba(73,55,32,.2);color:#594d3c;font-size:13px;font-weight:700;white-space:nowrap}
  .top-detail i{width:1px;height:23px;background:rgba(75,57,34,.25)}
  .board{position:relative;height:1600px;padding:20px 22px 18px;background:#e7d8b5;border:1px solid #a2804d;box-shadow:0 18px 50px rgba(0,0,0,.32)}
  .board:before{content:"";position:absolute;inset:7px;border:1px solid rgba(101,75,40,.3);pointer-events:none}
  .board-title{height:56px;display:flex;align-items:center;justify-content:space-between;padding:0 10px;border-bottom:2px solid #443522}
  .board-title h3{margin:0;font-family:"Noto Serif CJK KR",serif;font-size:28px;letter-spacing:2px}.board-title p{margin:0;color:#75664f;font-size:14px}
  .columns{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:22px;padding-top:15px}
  .rank-column{border-left:1px solid rgba(68,53,34,.22);border-right:1px solid rgba(68,53,34,.22)}
  .rank-column header{height:38px;display:flex;align-items:center;justify-content:space-between;padding:0 11px;color:#ead9b4;background:#31251a}
  .rank-column header span{font-family:"Noto Serif CJK KR",serif;font-size:14px;font-weight:800;letter-spacing:2px}.rank-column header small{color:#bfa77a;font-size:12px}
  .rank-row{display:grid;grid-template-columns:43px 30px minmax(0,1fr) 82px;align-items:center;gap:8px;height:49px;padding:0 10px;border-bottom:1px solid rgba(83,63,38,.17)}
  .rank-row:nth-child(odd){background:rgba(255,250,232,.30)}.rank-no{color:#6b5a43;font-family:"Noto Serif CJK KR",serif;font-size:17px;font-weight:900;text-align:center;font-variant-numeric:tabular-nums}
  .person{min-width:0;display:flex;align-items:baseline;gap:7px;white-space:nowrap}.person b{overflow:hidden;text-overflow:ellipsis;font-size:17px}.person small{overflow:hidden;text-overflow:ellipsis;color:#8a775b;font-size:11px}
  .row-score{text-align:right;font-variant-numeric:tabular-nums}.row-score b{display:block;color:#712f25;font-size:19px;line-height:1}.row-score small{color:#968267;font-size:8px;letter-spacing:2px}
  .footer{height:120px;display:grid;grid-template-columns:1fr auto;align-items:center;color:#b7a991;padding:16px 8px 0}
  .method{font-size:14px;line-height:1.65}.method b{color:#e0c38e}.method strong{color:#d67461;font-weight:800}.brand{text-align:right}
  .brand b{display:block;color:#e7c783;font-family:"Noto Serif CJK KR",serif;font-size:34px;letter-spacing:4px}.brand span{display:block;margin-top:2px;color:#8e8170;font-size:11px;letter-spacing:3px}
</style></head><body><main class="poster"><div class="frame"></div>
  <header class="masthead"><div class="eyebrow">2026 SOOP 삼국지 서버</div><div class="title-line"><h1>삼국지 <em>파워 랭킹</em></h1><div class="seal">戰力<br>榜</div></div>
    <p class="subtitle"><b>90인 전체 순위</b> · 공개 시트와 방송 OCR 관측값을 반영한 파워 ${escapeHtml(POWER_INDEX_VERSION)}</p><span class="asof">${escapeHtml(renderedAt)}</span></header>
  <section class="podium">${top.map((entry, index) => topCard(entry, index + 1)).join("\n")}</section>
  <section class="board"><div class="board-title"><h3>全軍 戰力序列</h3><p>총 90명 · 표시점수 ${displayNumber(maxPoints)}–${displayNumber(minPoints)} PWR</p></div>
    <div class="columns">${columns.map(rankingColumn).join("\n")}</div></section>
  <footer class="footer"><div class="method"><b>POWER ${escapeHtml(POWER_INDEX_VERSION)} · 표시단위 ×${DISPLAY_MULTIPLIER}</b>　레벨·기량 30% · 장비 35%(무기 60%) · 각인 20% · 말 15%(5등급+강화)<br>
    <strong>현재 전원 관측 기반 추정치</strong> · 미관측 요소는 임의 보정하지 않고 확인된 하한값으로 정렬 · 팬메이드 비공식 집계</div>
    <div class="brand"><b>SOOPNOTICE.COM</b><span>DATA · TRACKING · ARCHIVE</span></div></footer>
</main></body></html>`;
}

function chromiumPath() {
  const configured = String(process.env.CHROMIUM_PATH || "").trim();
  const candidates = [configured, "/usr/bin/google-chrome", "/snap/bin/chromium"].filter(Boolean);
  const found = candidates.find(candidate => path.isAbsolute(candidate) && fs.existsSync(candidate));
  if (!found) fail("Chrome/Chromium 실행 파일을 찾지 못했습니다.");
  return found;
}

async function main() {
  const outputPath = path.resolve(process.argv[2] || path.join(
    os.homedir(), "exports", `samguk-power-ranking-${new Date().toISOString().slice(0, 10)}.png`,
  ));
  if (path.extname(outputPath).toLowerCase() !== ".png") fail("출력 파일은 PNG여야 합니다.");
  const response = await fetch(API_URL, { headers: { accept: "application/json" } });
  if (!response.ok) fail(`삼국지 API 조회 실패: HTTP ${response.status}`);
  const payload = await response.json();
  const ranking = normalizeRanking(payload);
  const html = buildHtml(ranking, kstTimestamp());
  fs.mkdirSync(path.dirname(outputPath), { recursive: true, mode: 0o700 });
  const htmlPath = outputPath.replace(/\.png$/i, ".html");
  fs.writeFileSync(htmlPath, html, { encoding: "utf8", mode: 0o600 });

  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "soop-power-render-"));
  try {
    const result = spawnSync(chromiumPath(), [
      "--headless=new",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--hide-scrollbars",
      "--force-device-scale-factor=1",
      `--window-size=${WIDTH},${HEIGHT}`,
      `--user-data-dir=${profileDir}`,
      "--virtual-time-budget=1000",
      `--screenshot=${outputPath}`,
      `file://${htmlPath}`,
    ], { encoding: "utf8", timeout: 45_000 });
    if (result.status !== 0 || !fs.existsSync(outputPath)) {
      fail(`이미지 렌더링 실패: ${String(result.stderr || "").slice(0, 500)}`);
    }
  } finally {
    fs.rmSync(profileDir, { recursive: true, force: true });
  }
  fs.chmodSync(outputPath, 0o600);
  const stat = fs.statSync(outputPath);
  process.stdout.write(`${JSON.stringify({ outputPath, htmlPath, bytes: stat.size, count: ranking.length })}\n`);
}

main().catch((error) => {
  process.stderr.write(`[samguk-power-ranking] ${error?.code || "failed"}: ${error?.message || "failed"}\n`);
  process.exitCode = 1;
});
