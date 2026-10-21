import { after, afterEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import { FragmentSearch } from "../../lib/memory/read/FragmentSearch.js";
import { getSearchParamAdaptor } from "../../lib/memory/signals/SearchParamAdaptor.js";
import { MEMORY_CONFIG } from "../../config/memory.js";
import { MemoryRecaller, computeRecallScore } from "../../lib/memory/processors/MemoryRecaller.js";
import { teardownTestResources, assertCleanShutdown } from "../_lifecycle.js";

const day = 86400000;
const start = Date.parse("2026-01-01T00:00:00Z");
const cursor = value => Buffer.from(JSON.stringify(value)).toString("base64url");
const fragments = [
  { id: "old-important", importance: 1, created_at: new Date(start - 30 * day).toISOString() },
  { id: "newer", importance: 0.75, created_at: new Date(start).toISOString() }
];
function fixture(rows = fragments) {
  const queries = [];
  const recaller = new MemoryRecaller({ search: { search: async query => {
    queries.push(query);
    return { fragments: structuredClone(rows), count: rows.length, totalTokens: 0, searchPath: "synthetic" };
  } } });
  return { queries, recall: params => recaller.recall({ includeLinks: false, pageSize: 1, ...params }) };
}
afterEach(() => mock.restoreAll());
after(async () => { await teardownTestResources(); await assertCleanShutdown(); });

test("continuation reuses cursor anchor for search and final ranking despite elapsed time", async () => {
  const h = fixture();
  const now = mock.method(Date, "now", () => start);
  const first = await h.recall({});
  assert.equal(first.fragments[0].id, "newer");
  now.mock.mockImplementation(() => start + 90 * day);
  const second = await h.recall({ cursor: first.nextCursor });
  assert.equal(second.fragments[0].id, "old-important");
  assert.equal(h.queries[1].anchorTime, start);
  assert.equal(second.hasMore, false);
});

test("cursor anchor takes precedence over a newly supplied anchor", async () => {
  const h = fixture();
  const result = await h.recall({ cursor: cursor({ offset: 1, anchorTime: start }), anchorTime: start + 90 * day });
  assert.equal(h.queries[0].anchorTime, start);
  assert.equal(result.fragments[0].id, "old-important");
});

test("first cursor serializes the exact anchor passed to search, not a later clock read", async () => {
  let tick = 0;
  mock.method(Date, "now", () => start + tick++);
  const h = fixture();
  const result = await h.recall({});
  assert.equal(JSON.parse(Buffer.from(result.nextCursor, "base64url")).anchorTime, h.queries[0].anchorTime);
});

for (const bad of [null, [], 42, { offset: -1, anchorTime: start }, { offset: "1", anchorTime: start },
  { offset: 0.5, anchorTime: start }, { offset: Number.MAX_SAFE_INTEGER + 1, anchorTime: start },
  { offset: 1 }, { offset: 1, anchorTime: "2026-01-01" }, { offset: 1, anchorTime: null },
  { offset: 1, anchorTime: 9e15 }]) {
  test(`malformed cursor restarts safely: ${JSON.stringify(bad)}`, async () => {
    mock.method(Date, "now", () => start);
    const h = fixture();
    const result = await h.recall({ cursor: cursor(bad) });
    assert.equal(result.fragments[0].id, "newer");
    assert.equal(h.queries[0].anchorTime, start);
    assert.equal(JSON.parse(Buffer.from(result.nextCursor, "base64url")).offset, 1);
  });
}

test("recaller forwards a valid Unix epoch cursor anchor without replacing it", async () => {
  const h = fixture();
  await h.recall({ cursor: cursor({ offset: 0, anchorTime: 0 }) });
  assert.equal(h.queries[0].anchorTime, 0);
});

test("broken encoding keeps existing invalid-cursor first-page behavior", async () => {
  mock.method(Date, "now", () => start);
  const h = fixture();
  const result = await h.recall({ cursor: "not-json" });
  assert.equal(result.fragments[0].id, "newer");
});

for (const params of [{ anchorTime: 0 }, { cursor: cursor({ offset: 0, anchorTime: 0 }) }]) {
  test(`epoch anchor survives actual search normalization: ${JSON.stringify(params)}`, async () => {
    mock.method(getSearchParamAdaptor(), "getMinSimilarity", async () => 0.5);
    let normalized;
    const recaller = new MemoryRecaller({ search: { search: async query => {
      normalized = FragmentSearch.prototype._buildSearchQuery.call({}, query);
      await normalized._adaptedSimPromise;
      return { fragments: structuredClone(fragments), count: 2, totalTokens: 0, searchPath: "synthetic" };
    } } });
    await recaller.recall({ includeLinks: false, pageSize: 1, ...params });
    assert.equal(normalized.anchorTime, 0);
  });
}

test("documented limit: undated candidates still use the existing wall-clock score fallback", () => {
  const now = mock.method(Date, "now", () => start);
  const context = { lexicalQuery: [], anchorTime: start, config: MEMORY_CONFIG };
  const undated = { importance: 1 };
  const first = computeRecallScore(undated, context);
  now.mock.mockImplementation(() => start + 90 * day);
  assert.ok(computeRecallScore(undated, context) < first);
});
