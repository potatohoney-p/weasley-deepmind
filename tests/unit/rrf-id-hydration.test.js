import { after, test } from "node:test";
import assert from "node:assert/strict";
import { FragmentSearch, mergeRRF } from "../../lib/memory/read/FragmentSearch.js";
import { redisClient } from "../../lib/redis.js";
import { assertCleanShutdown } from "../_lifecycle.js";

after(async () => {
  try { await redisClient.quit(); } catch { /* disabled in unit tests */ }
  const { getPrimaryPool } = await import("../../lib/tools/db.js");
  await getPrimaryPool()?.end();
  await assertCleanShutdown();
});

const fragment = { id: "shared", content: "durable memory", importance: 0.8, type: "fact", is_anchor: false };

for (const layer of ["l2", "graph", "l3", "temporal"]) {
  test(`L1 ID gains fragment metadata from ${layer} without losing rank contributions`, () => {
    const input = Object.freeze({ ...fragment, _rrfScore: 999 });
    const [actual] = mergeRRF([
      { name: "l1", results: ["shared"], weightFactor: 2 },
      { name: layer, results: [input] }
    ]);
    assert.equal(actual.content, fragment.content);
    assert.equal(actual.importance, fragment.importance);
    assert.equal(actual.type, fragment.type);
    assert.equal(actual._rrfScore, 3 / 61);
    assert.equal(input._rrfScore, 999);
    assert.notEqual(actual, input);
  });
}

test("first content-bearing fragment wins and later IDs do not erase it", () => {
  const [actual] = mergeRRF([
    { results: [fragment] },
    { results: ["shared"] },
    { results: [{ ...fragment, content: "later copy", importance: 0.1 }] }
  ]);
  assert.equal(actual.content, fragment.content);
  assert.equal(actual.importance, 0.8);
  assert.equal(actual._rrfScore, 3 / 61);
});

test("an object placeholder can be hydrated and empty content is still content", () => {
  const [actual] = mergeRRF([
    { results: [{ id: "shared" }] },
    { results: [{ ...fragment, content: "" }] },
    { results: [fragment] }
  ]);
  assert.equal(actual.content, "");
  assert.equal(actual.importance, 0.8);
});

test("text search retains confirmed L1 candidates but excludes unresolved IDs", async () => {
  // No graph seeds or reranker query: exercise the actual L1 -> fusion -> cutoff path offline.
  const search = Object.create(FragmentSearch.prototype);
  search._searchL2 = async () => [];
  search._searchL3 = async () => [fragment, { id: "low", content: "low importance", importance: 0.01 }];
  const actual = await search._buildTextRRF(
    { minImportance: 0.2 }, ["shared", "missing", "low"], [], false, [],
    "default", null, null, [], {}
  );
  assert.deepEqual(actual.map(f => f.id), ["shared"]);
  assert.equal(actual[0].content, fragment.content);
});
