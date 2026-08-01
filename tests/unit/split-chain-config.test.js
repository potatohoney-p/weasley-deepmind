/**
 * Unit tests: split-stage LLM chain config resolution.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveSplitChainConfig } from "../../lib/config.js";

describe("resolveSplitChainConfig", () => {
  it("returns null when no split env is set", () => {
    assert.equal(resolveSplitChainConfig({}), null);
  });

  it("returns primary-only chain when only WEASLEY_DEEPMIND_SPLIT_LLM_PRIMARY is set", () => {
    assert.deepEqual(
      resolveSplitChainConfig({ WEASLEY_DEEPMIND_SPLIT_LLM_PRIMARY: "xai" }),
      [{ provider: "xai" }]
    );
  });

  it("merges primary in front of fallbacks", () => {
    const env = {
      WEASLEY_DEEPMIND_SPLIT_LLM_PRIMARY  : "opencode-cli",
      WEASLEY_DEEPMIND_SPLIT_LLM_FALLBACKS: '[{"provider":"gemini-cli"}]'
    };
    assert.deepEqual(resolveSplitChainConfig(env), [
      { provider: "opencode-cli" },
      { provider: "gemini-cli" }
    ]);
  });

  it("returns null on malformed fallbacks JSON without throwing", () => {
    assert.equal(resolveSplitChainConfig({ WEASLEY_DEEPMIND_SPLIT_LLM_FALLBACKS: "{bad" }), null);
  });
});
