require("dotenv").config({ path: ".env.local" });
const express = require("express");
const app = express();

app.use(express.static("public"));

// API 라우트를 Vercel 핸들러와 연결
const apiFiles = ["notices", "cleanup", "notice-content", "schedules"];
apiFiles.forEach((name) => {
  const handler = require(`./api/${name}`);
  app.all(`/api/${name}`, (req, res) => handler(req, res));
});

// cron
const fetchNotices = require("./api/cron/fetch-notices");
app.all("/api/cron/fetch-notices", (req, res) => fetchNotices(req, res));

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Local server running at http://localhost:${PORT}`);
});
