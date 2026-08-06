"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const html = fs.readFileSync(path.resolve(__dirname, "../../public/index.html"), "utf8");

function functionSource(name, nextName) {
  const start = html.indexOf(`function ${name}(`);
  const end = nextName ? html.indexOf(`function ${nextName}(`, start + 1) : -1;
  assert.notEqual(start, -1, `${name} 함수가 있어야 합니다.`);
  return html.slice(start, end === -1 ? undefined : end);
}

test("공지 목록은 본문을 렌더링하거나 검색하지 않는다", () => {
  const card = functionSource("buildCardHtml", "getFilteredNotices");
  const filter = functionSource("getFilteredNotices", "packIntoPages");
  const loadAll = functionSource("loadAll", "setupAutoRefresh");

  assert.doesNotMatch(card, /content_html|contentHtml|card-body|더보기/);
  assert.doesNotMatch(filter, /content_html|contentHtml/);
  assert.doesNotMatch(loadAll, /sanitizeHtml|content_html|optimizeImages/);
  assert.match(html, /placeholder="검색 \(제목, 스트리머\)"/);
});

test("본문은 상세 요청 함수로만 제한적으로 가져온다", () => {
  const fetchContent = functionSource("fetchNoticeContent", "neutralizeEmoticonLinks");
  const openDetail = functionSource("openDetail", "closeDetail");

  assert.match(html, /const NOTICE_CONTENT_CACHE_LIMIT = 32/);
  assert.match(fetchContent, /\/api\/notice-content\?title_no=/);
  assert.match(fetchContent, /noticeContentPending/);
  assert.match(openDetail, /await fetchNoticeContent\(titleNo\)/);
  assert.match(openDetail, /detailRequestToken/);
  assert.doesNotMatch(html, /copyForFmkorea|detailCopyBtn|펨코 복사/);
});

test("캘린더는 전 슬롯 본문을 일괄 호출하지 않고 화면 진입 항목만 지연 로드한다", () => {
  assert.match(html, /function setupCalendarBodyLoading\(initialIndex\)/);
  assert.match(html, /new IntersectionObserver/);
  assert.match(html, /rootMargin: '180px 0px'/);
  assert.doesNotMatch(html, /data\.slots\.forEach\(\(s, i\) => loadNoticeBody/);
  assert.match(html, /if \(body\) loadNoticeBody\(body\.dataset\.titleNo, index\)/);
});

test("비공식 고지는 모바일 포함 상시 노출되고 불필요한 추적·이미지 프록시가 없다", () => {
  assert.match(html, /class="unofficial-strip" role="note"/);
  assert.match(html, /SOOP 공식 서비스나 공식 제휴 서비스가 아닙니다/);
  assert.doesNotMatch(html, /googletagmanager\.com|gtag\(|wsrv\.nl/);
  assert.match(html, /static\.cloudflareinsights\.com\/beacon\.min\.js/);
});
