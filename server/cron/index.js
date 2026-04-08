const cron = require("node-cron");
const fetchNotices = require("./fetch-notices");
const parseHot = require("./parse-hot");

function start() {
  // 인기 BJ: 5분마다
  cron.schedule("*/5 * * * *", () => fetchNotices("popular"));

  // 나머지 BJ: 30분마다
  cron.schedule("*/30 * * * *", () => fetchNotices("rest"));

  // Gemini 파싱: 5분마다
  cron.schedule("*/5 * * * *", () => parseHot());

  console.log("[cron] scheduled: fetch-notices(popular/5m, rest/30m), parse-hot(5m)");
}

module.exports = { start };
