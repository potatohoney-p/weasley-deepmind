import { after, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, unlinkSync, rmdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertCleanShutdown } from "../_lifecycle.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const workflow = readFileSync(new URL("../../.github/workflows/e2e-local-embed.yml", import.meta.url), "utf8");
const fixture = fileURLToPath(new URL("../fixtures/transformers-cache-probe.mjs", import.meta.url));
const { env } = await import("@huggingface/transformers");

after(async () => { await assertCleanShutdown(); });

it("weekly workflow caches the installed Transformers.js runtime's default directory", () => {
  const configured = workflow.match(/^\s+path:\s*(.+)$/m)?.[1].trim();
  assert.ok(configured, "model cache path is configured");
  const cachePath = configured.startsWith("~/")
    ? path.join(homedir(), configured.slice(2))
    : path.resolve(root, configured);
  assert.equal(path.resolve(cachePath), path.resolve(env.cacheDir));
});

it("npm ci runs before restoring the package-local model cache", () => {
  const install = workflow.indexOf("run: npm ci");
  const restore = workflow.indexOf("uses: actions/cache@");
  assert.ok(install >= 0 && restore >= 0, "install and model cache steps exist");
  assert.ok(install < restore, "npm ci must not erase a restored node_modules cache");
});

it("a fresh process reuses a tiny synthetic config from the default filesystem cache offline", t => {
  const modelId = `codex-offline-${randomUUID()}/cache-probe`;
  const cacheFile = path.join(env.cacheDir, modelId, "config.json");
  t.after(() => {
    // Remove only the uniquely named fixture file and its empty directories.
    unlinkSync(cacheFile);
    rmdirSync(path.dirname(cacheFile));
    rmdirSync(path.dirname(path.dirname(cacheFile)));
  });
  const run = mode => JSON.parse(execFileSync(process.execPath, [fixture, mode, modelId], {
    cwd: root, encoding: "utf8", timeout: 30_000
  }).trim());
  const seed = run("seed");
  assert.equal(path.resolve(seed.cacheDir), path.resolve(env.cacheDir));
  assert.equal(seed.syntheticFetches, 1);
  assert.equal(JSON.parse(readFileSync(cacheFile, "utf8")).cache_probe, modelId);
  const reuse = run("reuse");
  assert.equal(path.resolve(reuse.cacheDir), path.resolve(env.cacheDir));
  assert.equal(reuse.syntheticFetches, 0);
});
