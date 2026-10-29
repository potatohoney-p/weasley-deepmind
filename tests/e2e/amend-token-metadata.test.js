import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

after(async () => { if (teardownTestResources) await teardownTestResources(); });
let teardownTestResources;

test("PostgreSQL amendment keeps content and token metadata consistent across fresh reads", {
  skip: !process.env.DATABASE_URL && !process.env.POSTGRES_HOST
}, async () => {
  const { FragmentWriter } = await import("../../lib/memory/write/FragmentWriter.js");
  const { countTokens } = await import("../../lib/memory/write/FragmentFactory.js");
  const { FragmentSearch } = await import("../../lib/memory/read/FragmentSearch.js");
  const { getPrimaryPool } = await import("../../lib/tools/db.js");
  ({ teardownTestResources } = await import("../_lifecycle.js"));
  const writer = new FragmentWriter();
  const pool = getPrimaryPool();
  const id = `amend-tokens-${randomUUID()}`;
  const short = `${id} short`;
  const long = `${id} 변경된 장기 기억의 내용을 정확히 저장합니다. `.repeat(8);
  try {
    assert.equal(await writer.insert({ id, content: short, topic: id, type: "fact",
      estimated_tokens: countTokens(short), agent_id: "default" }), id);
    const search = Object.create(FragmentSearch.prototype);
    for (const content of [long, short]) {
      const result = await writer.update(id, { content });
      const { rows: [stored] } = await pool.query(
        "SELECT id, content, estimated_tokens FROM agent_memory.fragments WHERE id = $1", [id]
      );
      assert.equal(stored.content, content);
      assert.equal(stored.estimated_tokens, countTokens(content));
      assert.equal(result.estimated_tokens, stored.estimated_tokens);
      assert.deepEqual(search._trimToTokenBudget([stored], countTokens(short)).map(f => f.id), content === short ? [id] : []);
    }
    const { rows } = await pool.query(
      "SELECT content FROM agent_memory.fragment_versions WHERE fragment_id = $1", [id]
    );
    assert.deepEqual(rows.map(r => r.content).sort(), [short, long].sort());
  } finally {
    // Only this randomly identified fixture in the explicitly configured test DB.
    await pool.query("DELETE FROM agent_memory.fragment_versions WHERE fragment_id = $1", [id]);
    await pool.query("DELETE FROM agent_memory.fragments WHERE id = $1", [id]);
  }
});
