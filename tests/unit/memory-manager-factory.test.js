import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("MemoryManager.create", () => {
  it("accepts injected dependencies", async () => {
    const mockStore  = { insert: async () => ({ id: "test" }) };
    const mockSearch = { search: async () => ({ fragments: [] }) };

    const { MemoryManager } = await import("../../lib/memory/MemoryManager.js");
    const mm = MemoryManager.create({ store: mockStore, search: mockSearch });

    assert.strictEqual(mm.store, mockStore);
    assert.strictEqual(mm.search, mockSearch);
  });

  it("falls back to real dependencies when not provided", async () => {
    const { MemoryManager } = await import("../../lib/memory/MemoryManager.js");
    const mm = MemoryManager.create({});

    assert.ok(mm.store);
    assert.ok(mm.search);
  });
});
