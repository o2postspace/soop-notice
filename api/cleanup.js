const { supabase } = require("../lib/supabase");
const { BJ_LIST } = require("../lib/bj-list");

module.exports = async function handler(req, res) {
  const validIds = new Set(Object.keys(BJ_LIST));

  // DB에서 모든 bj_id 조회
  const { data: rows, error: fetchErr } = await supabase
    .from("notices")
    .select("bj_id");

  if (fetchErr) {
    return res.status(500).json({ error: fetchErr.message });
  }

  // 목록에 없는 bj_id 추출
  const invalidIds = [...new Set(rows.map(r => r.bj_id))].filter(id => !validIds.has(id));

  if (invalidIds.length === 0) {
    return res.status(200).json({ ok: true, deleted: 0, message: "정리할 데이터 없음" });
  }

  // 삭제
  const { error: delErr } = await supabase
    .from("notices")
    .delete()
    .in("bj_id", invalidIds);

  if (delErr) {
    return res.status(500).json({ error: delErr.message });
  }

  res.status(200).json({ ok: true, deleted_bj_ids: invalidIds, count: invalidIds.length });
};
