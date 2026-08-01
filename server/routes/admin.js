const { Router } = require("express");
const { query, select, toMySQLDate } = require("../db");
const { requireAdmin } = require("../middleware/admin-auth");

const router = Router();
router.use(requireAdmin);
router.use((req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

function positiveId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function handleError(res, error) {
  console.error("admin route error", error);
  return res.status(500).json({ error: "서버 오류가 발생했습니다" });
}

router.get("/schedules", async (req, res) => {
  try {
    const threeDaysAgo = toMySQLDate(new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString());
    const data = await select(
      "SELECT * FROM schedules WHERE broadcast_start >= ? ORDER BY broadcast_start DESC LIMIT 100",
      [threeDaysAgo],
    );
    return res.json(data);
  } catch (error) {
    return handleError(res, error);
  }
});

router.post("/schedules", async (req, res) => {
  const { bj_name: bjName, broadcast_start: broadcastStart, description = "" } = req.body || {};
  if (!bjName || !broadcastStart) return res.status(400).json({ error: "bj_name, broadcast_start required" });
  const parsedStart = toMySQLDate(broadcastStart);
  if (!parsedStart) return res.status(400).json({ error: "invalid broadcast_start" });
  try {
    await query(
      `INSERT INTO schedules
        (bj_id, bj_name, title_no, broadcast_start, description, raw_text, parsed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ["manual", String(bjName).slice(0, 128), Date.now(), parsedStart, String(description).slice(0, 5000), "수동 추가", toMySQLDate(new Date().toISOString())],
    );
    return res.status(201).json({ ok: true });
  } catch (error) {
    return handleError(res, error);
  }
});

router.patch("/schedules/:id", async (req, res) => {
  const id = positiveId(req.params.id);
  if (!id) return res.status(400).json({ error: "invalid id" });
  const sets = [];
  const params = [];
  if (req.body?.broadcast_start) {
    const parsedStart = toMySQLDate(req.body.broadcast_start);
    if (!parsedStart) return res.status(400).json({ error: "invalid broadcast_start" });
    sets.push("broadcast_start = ?");
    params.push(parsedStart);
  }
  if (req.body?.description !== undefined) {
    sets.push("description = ?");
    params.push(String(req.body.description).slice(0, 5000));
  }
  if (req.body?.bj_name) {
    sets.push("bj_name = ?");
    params.push(String(req.body.bj_name).slice(0, 128));
  }
  if (!sets.length) return res.status(400).json({ error: "nothing to update" });
  try {
    params.push(id);
    await query(`UPDATE schedules SET ${sets.join(", ")} WHERE id = ?`, params);
    return res.json({ ok: true });
  } catch (error) {
    return handleError(res, error);
  }
});

router.delete("/schedules/:id", async (req, res) => {
  const id = positiveId(req.params.id);
  if (!id) return res.status(400).json({ error: "invalid id" });
  try {
    await query("DELETE FROM schedules WHERE id = ?", [id]);
    return res.json({ ok: true });
  } catch (error) {
    return handleError(res, error);
  }
});

router.get("/updates", async (req, res) => {
  try {
    return res.json(await select("SELECT * FROM updates ORDER BY created_at DESC LIMIT 50"));
  } catch (error) {
    return handleError(res, error);
  }
});

router.post("/updates", async (req, res) => {
  const { title, content, category = "업데이트" } = req.body || {};
  if (!title || !content) return res.status(400).json({ error: "title, content required" });
  try {
    await query(
      "INSERT INTO updates (title, content, category) VALUES (?, ?, ?)",
      [String(title).slice(0, 512), String(content).slice(0, 20_000), String(category).slice(0, 64)],
    );
    return res.status(201).json({ ok: true });
  } catch (error) {
    return handleError(res, error);
  }
});

router.delete("/updates/:id", async (req, res) => {
  const id = positiveId(req.params.id);
  if (!id) return res.status(400).json({ error: "invalid id" });
  try {
    await query("DELETE FROM updates WHERE id = ?", [id]);
    return res.json({ ok: true });
  } catch (error) {
    return handleError(res, error);
  }
});

router.delete("/notices/:titleNo", async (req, res) => {
  const titleNo = positiveId(req.params.titleNo);
  if (!titleNo) return res.status(400).json({ error: "invalid title_no" });
  try {
    await query("DELETE FROM notices WHERE title_no = ?", [titleNo]);
    return res.json({ ok: true });
  } catch (error) {
    return handleError(res, error);
  }
});

module.exports = router;
