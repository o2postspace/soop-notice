const { Router } = require("express");
const { CREW_LIST } = require("../lib/crew-list");
const { getCrewWithSheet } = require("../lib/fetch-sheet");

const router = Router();

router.get("/", async (req, res) => {
  try {
    const data = await getCrewWithSheet(CREW_LIST);
    res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=120");
    res.json(data);
  } catch (e) {
    console.error("Sheet fetch error:", e.message);
    res.json(CREW_LIST);
  }
});

module.exports = router;
