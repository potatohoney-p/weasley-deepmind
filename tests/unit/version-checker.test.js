import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { compareSemver, parseVersion, findLatestTag } from "../../lib/updater/version-checker.js";

describe("parseVersion", () => {
  it("parses v-prefixed", () => {
    assert.deepEqual(parseVersion("v2.3.1"), { major: 2, minor: 3, patch: 1 });
  });
  it("parses plain", () => {
    assert.deepEqual(parseVersion("2.3.1"), { major: 2, minor: 3, patch: 1 });
  });
  it("returns null for invalid", () => {
    assert.equal(parseVersion("not-a-version"), null);
  });
  it("returns null for empty", () => {
    assert.equal(parseVersion(""), null);
  });
});

describe("compareSemver", () => {
  it("a > b major", () => assert.equal(compareSemver("3.0.0", "2.9.9"), 1));
  it("a > b minor", () => assert.equal(compareSemver("2.3.0", "2.2.9"), 1));
  it("a > b patch", () => assert.equal(compareSemver("2.2.2", "2.2.1"), 1));
  it("equal", () => assert.equal(compareSemver("2.2.1", "2.2.1"), 0));
  it("a < b", () => assert.equal(compareSemver("2.2.0", "2.2.1"), -1));
  it("handles v prefix", () => assert.equal(compareSemver("v2.3.0", "v2.2.1"), 1));
});

describe("findLatestTag", () => {
  it("finds highest semver", () => {
    const tags = [{ name: "v1.0.0" }, { name: "v2.2.1" }, { name: "v2.3.0" }, { name: "v2.1.0" }];
    assert.equal(findLatestTag(tags), "v2.3.0");
  });
  it("ignores non-semver", () => {
    const tags = [{ name: "v2.2.1" }, { name: "latest" }, { name: "nightly" }];
    assert.equal(findLatestTag(tags), "v2.2.1");
  });
  it("returns null for empty", () => {
    assert.equal(findLatestTag([]), null);
  });
});
