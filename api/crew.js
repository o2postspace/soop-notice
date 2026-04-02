const { CREW_LIST } = require("../lib/crew-list");
const { getCrewWithSheet } = require("../lib/fetch-sheet");

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=120");
  try {
    const data = await getCrewWithSheet(CREW_LIST);
    res.status(200).json(data);
  } catch (e) {
    // 시트 실패 시 정적 데이터 반환
    res.status(200).json(CREW_LIST);
  }
};
