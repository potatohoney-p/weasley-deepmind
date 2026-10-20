import assert from "node:assert/strict";

const [mode, modelId] = process.argv.slice(2);
const payload = JSON.stringify({ model_type: "bert", hidden_size: 8, cache_probe: modelId });
let syntheticFetches = 0;

// Never call the real fetch: this fixture contains no model weights or inference.
globalThis.fetch = async url => {
  assert.equal(mode, "seed", "offline reuse must not request any remote file");
  assert.equal(String(url), `https://huggingface.co/${modelId}/resolve/main/config.json`);
  syntheticFetches++;
  return new globalThis.Response(payload, {
    headers: { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(payload)) }
  });
};

const { AutoConfig, env } = await import("@huggingface/transformers");
if (mode === "seed") env.allowLocalModels = false;
else env.allowRemoteModels = false;

const config = await AutoConfig.from_pretrained(modelId, { local_files_only: mode !== "seed" });
assert.equal(config.cache_probe, modelId);
assert.equal(syntheticFetches, mode === "seed" ? 1 : 0);
console.log(JSON.stringify({ cacheDir: env.cacheDir, version: env.version, syntheticFetches }));
