import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { MEMORY_CONFIG } from "../../config/memory.js";

describe("error GC policy", () => {
  test("errorResolvedPolicy 설정이 존재한다", () => {
    const policy = MEMORY_CONFIG.gc.errorResolvedPolicy;
    assert.ok(policy, "errorResolvedPolicy 필수");
    assert.strictEqual(policy.maxAgeDays, 30);
    assert.strictEqual(policy.maxImportance, 0.3);
  });
});
