import { after, mock, test } from "node:test";
import assert from "node:assert/strict";
import { MemoryLinker } from "../../lib/memory/processors/MemoryLinker.js";
import { MemoryManager } from "../../lib/memory/MemoryManager.js";
import { handleToolsCall } from "../../lib/jsonrpc.js";
import { assertCleanShutdown, teardownTestResources } from "../_lifecycle.js";

after(async () => {
  mock.restoreAll();
  await teardownTestResources();
  await assertCleanShutdown();
});

function fixture() {
  const store = {
    getById: mock.fn(async id => ({ id, type: "error", importance: 0.9 })),
    createLink: mock.fn(async () => {}),
    update: mock.fn(async () => {})
  };
  return { store, linker: new MemoryLinker({ store, index: {} }) };
}

test("nonfinite and nonnumeric link weights fail before storage or importance updates", async () => {
  for (const weight of [NaN, Infinity, -Infinity, "NaN", "Infinity", "0.5", "", true, [], {}, { valueOf: () => 0.5 }]) {
    const { linker, store } = fixture();
    await assert.rejects(linker.link({ fromId: "a", toId: "b", relationType: "resolved_by", weight }),
      { name: "TypeError", message: "weight must be a finite number" });
    assert.equal(store.getById.mock.callCount(), 0);
    assert.equal(store.createLink.mock.callCount(), 0);
    assert.equal(store.update.mock.callCount(), 0);
  }
});

test("dry runs reject invalid weights instead of claiming the link would succeed", async () => {
  for (const weight of [NaN, Infinity, -Infinity, "NaN", "0.5", false, []]) {
    const { linker, store } = fixture();
    await assert.rejects(linker.link({ fromId: "a", toId: "b", weight, dryRun: true }),
      { name: "TypeError", message: "weight must be a finite number" });
    assert.equal(store.createLink.mock.callCount(), 0);
  }
});

test("finite weights retain their value and omitted/null weights retain the default", async () => {
  // Range policy is unchanged: do not silently clamp or reject existing finite weights.
  for (const weight of [undefined, null, 0, -0, 0.3, 1, 2, -0.5]) {
    const { linker, store } = fixture();
    const args = { fromId: "a", toId: "b", agentId: "agent", _keyId: "key", _groupKeyIds: ["key", "peer"] };
    if (weight !== undefined) args.weight = weight;
    assert.deepEqual(await linker.link(args), { linked: true, relationType: "related" });
    assert.deepEqual(store.getById.mock.calls.map(call => call.arguments), [
      ["a", "agent", "key", ["key", "peer"]], ["b", "agent", "key", ["key", "peer"]]
    ]);
    assert.deepEqual(store.createLink.mock.calls[0].arguments, ["a", "b", "related", "agent", weight ?? 1]);
    assert.equal(store.update.mock.callCount(), 0);
  }
});

test("valid weights preserve ownership checks, dry runs and resolved-error updates", async () => {
  const { linker, store } = fixture();
  const args = { fromId: "a", toId: "b", relationType: "resolved_by", weight: 0.5 };
  const dryRun = await linker.link({ ...args, dryRun: true });
  assert.equal(dryRun.simulated.would_link, true);
  assert.equal(store.createLink.mock.callCount(), 0);
  assert.equal(store.update.mock.callCount(), 0);
  await linker.link(args);
  assert.deepEqual(store.update.mock.calls[0].arguments, ["b", { importance: 0.5 }, "default", null]);
  store.getById.mock.mockImplementation(async () => null);
  const denied = await linker.link(args);
  assert.equal(denied.linked, false);
  assert.equal(store.createLink.mock.callCount(), 1);
});

test("JSON tool dispatch reports invalid weights as MCP tool errors with no write", async () => {
  // These are valid JSON texts, including numeric overflow to JS Infinity.
  for (const literal of ['"NaN"', '"Infinity"', '"-Infinity"', '"0.5"', "1e400", "-1e400", "true", "[]", "{}"])
    for (const dryRun of [false, true]) {
      const { linker, store } = fixture();
      const managerMock = mock.method(MemoryManager, "getInstance", () => linker);
      try {
        const request = JSON.parse(`{"name":"link","arguments":{"fromId":"a","toId":"b","weight":${literal},"dryRun":${dryRun}}}`);
        const result = await handleToolsCall(request);
        assert.equal(result.isError, true, `${literal}, dryRun=${dryRun}`);
        assert.deepEqual(JSON.parse(result.content[0].text), { success: false, error: "weight must be a finite number" });
        assert.equal(store.createLink.mock.callCount(), 0);
      } finally {
        managerMock.mock.restore();
      }
    }
});

test("valid JSON tool dispatch still returns a successful link", async () => {
  const { linker, store } = fixture();
  const managerMock = mock.method(MemoryManager, "getInstance", () => linker);
  try {
    const result = await handleToolsCall(JSON.parse('{"name":"link","arguments":{"fromId":"a","toId":"b","weight":0.5}}'));
    assert.equal(result.isError, false);
    assert.deepEqual(JSON.parse(result.content[0].text), { success: true, linked: true, relationType: "related" });
    assert.equal(store.createLink.mock.calls[0].arguments[4], 0.5);
  } finally {
    managerMock.mock.restore();
  }
});
