import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";

const calls = { scans: [], sampled: [], removed: [] };
let pages;
let sizes;
const redis = {
  status: "ready",
  async scan(cursor, ...args) {
    calls.scans.push([cursor, ...args]);
    const page = pages.shift();
    if (page instanceof Error) throw page;
    return page;
  },
  pipeline() {
    const keys = [];
    return {
      scard(key) { keys.push(key); return this; },
      async exec() { return keys.map(key => sizes[key] ?? [null, 5001]); }
    };
  },
  async srandmember(key, count) { calls.sampled.push([key, count]); return ["old-fragment"]; },
  async srem(key, ...members) { calls.removed.push([key, ...members]); return members.length; }
};
mock.module("../../lib/redis.js", { namedExports: { redisClient: redis } });
mock.module("../../lib/logger.js", { namedExports: { logInfo() {}, logWarn() {} } });
mock.module("../../lib/memory/write/FragmentFactory.js", { namedExports: { FragmentFactory: class {} } });
const { FragmentIndex } = await import("../../lib/memory/FragmentIndex.js");

beforeEach(() => {
  pages = [];
  sizes = {};
  redis.status = "ready";
  for (const entries of Object.values(calls)) entries.length = 0;
});

test("successive maintenance calls resume SCAN and restart after a full cycle", async () => {
  pages = [["17", ["frag:kw:first"]], ["0", ["frag:kw:last"]], ["0", []]];
  const index = new FragmentIndex();
  await index.pruneKeywordIndexes();
  assert.equal(calls.scans.length, 1, "one scan page bounds each maintenance invocation");
  await index.pruneKeywordIndexes();
  await index.pruneKeywordIndexes();
  assert.deepEqual(calls.scans.map(c => c[0]), ["0", "17", "0"]);
  assert.deepEqual(calls.sampled, [["frag:kw:first", 1], ["frag:kw:last", 1]]);
});

test("empty pages with a nonzero cursor still advance", async () => {
  pages = [["42", []], ["0", ["frag:kw:late"]]];
  const index = new FragmentIndex();
  await index.pruneKeywordIndexes();
  await index.pruneKeywordIndexes();
  assert.deepEqual(calls.scans.map(c => c[0]), ["0", "42"]);
});

test("duplicate keys in a scan page are pruned only once", async () => {
  pages = [["0", ["frag:kw:a", "frag:kw:a"]]];
  await new FragmentIndex().pruneKeywordIndexes();
  assert.equal(calls.sampled.length, 1);
});

test("a failed scan retries its cursor and can recover", async () => {
  pages = [["12", []], new Error("Redis temporarily unavailable"), ["0", []]];
  const index = new FragmentIndex();
  await index.pruneKeywordIndexes();
  await index.pruneKeywordIndexes();
  await index.pruneKeywordIndexes();
  assert.deepEqual(calls.scans.map(c => c[0]), ["0", "12", "12"]);
});

test("under-budget and failed cardinalities remain untouched", async () => {
  pages = [["0", ["frag:kw:small", "frag:kw:error", "frag:kw:large"]]];
  sizes = { "frag:kw:small": [null, 5000], "frag:kw:error": [new Error("wrong type"), null], "frag:kw:large": [null, 5010] };
  await new FragmentIndex().pruneKeywordIndexes();
  assert.deepEqual(calls.sampled, [["frag:kw:large", 10]]);
});

test("disconnected Redis does not consume the saved cursor", async () => {
  pages = [["8", []], ["0", []]];
  const index = new FragmentIndex();
  await index.pruneKeywordIndexes();
  redis.status = "reconnecting";
  await index.pruneKeywordIndexes();
  redis.status = "ready";
  await index.pruneKeywordIndexes();
  assert.deepEqual(calls.scans.map(c => c[0]), ["0", "8"]);
});

test("overlapping calls do not process the same page concurrently", async () => {
  const releases = [];
  const originalScan = redis.scan;
  redis.scan = async (...args) => {
    await new Promise(resolve => { releases.push(resolve); });
    return originalScan(...args);
  };
  pages = [["9", ["frag:kw:a"]]];
  try {
    const index = new FragmentIndex();
    const first = index.pruneKeywordIndexes();
    const second = index.pruneKeywordIndexes();
    for (const release of releases) release();
    await Promise.all([first, second]);
    assert.equal(calls.scans.length, 1);
  } finally { redis.scan = originalScan; }
});

test("a failed page mutation retains the cursor and releases the overlap guard", async () => {
  pages = [["5", []], ["0", ["frag:kw:a"]], ["0", ["frag:kw:a"]]];
  const index = new FragmentIndex();
  await index.pruneKeywordIndexes();
  const originalRemove = redis.srem;
  redis.srem = async () => { throw new Error("write failed"); };
  try { await index.pruneKeywordIndexes(); }
  finally { redis.srem = originalRemove; }
  await index.pruneKeywordIndexes();
  assert.deepEqual(calls.scans.map(c => c[0]), ["0", "5", "5"]);
  assert.equal(calls.removed.length, 1);
});

test("separate index instances do not share cursor state", async () => {
  pages = [["29", []], ["0", []]];
  await new FragmentIndex().pruneKeywordIndexes();
  await new FragmentIndex().pruneKeywordIndexes();
  assert.deepEqual(calls.scans.map(c => c[0]), ["0", "0"]);
});
