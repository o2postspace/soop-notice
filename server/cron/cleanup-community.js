const { query } = require("../db");

const EXPIRING_TABLES = [
  "community_post_views",
  "community_rate_limits",
  "community_submission_guards",
];

async function cleanupCommunity({ batchSize = 5_000, maxBatches = 20 } = {}) {
  let deleted = 0;
  for (const table of EXPIRING_TABLES) {
    for (let batch = 0; batch < maxBatches; batch++) {
      // table은 위 고정 allowlist에서만 가져온다.
      const result = await query(
        `DELETE FROM ${table} WHERE expires_at < UTC_TIMESTAMP() LIMIT ${batchSize}`,
      );
      deleted += result.affectedRows;
      if (result.affectedRows < batchSize) break;
    }
  }
  return deleted;
}

module.exports = cleanupCommunity;
module.exports._test = { EXPIRING_TABLES };
