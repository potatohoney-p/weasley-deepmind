import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { detectInstallType } from "../../lib/updater/install-detector.js";

describe("detectInstallType", () => {
  it("detects docker from env", async () => {
    assert.equal(await detectInstallType({ env: { MEMENTO_RUNTIME: "docker" }, dirname: "/app/lib/updater" }), "docker");
  });

  it("detects docker from /.dockerenv", async () => {
    assert.equal(await detectInstallType({ env: {}, dirname: "/app/lib/updater", fileExists: (p) => p === "/.dockerenv" }), "docker");
  });

  it("detects git", async () => {
    assert.equal(await detectInstallType({
      env: {}, dirname: "/home/user/memento-mcp/lib/updater",
      fileExists: (p) => p === "/home/user/memento-mcp/.git",
      execCommand: () => Promise.resolve("origin\thttps://github.com/potatohoney-p/memento-mcp.git (fetch)")
    }), "git");
  });

  it("detects npm-local", async () => {
    assert.equal(await detectInstallType({
      env: {}, dirname: "/project/node_modules/memento-mcp/lib/updater",
      fileExists: () => false, execCommand: () => Promise.reject(new Error("no git"))
    }), "npm-local");
  });

  it("detects npm-global", async () => {
    assert.equal(await detectInstallType({
      env: {}, dirname: "/usr/local/lib/node_modules/memento-mcp/lib/updater",
      fileExists: () => false,
      execCommand: (cmd) => cmd === "npm" ? Promise.resolve("/usr/local") : Promise.reject(new Error("no git"))
    }), "npm-global");
  });

  it("returns unknown", async () => {
    assert.equal(await detectInstallType({
      env: {}, dirname: "/random/path",
      fileExists: () => false, execCommand: () => Promise.reject(new Error("fail"))
    }), "unknown");
  });
});
