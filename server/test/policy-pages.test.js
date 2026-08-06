"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const PUBLIC_DIRECTORY = path.resolve(__dirname, "../../public");

function readPage(name) {
  return fs.readFileSync(path.join(PUBLIC_DIRECTORY, name), "utf8");
}

test("정책·소개 페이지에서 광고 계정과 후원 모집 흔적을 노출하지 않는다", () => {
  const pages = ["about.html", "guide.html", "privacy.html", "terms.html"]
    .map(readPage);
  const combined = pages.join("\n");

  assert.doesNotMatch(combined, /google-adsense-account/i);
  assert.doesNotMatch(combined, /Google AdSense/i);
  assert.doesNotMatch(combined, /Google (?:Analytics|Tag Manager)/i);
  assert.doesNotMatch(combined, /wsrv\.nl/i);
  assert.doesNotMatch(readPage("about.html"), /광고와 운영 비용|직접 스폰서|운영비 후원/);
  assert.doesNotMatch(readPage("terms.html"), /향후[^<]*(?:광고|스폰서)/);
  assert.equal(fs.existsSync(path.join(PUBLIC_DIRECTORY, "ads.txt")), false);
});

test("개인정보처리방침이 공개 관측과 실제 외부 처리 흐름을 설명한다", () => {
  const privacy = readPage("privacy.html");

  for (const required of [
    "2026년 8월 7일",
    "공개된 SOOP 채널",
    "후국지 관측값·파생 순위",
    "임시 방송 화면",
    "최대 24시간",
    "음성은 저장하지 않습니다",
    "localStorage",
    "Google Gemini",
    "Google Sheets",
    "Cloudflare",
    "원본 이미지 호스트",
    "관측·랭킹 제외",
    "광고 목적으로 이용하거나 판매·제공하지 않습니다",
  ]) {
    assert.match(privacy, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), required);
  }
});

test("약관은 외부 링크 책임과 비공식 서비스 성격을 유지한다", () => {
  const terms = readPage("terms.html");

  assert.match(terms, /SOOP\(주\)의 공식 서비스가 아니며/);
  assert.match(terms, /공개 방송 관측 기반 후국지 현황/);
  assert.match(terms, /공식 순위 또는 참가자의 실력·평판에 대한 평가가 아니며/);
  assert.match(terms, /<h2>6\. 외부 링크<\/h2>/);
  assert.match(terms, /외부 페이지의 내용, 이용 조건, 개인정보 처리/);
});
