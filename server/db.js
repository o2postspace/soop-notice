const mysql = require("mysql2/promise");

const pool = mysql.createPool({
  host: process.env.DB_HOST || "localhost",
  user: process.env.DB_USER || "soop_notice",
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME || "soop_notice",
  waitForConnections: true,
  connectionLimit: 20,
  charset: "utf8mb4",
  timezone: "+00:00",
  dateStrings: true, // DATETIME을 문자열로 반환 (Date 객체 변환 방지)
});

// ISO 8601 → MySQL DATETIME ('2026-04-08T13:00:00+09:00' → '2026-04-08 04:00:00')
function toMySQLDate(isoStr) {
  if (!isoStr) return null;
  const d = new Date(isoStr);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 19).replace("T", " ");
}

// MySQL DATETIME → ISO 8601 ('2026-04-08 04:00:00' → '2026-04-08T04:00:00.000Z')
function toISO(mysqlStr) {
  if (!mysqlStr) return null;
  return mysqlStr.replace(" ", "T") + ".000Z";
}

// 결과 행의 DATETIME 컬럼을 ISO로 변환
const DATE_COLUMNS = ["reg_date", "updated_at", "broadcast_start", "broadcast_end", "parsed_at", "created_at"];
function convertDates(row) {
  if (!row) return row;
  for (const col of DATE_COLUMNS) {
    if (row[col]) row[col] = toISO(row[col]);
  }
  if (row.is_pin !== undefined) row.is_pin = !!row.is_pin;
  return row;
}

function convertRows(rows) {
  return (rows || []).map(convertDates);
}

// IN 절 플레이스홀더 생성
function inPlaceholders(arr) {
  return arr.map(() => "?").join(",");
}

// 기본 쿼리
async function query(sql, params = []) {
  const [rows] = await pool.execute(sql, params);
  return rows;
}

// SELECT 쿼리 (결과에 날짜 변환 적용)
async function select(sql, params = []) {
  const rows = await query(sql, params);
  return convertRows(rows);
}

// notices 테이블 upsert (새 공지: content_html 포함, 기존: 메타만)
async function upsertNotices(rows) {
  if (rows.length === 0) return;

  const newRows = rows.filter(r => r.content_html !== undefined);
  const existingRows = rows.filter(r => r.content_html === undefined);

  if (newRows.length > 0) {
    const sql = `INSERT INTO notices (bj_id, bj_name, bj_tag, title_no, title_name, content_html, reg_date, read_cnt, is_pin, updated_at)
      VALUES ? ON DUPLICATE KEY UPDATE
      bj_name=VALUES(bj_name), bj_tag=VALUES(bj_tag), title_name=VALUES(title_name),
      content_html=VALUES(content_html), reg_date=VALUES(reg_date), read_cnt=VALUES(read_cnt),
      is_pin=VALUES(is_pin), updated_at=VALUES(updated_at)`;
    const values = newRows.map(r => [
      r.bj_id, r.bj_name, r.bj_tag || "", r.title_no, r.title_name || "",
      r.content_html || "", toMySQLDate(r.reg_date), r.read_cnt || 0,
      r.is_pin ? 1 : 0, toMySQLDate(r.updated_at),
    ]);
    await pool.query(sql, [values]);
  }

  if (existingRows.length > 0) {
    const sql = `INSERT INTO notices (bj_id, bj_name, bj_tag, title_no, title_name, reg_date, read_cnt, is_pin, updated_at)
      VALUES ? ON DUPLICATE KEY UPDATE
      bj_name=VALUES(bj_name), bj_tag=VALUES(bj_tag), title_name=VALUES(title_name),
      reg_date=VALUES(reg_date), read_cnt=VALUES(read_cnt),
      is_pin=VALUES(is_pin), updated_at=VALUES(updated_at)`;
    const values = existingRows.map(r => [
      r.bj_id, r.bj_name, r.bj_tag || "", r.title_no, r.title_name || "",
      toMySQLDate(r.reg_date), r.read_cnt || 0, r.is_pin ? 1 : 0,
      toMySQLDate(r.updated_at),
    ]);
    await pool.query(sql, [values]);
  }
}

// schedules 테이블 upsert
async function upsertSchedule(row) {
  const sql = `INSERT INTO schedules (bj_id, bj_name, title_no, broadcast_start, broadcast_end, description, raw_text, parsed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
    bj_name=VALUES(bj_name), broadcast_end=VALUES(broadcast_end),
    description=VALUES(description), raw_text=VALUES(raw_text), parsed_at=VALUES(parsed_at)`;
  await pool.execute(sql, [
    row.bj_id, row.bj_name, row.title_no,
    toMySQLDate(row.broadcast_start), toMySQLDate(row.broadcast_end),
    row.description || "", row.raw_text || "", toMySQLDate(row.parsed_at),
  ]);
}

module.exports = {
  pool,
  query,
  select,
  toMySQLDate,
  toISO,
  inPlaceholders,
  upsertNotices,
  upsertSchedule,
};
