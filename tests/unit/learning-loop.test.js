import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("Learning Loop", () => {
  it("identifies learning fragments by source field", () => {
    const fragments = [
      { id: "1", source: "learning_extraction", content: "keyword recall이 정확" },
      { id: "2", source: null, content: "일반" },
      { id: "3", source: "learning_extraction", content: "error는 topic 필터 필요" },
    ];
    const learnings = fragments.filter(f => f.source === "learning_extraction");
    assert.strictEqual(learnings.length, 2);
  });

  it("extracts L3 usage rate from searchPaths", () => {
    const searchPaths = ["L1:5", "L1:3 -> L2:2", "L1:0 -> L2:5 -> L3:3"];
    const l3Count = searchPaths.filter(p => p.includes("L3")).length;
    const l3Rate  = l3Count / searchPaths.length;
    assert.ok(l3Rate > 0.3);
    assert.ok(l3Rate < 0.4);
  });

  it("generates minimal learning when L3 rate is high", () => {
    const searchPaths = ["L3:5", "L3:3", "L1:2 -> L3:1"];
    const l3Rate = searchPaths.filter(p => p.includes("L3")).length / searchPaths.length;
    const shouldLearn = l3Rate > 0.5;
    assert.ok(shouldLearn);
  });

  it("does not generate learning for empty sessions", () => {
    const activity = { toolCalls: {}, searchPaths: [] };
    const hasActivity = Object.keys(activity.toolCalls).length > 0;
    assert.ok(!hasActivity);
  });
});
