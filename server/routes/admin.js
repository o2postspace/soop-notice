const { Router } = require("express");
const { query, select, toMySQLDate } = require("../db");

const router = Router();

router.get("/", async (req, res) => {
  const ADMIN_KEY = process.env.ADMIN_KEY || "qowlstnrytnsla";
  if (req.query.key !== ADMIN_KEY) return res.status(403).json({ error: "Forbidden" });

  const action = req.query.action;

  try {
    if (action === "delete-notice") {
      const titleNo = parseInt(req.query.title_no);
      if (!titleNo) return res.status(400).json({ error: "title_no required" });
      await query("DELETE FROM notices WHERE title_no = ?", [titleNo]);
      return res.json({ ok: true });
    }

    if (action === "delete-schedule") {
      const id = parseInt(req.query.id);
      if (!id) return res.status(400).json({ error: "id required" });
      await query("DELETE FROM schedules WHERE id = ?", [id]);
      return res.json({ ok: true });
    }

    if (action === "add-schedule") {
      const { bj_name, broadcast_start, description } = req.query;
      if (!bj_name || !broadcast_start) return res.status(400).json({ error: "bj_name, broadcast_start required" });
      await query(
        "INSERT INTO schedules (bj_id, bj_name, title_no, broadcast_start, description, raw_text, parsed_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ["manual", bj_name, Date.now(), toMySQLDate(broadcast_start), description || "", "수동 추가", toMySQLDate(new Date().toISOString())]
      );
      return res.json({ ok: true });
    }

    if (action === "edit-schedule") {
      const id = parseInt(req.query.id);
      if (!id) return res.status(400).json({ error: "id required" });
      const sets = [];
      const params = [];
      if (req.query.broadcast_start) { sets.push("broadcast_start = ?"); params.push(toMySQLDate(req.query.broadcast_start)); }
      if (req.query.description) { sets.push("description = ?"); params.push(req.query.description); }
      if (req.query.bj_name) { sets.push("bj_name = ?"); params.push(req.query.bj_name); }
      if (sets.length === 0) return res.status(400).json({ error: "nothing to update" });
      params.push(id);
      await query(`UPDATE schedules SET ${sets.join(", ")} WHERE id = ?`, params);
      return res.json({ ok: true });
    }

    if (action === "list-schedules") {
      const threeDaysAgo = toMySQLDate(new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString());
      const data = await select("SELECT * FROM schedules WHERE broadcast_start >= ? ORDER BY broadcast_start DESC LIMIT 100", [threeDaysAgo]);
      return res.json(data);
    }

    if (action === "list-updates") {
      const data = await select("SELECT * FROM updates ORDER BY created_at DESC LIMIT 50");
      return res.json(data);
    }

    if (action === "add-update") {
      const { title, content, category } = req.query;
      if (!title || !content) return res.status(400).json({ error: "title, content required" });
      await query("INSERT INTO updates (title, content, category) VALUES (?, ?, ?)", [title, content, category || "업데이트"]);
      return res.json({ ok: true });
    }

    if (action === "delete-update") {
      const id = parseInt(req.query.id);
      if (!id) return res.status(400).json({ error: "id required" });
      await query("DELETE FROM updates WHERE id = ?", [id]);
      return res.json({ ok: true });
    }

    res.status(400).json({ error: "Unknown action" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
