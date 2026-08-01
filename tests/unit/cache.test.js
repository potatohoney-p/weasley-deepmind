import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

describe("UpdateCache", () => {
  let UpdateCache;
  let TEST_DIR;

  beforeEach(async () => {
    TEST_DIR = path.join(os.tmpdir(), `.memento-mcp-test-${Date.now()}`);
    fs.mkdirSync(TEST_DIR, { recursive: true });
    const mod = await import("../../lib/updater/cache.js");
    UpdateCache = mod.UpdateCache;
  });

  afterEach(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("returns null when no cache file exists", () => {
    const cache = new UpdateCache(TEST_DIR);
    assert.equal(cache.get(), null);
  });

  it("stores and retrieves cache data", () => {
    const cache = new UpdateCache(TEST_DIR);
    cache.set({ latestVersion: "2.3.0", currentVersion: "2.2.1", updateAvailable: true, installType: "git" });
    const result = cache.get();
    assert.equal(result.latestVersion, "2.3.0");
    assert.equal(result.updateAvailable, true);
    assert.ok(result.lastCheck);
  });

  it("reports expired when TTL exceeded", () => {
    const cache = new UpdateCache(TEST_DIR);
    cache.set({ latestVersion: "2.3.0", currentVersion: "2.2.1", updateAvailable: false, installType: "git" });
    const filePath = path.join(TEST_DIR, "update-check.json");
    const stored = JSON.parse(fs.readFileSync(filePath, "utf8"));
    stored.lastCheck = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    fs.writeFileSync(filePath, JSON.stringify(stored));
    assert.equal(cache.isExpired(24), true);
  });

  it("reports not expired within TTL", () => {
    const cache = new UpdateCache(TEST_DIR);
    cache.set({ latestVersion: "2.2.1", currentVersion: "2.2.1", updateAvailable: false, installType: "git" });
    assert.equal(cache.isExpired(24), false);
  });

  it("handles corrupted cache file gracefully", () => {
    fs.writeFileSync(path.join(TEST_DIR, "update-check.json"), "not json{{{");
    const cache = new UpdateCache(TEST_DIR);
    assert.equal(cache.get(), null);
  });
});
