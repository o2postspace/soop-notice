const { supabase } = require("../lib/supabase");
const { BJ_LIST } = require("../lib/bj-list");

module.exports = async function handler(req, res) {
  const validIds = Object.keys(BJ_LIST);

  // 목록에 없는 BJ의 공지 삭제
  const { data, error } = await supabase
    .from("notices")
    .delete()
    .not("bj_id", "in", "(" + validIds.join(",") + ")");

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  res.status(200).json({ ok: true, deleted: data ? data.length : "done" });
};
