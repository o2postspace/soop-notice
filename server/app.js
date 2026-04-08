require("dotenv").config();
const express = require("express");
const cors = require("cors");
const cron = require("./cron");

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());

// API 라우트
app.use("/api/notices", require("./routes/notices"));
app.use("/api/notice-content", require("./routes/notice-content"));
app.use("/api/schedules", require("./routes/schedules"));
app.use("/api/hot-notices", require("./routes/hot-notices"));
app.use("/api/updates", require("./routes/updates"));
app.use("/api/feedback", require("./routes/feedback"));
app.use("/api/admin", require("./routes/admin"));
app.use("/api/live-check", require("./routes/live-check"));
app.use("/api/crew", require("./routes/crew"));
app.use("/webhook", require("./routes/webhook"));

// 크론 시작
cron.start();

app.listen(PORT, () => {
  console.log(`soop-notice server running on port ${PORT}`);
});
