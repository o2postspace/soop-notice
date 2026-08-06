const { Router } = require("express");
const { select, inPlaceholders } = require("../db");
const { BJ_LIST } = require("../lib/bj-list");
const {
  createEncodedJsonCache,
  sendEncodedJson,
} = require("../lib/encoded-json-cache");

const NOTICE_METADATA_COLUMNS = Object.freeze([
  "id",
  "bj_id",
  "bj_name",
  "bj_tag",
  "title_no",
  "title_name",
  "reg_date",
  "read_cnt",
  "is_pin",
  "updated_at",
]);

function pickNoticeMetadata(row) {
  return Object.fromEntries(
    NOTICE_METADATA_COLUMNS
      .filter(column => Object.prototype.hasOwnProperty.call(row || {}, column))
      .map(column => [column, row[column]])
  );
}

function createRouter({
  selectFn = select,
  bjList = BJ_LIST,
  cacheFactory = createEncodedJsonCache,
} = {}) {
  const router = Router();
  const validIds = Object.keys(bjList);
  const sql = `SELECT ${NOTICE_METADATA_COLUMNS.join(", ")} FROM notices
    WHERE bj_id IN (${inPlaceholders(validIds)})
    ORDER BY reg_date DESC LIMIT 3000`;
  const noticesCache = cacheFactory({
    load: async () => (await selectFn(sql, validIds)).map(pickNoticeMetadata),
    ttlMs: 60_000,
    staleIfErrorMs: 15_000,
    onRefreshError: error => console.error("[notices] cache refresh failed:", error.message),
  });

  router.get("/", async (req, res) => {
    try {
      const entry = await noticesCache.get();
      res.setHeader("X-Content-Type-Options", "nosniff");
      sendEncodedJson(req, res, entry);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  return router;
}

const router = createRouter();

module.exports = router;
module.exports.createRouter = createRouter;
module.exports._test = {
  NOTICE_METADATA_COLUMNS,
  createRouter,
  pickNoticeMetadata,
};
