import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { MEMORY_CONFIG } from "../../config/memory.js";

describe("reflectionPolicy config", () => {
  test("reflectionPolicy 설정이 존재한다", () => {
    const p = MEMORY_CONFIG.reflectionPolicy;
    assert.ok(p, "reflectionPolicy 필수");
    assert.strictEqual(p.maxAgeDays, 30);
    assert.strictEqual(p.keepPerType, 5);
  });
});
