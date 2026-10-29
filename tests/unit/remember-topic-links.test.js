import assert from "node:assert/strict";
import { test } from "node:test";
import { ConflictResolver } from "../../lib/memory/write/ConflictResolver.js";

const fragment = { id: "new", topic: "memory", key_id: "key-1" };

function fixture(ids, { failTarget } = {}) {
  const calls = [];
  const links = [];
  const resolver = new ConflictResolver({
    async searchByTopic(topic, options) {
      calls.push({ topic, options });
      return ids.map(id => ({ id }));
    },
    async createLink(...args) {
      if (args[1] === failTarget) throw new Error("link unavailable");
      links.push(args);
    }
  }, {});
  return { resolver, calls, links };
}

for (const [position, ids] of [
  ["first", ["new", "a", "b", "c"]],
  ["middle", ["a", "new", "b", "c"]],
  ["last", ["a", "b", "c", "new"]]
]) {
  test(`topic auto-link skips self in ${position} position without losing neighbors`, async () => {
    const { resolver, calls, links } = fixture(ids);
    assert.equal(await resolver.autoLinkOnRemember(fragment, "agent-1"), 3);
    assert.deepEqual(links, ["a", "b", "c"].map(id => ["new", id, "related", "agent-1"]));
    assert.deepEqual(calls, [{ topic: "memory", options: {
      minImportance: 0.3, limit: 4, agentId: "agent-1", keyId: "key-1", includeSuperseded: false
    } }]);
  });
}

test("topic auto-link still caps successful links at three when self is absent", async () => {
  const { resolver, links } = fixture(["a", "b", "c", "d"]);
  assert.equal(await resolver.autoLinkOnRemember(fragment, "agent-1"), 3);
  assert.deepEqual(links.map(link => link[1]), ["a", "b", "c"]);
});

test("topic auto-link continues after a failed neighbor and a self candidate", async () => {
  const { resolver, links } = fixture(["a", "new", "b", "c"], { failTarget: "a" });
  assert.equal(await resolver.autoLinkOnRemember(fragment, "agent-1"), 2);
  assert.deepEqual(links.map(link => link[1]), ["b", "c"]);
});

test("topic auto-link returns zero when only self is present", async () => {
  const { resolver, links } = fixture(["new"]);
  assert.equal(await resolver.autoLinkOnRemember(fragment, "agent-1"), 0);
  assert.deepEqual(links, []);
});
