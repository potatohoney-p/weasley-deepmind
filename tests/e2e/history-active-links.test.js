import { test } from "node:test";
import { checkHistoryActiveLinks } from "../helpers/history-active-links.js";

test("history reconstruction respects soft-deleted causal links in PostgreSQL", {
  skip: !process.env.DATABASE_URL
}, async () => {
  const { getPrimaryPool } = await import("../../lib/tools/db.js");
  const { HistoryReconstructor } = await import("../../lib/memory/read/HistoryReconstructor.js");
  const pool = getPrimaryPool();
  const client = await pool.connect();
  const originalQuery = pool.query;
  try {
    await client.query("BEGIN");
    // Production reads share the fixture transaction; nothing is committed.
    pool.query = (sql, params) => client.query(sql, params);
    await checkHistoryActiveLinks(client, new HistoryReconstructor(null, null));
  } finally {
    pool.query = originalQuery;
    try {
      await client.query("ROLLBACK");
    } finally {
      client.release();
      await pool.end();
    }
  }
});
