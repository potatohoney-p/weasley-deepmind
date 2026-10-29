import { beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";

const warnings = [];
const redis = { status: "ready", scan: async () => ["0", []], get: async () => null };
mock.module("../../lib/redis.js", { namedExports: { redisClient: redis } });
mock.module("../../lib/logger.js", { namedExports: { logWarn: message => warnings.push(message) } });
const { SessionActivityTracker } = await import("../../lib/memory/processors/SessionActivityTracker.js");
const discover = limit => SessionActivityTracker.getUnreflectedSessions(limit);
const prefix = "frag:activity:";

beforeEach(() => {
  warnings.length = 0;
  redis.status = "ready";
  redis.scan = async () => ["0", []];
  redis.get = async () => null;
});

function pages(rows, values) {
  const calls = { scan: 0, get: [] };
  redis.scan = async () => {
    const index = calls.scan++;
    return [index + 1 === rows.length ? "0" : String(index + 1), rows[index].map(id => prefix + id)];
  };
  redis.get = async key => { calls.get.push(key); return values[key.slice(prefix.length)]; };
  return calls;
}

describe("production session activity discovery", () => {
  it("keeps later sessions when an earlier record is invalid JSON", async () => {
    const calls = pages([["bad", "valid"], ["later"]], { bad: '{"private":', valid: '{}', later: '{"reflected":false}' });
    assert.deepEqual(await discover(), ["valid", "later"]);
    assert.equal(calls.scan, 2);
    assert.ok(warnings.length > 0);
    assert.ok(warnings.every(message => !message.includes('private')));
  });
  for (const raw of ['null', '[]', '0', '"text"', 'true']) {
    it(`skips non-object activity ${raw} without losing later sessions`, async () => {
      pages([["bad", "valid"]], { bad: raw, valid: '{}' });
      assert.deepEqual(await discover(), ["valid"]);
    });
  }
  it("deduplicates SCAN keys across and within pages before GET and result limits", async () => {
    const calls = pages([["a", "a"], ["a", "b", "c"]], { a: '{}', b: '{}', c: '{}' });
    assert.deepEqual(await discover(2), ["a", "b"]);
    assert.deepEqual(calls.get, [prefix + 'a', prefix + 'b']);
  });
  it("skips expired and reflected records without using result slots", async () => {
    pages([["gone", "done", "valid"]], { gone: null, done: '{"reflected":true}', valid: '{}' });
    assert.deepEqual(await discover(1), ["valid"]);
  });
  it("stops at twenty scans even if the cursor never completes", async () => {
    let count = 0;
    redis.scan = async () => [String(++count), []];
    assert.deepEqual(await discover(), []);
    assert.equal(count, 20);
  });
  it("returns accumulated sessions on a transport failure rather than hiding it", async () => {
    let count = 0;
    redis.scan = async () => {
      if (++count === 2) throw new Error('offline');
      return ['1', [prefix + 'a']];
    };
    redis.get = async () => '{}';
    assert.deepEqual(await discover(), ['a']);
    assert.ok(warnings.some(message => message.includes('offline')));
  });
  it("does not call Redis for nonpositive, fractional or nonnumeric limits", async () => {
    redis.scan = async () => { throw new Error('must not scan'); };
    for (const limit of [0, -1, 1.5, NaN, Infinity, '2', null, true]) {
      assert.deepEqual(await discover(limit), []);
    }
    assert.deepEqual(warnings, []);
  });
  it("does not access unavailable Redis", async () => {
    redis.status = 'disconnected';
    redis.scan = async () => { throw new Error('must not scan'); };
    assert.deepEqual(await discover(), []);
    assert.deepEqual(warnings, []);
  });
});
