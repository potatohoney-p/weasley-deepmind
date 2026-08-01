import { test, describe } from "node:test";
import assert             from "node:assert/strict";
import { MorphemeIndex }  from "../../lib/memory/embedding/MorphemeIndex.js";

describe("MorphemeIndex.tokenize (local 모드)", () => {
  test("Gemini CLI 없이 형태소를 반환한다", async () => {
    const idx = new MorphemeIndex();
    const m = await idx.tokenize("memento-mcp 형태소 분석기 마이그레이션");
    assert.ok(Array.isArray(m));
    assert.ok(m.length > 0 && m.length <= 10);
    assert.ok(m.includes("형태소"));
  });
});
