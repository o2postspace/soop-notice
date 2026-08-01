require("dotenv").config({ path: require("node:path").resolve(__dirname, "..", ".env"), quiet: true });

const fs = require("node:fs");
const path = require("node:path");
const mysql = require("mysql2/promise");

async function main() {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || "localhost",
    user: process.env.DB_USER || "soop_notice",
    password: process.env.DB_PASSWORD || "",
    database: process.env.DB_NAME || "soop_notice",
    charset: "utf8mb4",
    timezone: "+00:00",
    multipleStatements: true,
  });

  try {
    const schemaPath = path.join(__dirname, "community-schema.sql");
    const schema = fs.readFileSync(schemaPath, "utf8");
    await connection.query(schema);
    const [indexes] = await connection.execute(
      `SELECT 1 FROM information_schema.statistics
       WHERE table_schema = DATABASE() AND table_name = 'community_posts'
         AND index_name = 'ft_community_posts_search' LIMIT 1`,
    );
    if (!indexes.length) {
      await connection.query(
        "ALTER TABLE community_posts ADD FULLTEXT INDEX ft_community_posts_search (title, body) WITH PARSER ngram",
      );
    }
    console.log("community schema ready");
  } finally {
    await connection.end();
  }
}

main().catch(error => {
  console.error(`community schema failed: ${error.message}`);
  process.exitCode = 1;
});
