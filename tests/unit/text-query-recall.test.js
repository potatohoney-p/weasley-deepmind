import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

describe("public text recall without mandatory embedding providers", () => {
  for (const mode of ["disabled", "failed", "empty", "semantic", "reranker"]) {
    it(`discovers and ranks durable evidence (${mode})`, () => {
      // Do not pass credentials, provider settings, dotenv paths or NODE_OPTIONS.
      const inherited = Object.fromEntries(["PATH", "SystemRoot", "TEMP", "TMP"].flatMap(key =>
        process.env[key] ? [[key, process.env[key]]] : []));
      const child = spawnSync(process.execPath, ["--experimental-test-module-mocks",
        fileURLToPath(new URL("../fixtures/text-query-worker.mjs", import.meta.url)), mode], {
        encoding: "utf8", timeout: 30_000,
        env: { ...inherited, DOTENV_CONFIG_PATH: ".env.test", REDIS_ENABLED: "false", CACHE_ENABLED: "false",
          WEASLEY_DEEPMIND_METRICS_DEFAULT: "off", WEASLEY_DEEPMIND_SYMBOLIC_ENABLED: "false" }
      });
      assert.equal(child.error, undefined, child.error?.message);
      assert.equal(child.status, 0, child.stdout + child.stderr);
      const report = JSON.parse(child.stdout.trim());
      assert.equal(report.passed, true);
      assert.equal(report.mode, mode);
    });
  }
});
