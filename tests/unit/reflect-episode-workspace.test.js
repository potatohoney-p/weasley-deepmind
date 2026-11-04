import { after, mock, test } from "node:test";
import assert from "node:assert/strict";

// Keep provider, queue and milestone side effects out of this persistence-boundary
// regression. Reflection, remember normalization and fragment creation are real.
mock.module("../../lib/memory/embedding/MorphemeIndex.js", {
  namedExports: { MorphemeIndex: class {
    async tokenize() { return []; }
    async getOrRegisterEmbeddings() { return []; }
  } }
});
mock.module("../../lib/memory/processors/EpisodeContinuityService.js", {
  namedExports: { linkEpisodeMilestone: async () => {} }
});

const { ReflectProcessor } = await import("../../lib/memory/processors/ReflectProcessor.js");
const { MemoryRememberer } = await import("../../lib/memory/processors/MemoryRememberer.js");
const { FragmentFactory } = await import("../../lib/memory/write/FragmentFactory.js");
const { teardownTestResources, assertCleanShutdown } = await import("../_lifecycle.js");

const processors = [];
function harness({ useBatch = false, rememberError = null } = {}) {
  const saved = [];
  const calls = [];
  const index = {
    index: async () => {},
    clearWorkingMemory: mock.fn(async () => {})
  };
  const factory = new FragmentFactory();
  const store = { insert: async fragment => {
    saved.push(structuredClone(fragment));
    return fragment.id;
  } };
  const rememberer = new MemoryRememberer({
    store, index, factory,
    quotaChecker: { check: async () => {} },
    postProcessor: { run: async () => {} },
    conflictResolver: { autoLinkOnRemember: async () => {} },
    policyGatingEnabled: false
  });
  const processor = new ReflectProcessor({
    store, index, factory,
    sessionLinker: {
      consolidateSessionFragments: async () => null,
      autoLinkSessionFragments: async () => ({ linkSuggestions: [] })
    },
    remember: async params => {
      calls.push(params);
      if (rememberError) throw rememberError;
      return rememberer.remember(params);
    },
    batchRememberProcessor: useBatch ? { process: async ({ fragments }) => {
      saved.push(...structuredClone(fragments));
      return { results: fragments.map(f => ({ success: true, id: f.id })) };
    } } : undefined
  });
  processors.push(processor);
  return { processor, saved, calls, index };
}

const scopeCases = [
  ["explicit workspace", { workspace: "project-a" }, "project-a"],
  ["key default workspace", { _defaultWorkspace: "default-project" }, "default-project"],
  ["explicit overrides default", { workspace: "project-a", _defaultWorkspace: "default-project" }, "project-a"],
  ["null uses default", { workspace: null, _defaultWorkspace: "default-project" }, "default-project"],
  ["unscoped remains global", {}, null],
  ["empty value keeps existing nullish semantics", { workspace: "", _defaultWorkspace: "default-project" }, ""]
];

for (const [name, scope, expected] of scopeCases) {
  for (const generated of [false, true]) {
    test(`${name}: ${generated ? "generated" : "explicit"} narrative retains reflection workspace`, async () => {
      const h = harness({ useBatch: generated });
      const params = {
        sessionId: "workspace-session", agentId: "workspace-agent", _keyId: "key-a",
        summary: ["The team confirmed the release validation plan."],
        ...(!generated ? { narrative_summary: "The release validation was completed in this project." } : {}),
        ...scope
      };
      const result = await h.processor.process(params);
      await h.processor.drainMorpheme();
      const episode = h.saved.find(f => f.type === "episode");
      assert.ok(episode);
      assert.equal(episode.workspace, expected);
      assert.ok(h.saved.every(f => f.workspace === expected), "ordinary fragments and episode share scope");
      assert.equal(episode.key_id, "key-a");
      assert.equal(episode.agent_id, "workspace-agent");
      assert.equal(episode.session_id, "workspace-session");
      assert.equal(episode.source, "session:workspace-session");
      assert.equal(h.calls[0].skipConflictDetection, true);
      assert.equal(h.calls[0].workspace ?? null, expected);
      assert.equal(result.breakdown.episode, 1);
      assert.equal(h.index.clearWorkingMemory.mock.callCount(), 1);
    });
  }
}

test("narrative-only reflection passes workspace without ordinary fragments or a session", async () => {
  const h = harness();
  const result = await h.processor.process({
    narrative_summary: "A standalone narrative was explicitly scoped to the research project.",
    workspace: "research"
  });
  assert.equal(result.count, 0);
  assert.equal(result.breakdown.episode, 1);
  assert.equal(h.saved.length, 1);
  assert.equal(h.saved[0].workspace, "research");
  assert.equal(h.saved[0].session_id, "unknown");
  assert.equal(h.saved[0].key_id, null);
  assert.equal(h.index.clearWorkingMemory.mock.callCount(), 0);
});

test("empty reflection creates no episode", async () => {
  const h = harness();
  await h.processor.process({ sessionId: "empty", workspace: "research" });
  assert.deepEqual(h.saved, []);
  assert.deepEqual(h.calls, []);
});

test("episode persistence failure still propagates before session cleanup", async () => {
  const error = new Error("synthetic episode persistence failure");
  const h = harness({ rememberError: error });
  await assert.rejects(h.processor.process({
    narrative_summary: "The episode cannot be saved until storage recovers.",
    sessionId: "failed", _defaultWorkspace: "research"
  }), error);
  assert.equal(h.calls[0].workspace, "research");
  assert.equal(h.index.clearWorkingMemory.mock.callCount(), 0);
});

after(async () => {
  await Promise.all(processors.map(p => p.drainMorpheme()));
  await teardownTestResources();
  await assertCleanShutdown();
});
