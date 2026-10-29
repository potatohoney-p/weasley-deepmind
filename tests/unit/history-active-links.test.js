import { test, after, mock } from "node:test";
import assert from "node:assert/strict";
import { HistoryReconstructor } from "../../lib/memory/read/HistoryReconstructor.js";
import { getPrimaryPool } from "../../lib/tools/db.js";

const pool = getPrimaryPool();
after(async () => { mock.restoreAll(); await pool.end(); });

test("history link query filters deletion across both bound directions", async () => {
  let captured;
  const rows = [{ from_id: "one", to_id: "two", relation_type: "caused_by", weight: 1 }];
  const query = mock.method(pool, "query", async (sql, params) => {
    captured = { sql: sql.replace(/\s+/g, " ").trim(), params };
    return { rows };
  });
  try {
    const ids = ["one", "quote'and%_literal"];
    const result = await new HistoryReconstructor(null, null)._fetchLinks(ids);
    assert.deepEqual(result, rows);
    assert.match(captured.sql, /WHERE \(fl\.from_id = ANY\(\$1\) OR fl\.to_id = ANY\(\$1\)\) AND fl\.deleted_at IS NULL$/);
    assert.deepEqual(captured.params, [ids]);
  } finally { query.mock.restore(); }
});

test("empty history does not read link storage", async () => {
  const query = mock.method(pool, "query", async () => { throw new Error("unexpected query"); });
  try {
    const reader = new HistoryReconstructor(null, null);
    for (const ids of [undefined, null, []]) assert.deepEqual(await reader._fetchLinks(ids), []);
    assert.equal(query.mock.callCount(), 0);
  } finally { query.mock.restore(); }
});

test("history link storage failures are not converted into resolved narratives", async () => {
  const query = mock.method(pool, "query", async () => { throw new Error("storage unavailable"); });
  try {
    await assert.rejects(new HistoryReconstructor(null, null)._fetchLinks(["one"]), /storage unavailable/);
  } finally { query.mock.restore(); }
});
