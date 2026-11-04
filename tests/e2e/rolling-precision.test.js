/**
 * Run production aggregation SQL against PostgreSQL. A temporary fixture table
 * avoids mixing feedback from concurrent tests or an existing development DB.
 * Only the relation name is substituted; the aggregation and bindings are intact.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { rollingPrecisionCases } from "../fixtures/rolling-precision.js";

describe("rolling precision (PostgreSQL)", { skip: !process.env.DATABASE_URL }, () => {
  let pool, client, sql, lifecycle;
  before(async () => {
    const { ROLLING_PRECISION_SQL } = await import("../../lib/memory/signals/EvaluationMetrics.js");
    lifecycle = await import("../_lifecycle.js");
    sql = ROLLING_PRECISION_SQL.replace("agent_memory.tool_feedback", "pg_temp.rolling_feedback");
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    client = await pool.connect();
    await client.query(`CREATE TEMP TABLE rolling_feedback (
      id bigint PRIMARY KEY, session_id text, relevant boolean NOT NULL,
      sufficient boolean NOT NULL, created_at timestamptz
    )`);
  });
  after(async () => {
    client?.release();
    await pool?.end();
    await lifecycle?.teardownTestResources();
    await lifecycle?.assertCleanShutdown();
  });

  for (const fixture of rollingPrecisionCases) {
    it(fixture.name, async () => {
      await client.query("BEGIN");
      try {
        for (const r of fixture.rows) {
          await client.query(`INSERT INTO rolling_feedback VALUES (
            $1, $2, $3, $4, NOW() - $5 * INTERVAL '1 second'
          )`, [r.id, r.session, r.relevant, r.sufficient, r.age]);
        }
        const { rows: [result] } = await client.query(sql, [fixture.window]);
        assert.equal(result.sample_sessions, fixture.sessions);
        for (const [field, expected] of [
          ["avg_precision_at_5", fixture.precision], ["avg_sufficient_rate", fixture.sufficient]
        ]) {
          if (expected === null) assert.equal(result[field], null);
          else assert.ok(Math.abs(Number(result[field]) - expected) < 1e-10, `${field}: ${result[field]} != ${expected}`);
        }
      } finally {
        await client.query("ROLLBACK");
      }
    });
  }
});
