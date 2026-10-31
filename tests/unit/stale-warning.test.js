/**
 * stale-warning 단위 테스트 — computeStale fail-open 검증
 *
 * 작성자: Weasley Open Source
 * 작성일: 2026-06-09
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { computeStale } from "../../lib/memory/processors/MemoryRecaller.js";

const NOW = Date.parse("2026-06-08T00:00:00Z");

test("verified_at 없고 created_at이 오늘이면 stale 아님 (fail-open)", () => {
  const r = computeStale({ type: "error", created_at: "2026-06-08T00:00:00Z" }, NOW);
  assert.equal(r, null);
});

test("verified_at 없고 created_at도 없으면 판정 보류 (경고 없음)", () => {
  const r = computeStale({ type: "error" }, NOW);
  assert.equal(r, null);
});

test("verified_at 없을 때 created_at 기준으로 stale 판정", () => {
  const r = computeStale({ type: "error", created_at: "2026-01-01T00:00:00Z" }, NOW);
  assert.ok(r && r.stale === true);
  assert.ok(r.days_since_verification >= 60);
});

test("verified_at 우선 사용", () => {
  const r = computeStale({ type: "error", verified_at: "2026-06-07T00:00:00Z",
                           created_at: "2026-01-01T00:00:00Z" }, NOW);
  assert.equal(r, null);
});

test("invalid selected timestamps do not fabricate stale metadata", () => {
  for (const ref of ["not-a-date", "2026-99-99", new Date(NaN), Infinity]) {
    assert.equal(computeStale({ type: "error", verified_at: ref }, NOW), null);
  }
});

test("invalid verification timestamp does not fall back to an older creation date", () => {
  assert.equal(computeStale({ type: "error", verified_at: "unknown",
    created_at: "2020-01-01T00:00:00Z" }, NOW), null);
});

test("invalid creation timestamp without verification defers judgment", () => {
  assert.equal(computeStale({ type: "fact", created_at: "invalid" }, NOW), null);
});

test("non-finite clocks do not fabricate stale metadata", () => {
  for (const now of [NaN, Infinity, -Infinity]) {
    assert.equal(computeStale({ type: "error", verified_at: "2020-01-01" }, now), null);
  }
});

test("valid Date objects retain finite age", () => {
  const ref = new Date("2026-01-01T00:00:00Z");
  const result = computeStale({ type: "error", verified_at: ref }, NOW);
  assert.equal(result.days_since_verification, 158);
  assert.equal(result.stale, true);
});

test("future verification remains non-stale", () => {
  assert.equal(computeStale({ type: "error", verified_at: "2027-01-01" }, NOW), null);
});


test("stale threshold remains inclusive at exactly sixty days", () => {
  const ref = new Date(NOW - 60 * 86400000);
  assert.equal(computeStale({ type: "error", verified_at: ref }, NOW).days_since_verification, 60);
  assert.equal(computeStale({ type: "error", verified_at: new Date(+ref + 1) }, NOW), null);
});
