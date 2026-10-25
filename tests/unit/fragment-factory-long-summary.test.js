import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { FragmentFactory } from "../../lib/memory/write/FragmentFactory.js";
import { teardownTestResources, assertCleanShutdown } from "../_lifecycle.js";

after(async () => {
  await teardownTestResources();
  await assertCleanShutdown();
});

const factory = new FragmentFactory();
const meta = { topic: "session_reflect", type: "fact" };

describe("FragmentFactory long summary preservation", () => {
  it("preserves the tail of a long sentence used by reflect", () => {
    const text = `${"The worker confirmed the queued operation ".repeat(20)}FINAL VERIFIED OUTCOME`;
    const fragments = factory.splitAndCreate(text, meta);
    assert.equal(fragments.map(f => f.content).join(" "), text);
    assert.ok(fragments.every(f => f.content.length <= 300));
    assert.ok(fragments.at(-1).content.endsWith("FINAL VERIFIED OUTCOME"));
  });

  it("preserves long unbroken Unicode text without splitting surrogate pairs", () => {
    const text = "검증😀".repeat(170);
    const fragments = factory.splitAndCreate(text, meta);
    assert.equal(fragments.map(f => f.content).join(""), text);
    assert.ok(fragments.every(f => f.content.length <= 300 && f.content.isWellFormed()));
  });

  it("does not create an invalid short tail at the fragment boundary", () => {
    for (const length of [301, 302, 309, 601]) {
      const text = "가".repeat(length);
      const fragments = factory.splitAndCreate(text, meta);
      assert.equal(fragments.map(f => f.content).join(""), text);
      assert.ok(fragments.every(f => f.content.length >= 10 && f.content.length <= 300));
    }
  });

  it("keeps a short final word after whitespace without rejecting the summary", () => {
    const text = `${"x".repeat(300)} final`;
    const fragments = factory.splitAndCreate(text, meta);
    assert.equal(fragments.map(f => f.content).join(""), text);
  });

  it("redacts before splitting a secret across a chunk boundary", () => {
    const text = `${"x".repeat(290)} sk-${"a".repeat(40)} ${"tail ".repeat(30)}`.trim();
    const fragments = factory.splitAndCreate(text, meta);
    const output = fragments.map(f => f.content).join(" ");
    assert.ok(output.includes("[REDACTED_API_KEY]"));
    assert.ok(!output.includes("sk-") && !output.includes("a".repeat(20)));
    assert.ok(output.endsWith("tail"));
  });

  it("preserves the existing policy for URL-bearing sentences", () => {
    for (const text of [
      `${"x".repeat(290)} https://example.com/review`,
      `https://example.com/${"x".repeat(300)} deployment evidence`,
    ]) {
      const fragments = factory.splitAndCreate(text, meta);
      assert.equal(fragments.length, 1);
      assert.equal(fragments[0].content, factory.create({ content: text, ...meta }).content);
    }
    assert.throws(() => factory.splitAndCreate(`https://example.com/${"x".repeat(400)}`, meta), /URL-only/);
  });

  it("normalizes before redaction so masking cannot expand a finished chunk", () => {
    const text = `${"x".repeat(284)} 010\t\t1234\t\t5678 ${"y".repeat(50)}`;
    const output = factory.splitAndCreate(text, meta).map(f => f.content);
    assert.equal(output.join(" "), `${"x".repeat(284)} [REDACTED_PHONE] ${"y".repeat(50)}`);
    assert.ok(output.every(content => content.length <= 300));
  });

  it("keeps masked chunks stable when reflect creates them again", () => {
    const text = `${"x".repeat(280)} 010\t\t1234\t\t5678 END password:example-value ${"y".repeat(100)}`;
    for (const fragment of factory.splitAndCreate(text, meta)) {
      assert.equal(factory.create({ content: fragment.content, ...meta }).content, fragment.content);
      assert.ok(!fragment.content.includes("example-value") && !fragment.content.includes("1234"));
    }
  });

  it("keeps ordinary sentence packing and backward sequential links", () => {
    const fragments = factory.splitAndCreate(`${"A".repeat(200)}. ${"B".repeat(200)}.`, meta);
    assert.equal(fragments.length, 2);
    assert.deepEqual(fragments[0].linked_to, []);
    assert.deepEqual(fragments[1].linked_to, [fragments[0].id]);
  });
});
