import { beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { QuotaChecker, clearUsageCache } from "../../lib/memory/QuotaChecker.js";

function makeChecker(limit = 10, current = 10) {
  const query = mock.fn(async (sql) => {
    if (sql.includes("COUNT")) return { rows: [{ count: current }] };
    if (sql.includes("fragment_limit")) return { rows: [{ fragment_limit: limit }] };
    return { rows: [] };
  });
  const connect = mock.fn(async () => ({ query, release() {} }));
  const checker = new QuotaChecker();
  checker.setPool({ connect });
  return { checker, connect, query };
}

describe("quota usage result ownership", () => {
  beforeEach(clearUsageCache);

  for (const source of ["database", "cache"]) {
    it(`${source} result cannot change later cached usage`, async () => {
      const { checker, connect } = makeChecker();
      if (source === "cache") await checker.getUsage("snapshot");
      const result = await checker.getUsage("snapshot");
      result.limit = null;
      result.current = 0;
      result.remaining = 999;
      result.resetAt = "fake";
      result.extra = true;
      assert.deepEqual(await checker.getUsage("snapshot"), {
        limit: 10, current: 10, remaining: 0, resetAt: null
      });
      assert.equal(connect.mock.callCount(), 1, "copying must retain cache reuse");
    });

    it(`${source} result cannot bypass a full-quota check`, async () => {
      const { checker, query } = makeChecker();
      if (source === "cache") await checker.getUsage("full");
      const result = await checker.getUsage("full");
      result.limit = null;
      result.remaining = 999;
      await assert.rejects(checker.check("full"), { code: "fragment_limit_exceeded" });
      assert.ok(query.mock.calls.some(({ arguments: [sql] }) => sql.includes("FOR UPDATE")));
    });
  }

  it("successive unlimited results are detached while retaining their values", async () => {
    const { checker, connect } = makeChecker(null);
    const first = await checker.getUsage("unlimited");
    const second = await checker.getUsage("unlimited");
    assert.notStrictEqual(first, second);
    delete second.limit;
    assert.deepEqual(await checker.getUsage("unlimited"), {
      limit: null, current: 0, remaining: null, resetAt: null
    });
    assert.equal(connect.mock.callCount(), 1);
  });

  it("a frozen returned result does not freeze later callers' snapshots", async () => {
    const { checker } = makeChecker(100, 20);
    Object.freeze(await checker.getUsage("freeze"));
    const next = await checker.getUsage("freeze");
    next.current = 0;
    assert.equal((await checker.getUsage("freeze")).current, 20);
  });
});
