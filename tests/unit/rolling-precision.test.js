import { after, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";

let pool;
mock.module("../../lib/tools/db.js", {
  namedExports: { getPrimaryPool: () => pool, shutdownPool: async () => {} }
});
mock.module("../../lib/redis.js", {
  namedExports: { disconnectRedis: async () => {} }
});
const { computeRollingPrecision, ROLLING_PRECISION_SQL } = await import("../../lib/memory/signals/EvaluationMetrics.js");
const { assertCleanShutdown } = await import("../_lifecycle.js");
const empty = { precision_at_5: null, sample_sessions: 0, sufficient_rate: null };
after(async () => { mock.restoreAll(); await assertCleanShutdown(); });

beforeEach(() => { pool = null; });
describe("computeRollingPrecision production query boundary", () => {
  it("returns empty rates without a pool", async () => {
    assert.deepEqual(await computeRollingPrecision(), empty);
  });
  it("binds the requested session limit to the acceptance-tested query and parses rates", async () => {
    pool = { query: async (sql, params) => {
      assert.equal(sql, ROLLING_PRECISION_SQL);
      assert.deepEqual(params, [7]);
      return { rows: [{ avg_precision_at_5: "0.4", avg_sufficient_rate: "0.8", sample_sessions: "3" }] };
    } };
    assert.deepEqual(await computeRollingPrecision(7), { precision_at_5: 0.4, sufficient_rate: 0.8, sample_sessions: 3 });
  });
  it("keeps null aggregate rates for an empty sample", async () => {
    pool = { query: async (_sql, params) => {
      assert.deepEqual(params, [100]);
      return { rows: [{ avg_precision_at_5: null, avg_sufficient_rate: null, sample_sessions: 0 }] };
    } };
    assert.deepEqual(await computeRollingPrecision(), empty);
  });
  it("retains fail-open behavior after a database failure", async () => {
    pool = { query: async () => { throw new Error("database unavailable"); } };
    assert.deepEqual(await computeRollingPrecision(), empty);
  });
});
