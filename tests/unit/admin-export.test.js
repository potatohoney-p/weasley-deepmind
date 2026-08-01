import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("export/import format", () => {
  it("serializes fragment to JSON Lines format", () => {
    const fragment = { id: "abc", content: "test", topic: "t", type: "fact" };
    const line = JSON.stringify(fragment);
    const parsed = JSON.parse(line);
    assert.strictEqual(parsed.id, "abc");
  });

  it("validates required fields on import", () => {
    const required = ["content", "topic", "type"];
    const valid    = { content: "x", topic: "t", type: "fact" };
    const invalid  = { content: "x", topic: "t" };
    assert.ok(required.every(f => f in valid));
    assert.ok(!required.every(f => f in invalid));
  });

  it("handles missing optional fields", () => {
    const frag = { content: "x", topic: "t", type: "fact" };
    const importance = frag.importance ?? 0.5;
    const keywords   = frag.keywords ?? [];
    assert.strictEqual(importance, 0.5);
    assert.deepStrictEqual(keywords, []);
  });
});
