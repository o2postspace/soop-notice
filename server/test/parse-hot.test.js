const { after, test } = require("node:test");
const assert = require("node:assert/strict");
const parseHot = require("../cron/parse-hot");
const { pool } = require("../db");

after(() => pool.end());

test("UTC 공지 시간을 KST 날짜와 시간으로 변환한다", () => {
  assert.deepEqual(
    parseHot.toKSTDateTime("2026-07-21T15:30:00.000Z"),
    { date: "2026-07-22", time: "00:30" }
  );
});

test("Gemini의 정상 빈 배열은 유효한 파싱 결과다", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ candidates: [{ content: { parts: [{ text: "[]" }] } }] }),
  });

  try {
    const result = await parseHot.parseWithGemini("공지", [], "2026-07-22", "test-key");
    assert.deepEqual(result, { ok: true, schedules: [] });
  } finally {
    global.fetch = originalFetch;
  }
});

test("Gemini HTTP 오류를 정상 빈 배열과 구분한다", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: false,
    status: 429,
    headers: { get: () => "60" },
  });

  try {
    const result = await parseHot.parseWithGemini("공지", [], "2026-07-22", "test-key");
    assert.equal(result.ok, false);
    assert.equal(result.schedules.length, 0);
    assert.match(result.reason, /HTTP 429/);
  } finally {
    global.fetch = originalFetch;
  }
});

test("Gemini 응답이 배열이 아니면 파싱 오류로 처리한다", () => {
  assert.throws(
    () => parseHot.parseGeminiPayload({ candidates: [{ content: { parts: [{ text: "{}" }] } }] }),
    /not an array/
  );
});

test("배치 응답을 title_no별 일정으로 매핑한다", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({
      candidates: [{ content: { parts: [{ text: JSON.stringify([
        { title_no: "101", schedules: [{ date: "2026-07-22", start_time: "20:00" }] },
        { title_no: "102", schedules: [] },
      ]) }] } }],
    }),
  });
  const items = [101, 102].map(titleNo => ({
    notice: { title_no: titleNo, bj_name: "BJ", title_name: "공지" },
    noticeDate: "2026-07-22",
    noticeTime: "12:00",
    plainText: "오늘 방송 공지",
    imageParts: [],
  }));

  try {
    const result = await parseHot.parseBatchWithGemini(items, "2026-07-22", "test-key");
    assert.equal(result.ok, true);
    assert.equal(result.results.get("101")[0].start_time, "20:00");
    assert.deepEqual(result.results.get("102"), []);
  } finally {
    global.fetch = originalFetch;
  }
});

test("공지 하나에서 실제 방송 시작 일정 하나만 사용한다", () => {
  const schedules = parseHot.selectBroadcastSchedules([
    { date: "2026-07-22", start_time: "20:30", description: "방송 시작" },
    { date: "2026-07-22", start_time: "21:30", description: "합방 시작" },
  ]);

  assert.deepEqual(schedules, [
    { date: "2026-07-22", start_time: "20:30", description: "방송 시작" },
  ]);
});

test("형식이 잘못된 일정 원소는 저장 대상에서 제외한다", () => {
  const schedules = parseHot.selectBroadcastSchedules([
    null,
    { date: "2026-07-22", start_time: "25:00" },
    { date: "not-a-date", start_time: "20:00" },
  ]);
  assert.deepEqual(schedules, []);
});
