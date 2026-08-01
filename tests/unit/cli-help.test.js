/**
 * H3: CLI 서브명령별 --help — usage export 존재 검증
 *
 * 작성자: 최진호
 * 작성일: 2026-04-20
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const MODULES = [
  "../../lib/cli/serve.js",
  "../../lib/cli/migrate.js",
  "../../lib/cli/cleanup.js",
  "../../lib/cli/backfill.js",
  "../../lib/cli/stats.js",
  "../../lib/cli/health.js",
  "../../lib/cli/recall.js",
  "../../lib/cli/remember.js",
  "../../lib/cli/inspect.js",
  "../../lib/cli/update.js",
];

describe("CLI --help: usage export", () => {
  for (const modPath of MODULES) {
    it(`${modPath} exports a non-empty usage string`, async () => {
      const mod = await import(modPath);
      assert.ok(
        typeof mod.usage === "string" && mod.usage.length > 0,
        `${modPath}: 'usage' must be a non-empty string, got ${typeof mod.usage}`
      );
      assert.ok(
        mod.usage.includes("Usage:"),
        `${modPath}: usage must contain "Usage:" header`
      );
    });
  }

  it("all 10 modules export usage", async () => {
    const results = await Promise.all(MODULES.map(p => import(p)));
    const missing = MODULES.filter((_, i) => typeof results[i].usage !== "string" || !results[i].usage);
    assert.deepStrictEqual(missing, [], `Modules missing usage: ${missing.join(", ")}`);
  });
});
