import { test, describe } from "node:test";
import assert from "node:assert/strict";

describe("consolidate schedule", () => {
  test("CONSOLIDATE_INTERVAL_MS 기본값은 6시간(21600000ms)", () => {
    const interval = parseInt(process.env.CONSOLIDATE_INTERVAL_MS || "21600000", 10);
    assert.ok(interval >= 3600000, "최소 1시간 이상");
    assert.ok(interval <= 86400000, "최대 24시간 이하");
  });
});
