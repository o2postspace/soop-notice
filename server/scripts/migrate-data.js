/**
 * Supabase → MySQL 데이터 마이그레이션
 * 사용법: cd server && npm run migrate
 */
require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
const mysql = require("mysql2/promise");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("SUPABASE_URL, SUPABASE_ANON_KEY 환경변수 필요 (.env에 추가)");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

function toMySQLDate(isoStr) {
  if (!isoStr) return null;
  const d = new Date(isoStr);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 19).replace("T", " ");
}

async function migrateTable(pool, tableName, fetchFn, insertFn) {
  console.log(`\n--- ${tableName} 마이그레이션 시작 ---`);
  let total = 0;
  let offset = 0;
  const BATCH = 1000;

  while (true) {
    const { data, error } = await fetchFn(offset, offset + BATCH - 1);
    if (error) { console.error(`  Supabase 에러:`, error.message); break; }
    if (!data || data.length === 0) break;

    await insertFn(pool, data);
    total += data.length;
    console.log(`  ${total}건 이관 완료...`);

    if (data.length < BATCH) break;
    offset += BATCH;
  }

  // 검증
  const [rows] = await pool.execute(`SELECT COUNT(*) as cnt FROM ${tableName}`);
  console.log(`--- ${tableName} 완료: Supabase ${total}건, MySQL ${rows[0].cnt}건 ---`);
}

async function main() {
  const pool = await mysql.createPool({
    host: process.env.DB_HOST || "localhost",
    user: process.env.DB_USER || "soop_notice",
    password: process.env.DB_PASSWORD || "",
    database: process.env.DB_NAME || "soop_notice",
    charset: "utf8mb4",
    timezone: "+00:00",
    connectionLimit: 5,
  });

  // notices
  await migrateTable(pool, "notices",
    (from, to) => supabase.from("notices").select("*").range(from, to).order("id", { ascending: true }),
    async (p, rows) => {
      if (rows.length === 0) return;
      const sql = `INSERT IGNORE INTO notices (bj_id, bj_name, bj_tag, title_no, title_name, content_html, reg_date, read_cnt, is_pin, updated_at)
        VALUES ?`;
      const values = rows.map(r => [
        r.bj_id, r.bj_name, r.bj_tag || "", r.title_no, r.title_name || "",
        r.content_html || "", toMySQLDate(r.reg_date), r.read_cnt || 0,
        r.is_pin ? 1 : 0, toMySQLDate(r.updated_at),
      ]);
      await p.query(sql, [values]);
    }
  );

  // schedules
  await migrateTable(pool, "schedules",
    (from, to) => supabase.from("schedules").select("*").range(from, to).order("id", { ascending: true }),
    async (p, rows) => {
      if (rows.length === 0) return;
      const sql = `INSERT IGNORE INTO schedules (bj_id, bj_name, title_no, broadcast_start, broadcast_end, description, raw_text, parsed_at)
        VALUES ?`;
      const values = rows.map(r => [
        r.bj_id, r.bj_name, r.title_no,
        toMySQLDate(r.broadcast_start), toMySQLDate(r.broadcast_end),
        r.description || "", r.raw_text || "", toMySQLDate(r.parsed_at),
      ]);
      await p.query(sql, [values]);
    }
  );

  // updates
  await migrateTable(pool, "updates",
    (from, to) => supabase.from("updates").select("*").range(from, to).order("id", { ascending: true }),
    async (p, rows) => {
      if (rows.length === 0) return;
      const sql = `INSERT IGNORE INTO updates (title, content, category, created_at) VALUES ?`;
      const values = rows.map(r => [r.title, r.content, r.category || "업데이트", toMySQLDate(r.created_at)]);
      await p.query(sql, [values]);
    }
  );

  // feedback
  await migrateTable(pool, "feedback",
    (from, to) => supabase.from("feedback").select("*").range(from, to).order("id", { ascending: true }),
    async (p, rows) => {
      if (rows.length === 0) return;
      const sql = `INSERT IGNORE INTO feedback (subject, body, created_at) VALUES ?`;
      const values = rows.map(r => [r.subject, r.body, toMySQLDate(r.created_at)]);
      await p.query(sql, [values]);
    }
  );

  console.log("\n=== 마이그레이션 완료 ===");
  await pool.end();
  process.exit(0);
}

main().catch(e => { console.error("마이그레이션 실패:", e); process.exit(1); });
