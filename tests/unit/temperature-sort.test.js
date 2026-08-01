import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("Temperature-weighted sorting", () => {
  const computeScore = (frag, now, config) => {
    let score = frag.importance || 0;
    const accessedAt = frag.accessed_at ? new Date(frag.accessed_at).getTime() : 0;
    const warmMs = (config.warmWindowDays || 7) * 86400000;

    if (now - accessedAt < warmMs) score += config.warmBoost || 0.2;
    if ((frag.access_count || 0) >= (config.highAccessThreshold || 5)) score += config.highAccessBoost || 0.15;
    if (frag.source === "learning_extraction") score += config.learningBoost || 0.3;
    return score;
  };

  const config = { warmWindowDays: 7, warmBoost: 0.2, highAccessBoost: 0.15, highAccessThreshold: 5, learningBoost: 0.3 };
  const now = Date.now();

  it("boosts recently accessed fragment above stale high-importance", () => {
    const recent = { importance: 0.5, accessed_at: new Date(now - 86400000), access_count: 8 };
    const stale  = { importance: 0.7, accessed_at: new Date(now - 30 * 86400000), access_count: 1 };
    assert.ok(computeScore(recent, now, config) > computeScore(stale, now, config));
  });

  it("boosts learning fragments above regular fragments", () => {
    const learning = { importance: 0.4, source: "learning_extraction", accessed_at: new Date(now - 86400000), access_count: 0 };
    const regular  = { importance: 0.6, source: null, accessed_at: new Date(now - 86400000), access_count: 0 };
    assert.ok(computeScore(learning, now, config) > computeScore(regular, now, config));
  });

  it("preserves importance order when temperature is equal", () => {
    const high = { importance: 0.8, accessed_at: new Date(now - 86400000), access_count: 0 };
    const low  = { importance: 0.3, accessed_at: new Date(now - 86400000), access_count: 0 };
    assert.ok(computeScore(high, now, config) > computeScore(low, now, config));
  });

  it("does not boost fragments outside warm window", () => {
    const old = { importance: 0.5, accessed_at: new Date(now - 30 * 86400000), access_count: 0 };
    const score = computeScore(old, now, config);
    assert.strictEqual(score, 0.5);
  });
});
