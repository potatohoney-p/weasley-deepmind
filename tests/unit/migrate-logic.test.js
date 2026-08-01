import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("migration file sorting", () => {
  it("sorts migration files numerically", () => {
    const files = [
      "migration-010-ema-activation.sql",
      "migration-002-decay.sql",
      "migration-001-temporal.sql",
      "migration-013-search-events.sql"
    ];
    const sorted = files.sort();
    assert.deepStrictEqual(sorted, [
      "migration-001-temporal.sql",
      "migration-002-decay.sql",
      "migration-010-ema-activation.sql",
      "migration-013-search-events.sql"
    ]);
  });

  it("filters only migration SQL files", () => {
    const files = ["memory-schema.sql", "migration-001-temporal.sql", "migration-002-decay.sql", "README.md"];
    const migrations = files.filter(f => f.startsWith("migration-") && f.endsWith(".sql"));
    assert.strictEqual(migrations.length, 2);
  });

  it("detects unapplied migrations", () => {
    const all = ["migration-001-temporal.sql", "migration-002-decay.sql", "migration-003-api-keys.sql"];
    const applied = new Set(["migration-001-temporal.sql", "migration-002-decay.sql"]);
    const pending = all.filter(f => !applied.has(f));
    assert.deepStrictEqual(pending, ["migration-003-api-keys.sql"]);
  });
});
