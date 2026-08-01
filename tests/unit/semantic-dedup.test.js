/**
 * 시맨틱 중복 제거 (Phase D 2-1) 의사결정 로직 단위 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-03-28
 *
 * DB 없이 병합 결정 로직(앵커 보호, newer-wins, 링크 이전 방향)을 검증한다.
 */

import { test, describe } from "node:test";
import assert             from "node:assert/strict";

/**
 * 병합 결정 순수 함수 (MemoryConsolidator._semanticDedup 내부 로직 추출)
 *
 * @param {Object} fragA - 파편 A
 * @param {Object} fragB - 파편 B
 * @param {number} cosineSimilarity - 두 파편의 코사인 유사도
 * @returns {{ action: string, keepId?: string, oldId?: string, combinedAccess?: number }}
 */
function decideMerge(fragA, fragB, cosineSimilarity) {
  const COS_THRESHOLD = 0.92;

  if (cosineSimilarity < COS_THRESHOLD) {
    return { action: "skip", reason: "below_threshold" };
  }

  if (fragA.is_anchor || fragB.is_anchor) {
    return { action: "skip", reason: "anchor_protected" };
  }

  const dateA = new Date(fragA.created_at);
  const dateB = new Date(fragB.created_at);

  const keepId = dateA >= dateB ? fragA.id : fragB.id;
  const oldId  = dateA >= dateB ? fragB.id : fragA.id;

  const combinedAccess = (fragA.access_count || 0) + (fragB.access_count || 0);

  return { action: "merge", keepId, oldId, combinedAccess };
}

/**
 * 링크 이전 방향 결정 순수 함수
 *
 * @param {string} keepId - 유지할 파편 ID
 * @param {string} oldId  - 삭제할 파편 ID
 * @param {Array}  links  - 기존 링크 배열 [{from_id, to_id}]
 * @returns {Array} 이전할 링크 배열 [{from_id, to_id, original_from, original_to}]
 */
function computeLinkTransfers(keepId, oldId, links) {
  const transfers = [];

  for (const link of links) {
    if (link.from_id === oldId && link.to_id !== keepId) {
      transfers.push({
        from_id      : keepId,
        to_id        : link.to_id,
        original_from: oldId,
        original_to  : link.to_id,
        direction    : "from"
      });
    }
    if (link.to_id === oldId && link.from_id !== keepId) {
      transfers.push({
        from_id      : link.from_id,
        to_id        : keepId,
        original_from: link.from_id,
        original_to  : oldId,
        direction    : "to"
      });
    }
  }

  return transfers;
}

describe("semantic dedup - decideMerge", () => {
  const fragOld = {
    id          : "frag-old",
    created_at  : "2026-03-01T00:00:00Z",
    is_anchor   : false,
    access_count: 5
  };

  const fragNew = {
    id          : "frag-new",
    created_at  : "2026-03-20T00:00:00Z",
    is_anchor   : false,
    access_count: 3
  };

  test("cos < 0.92이면 병합 스킵", () => {
    const result = decideMerge(fragOld, fragNew, 0.91);
    assert.equal(result.action, "skip");
    assert.equal(result.reason, "below_threshold");
  });

  test("cos >= 0.92이면 병합 실행, newer wins", () => {
    const result = decideMerge(fragOld, fragNew, 0.95);
    assert.equal(result.action, "merge");
    assert.equal(result.keepId, "frag-new");
    assert.equal(result.oldId, "frag-old");
  });

  test("access_count 합산", () => {
    const result = decideMerge(fragOld, fragNew, 0.93);
    assert.equal(result.combinedAccess, 8);
  });

  test("fragA가 anchor이면 스킵", () => {
    const anchorFrag = { ...fragOld, is_anchor: true };
    const result = decideMerge(anchorFrag, fragNew, 0.95);
    assert.equal(result.action, "skip");
    assert.equal(result.reason, "anchor_protected");
  });

  test("fragB가 anchor이면 스킵", () => {
    const anchorFrag = { ...fragNew, is_anchor: true };
    const result = decideMerge(fragOld, anchorFrag, 0.95);
    assert.equal(result.action, "skip");
    assert.equal(result.reason, "anchor_protected");
  });

  test("양쪽 모두 anchor이면 스킵", () => {
    const anchorA = { ...fragOld, is_anchor: true };
    const anchorB = { ...fragNew, is_anchor: true };
    const result = decideMerge(anchorA, anchorB, 0.99);
    assert.equal(result.action, "skip");
    assert.equal(result.reason, "anchor_protected");
  });

  test("동일 시간이면 fragA 유지 (>= 비교)", () => {
    const sameTime = "2026-03-15T00:00:00Z";
    const a = { ...fragOld, created_at: sameTime };
    const b = { ...fragNew, created_at: sameTime };
    const result = decideMerge(a, b, 0.95);
    assert.equal(result.action, "merge");
    assert.equal(result.keepId, a.id);
    assert.equal(result.oldId, b.id);
  });

  test("access_count가 0이어도 정상 합산", () => {
    const a = { ...fragOld, access_count: 0 };
    const b = { ...fragNew, access_count: 0 };
    const result = decideMerge(a, b, 0.93);
    assert.equal(result.combinedAccess, 0);
  });

  test("access_count가 undefined/null이어도 NaN 방어", () => {
    const a = { ...fragOld, access_count: undefined };
    const b = { ...fragNew, access_count: null };
    const result = decideMerge(a, b, 0.93);
    assert.equal(result.combinedAccess, 0);
  });
});

describe("semantic dedup - computeLinkTransfers", () => {
  const keepId = "keep-1";
  const oldId  = "old-1";

  test("from_id 방향 링크 이전", () => {
    const links = [
      { from_id: oldId, to_id: "other-1" }
    ];
    const transfers = computeLinkTransfers(keepId, oldId, links);
    assert.equal(transfers.length, 1);
    assert.equal(transfers[0].from_id, keepId);
    assert.equal(transfers[0].to_id, "other-1");
    assert.equal(transfers[0].direction, "from");
  });

  test("to_id 방향 링크 이전", () => {
    const links = [
      { from_id: "other-2", to_id: oldId }
    ];
    const transfers = computeLinkTransfers(keepId, oldId, links);
    assert.equal(transfers.length, 1);
    assert.equal(transfers[0].from_id, "other-2");
    assert.equal(transfers[0].to_id, keepId);
    assert.equal(transfers[0].direction, "to");
  });

  test("keepId <-> oldId 자기참조 링크는 이전하지 않음", () => {
    const links = [
      { from_id: oldId, to_id: keepId },
      { from_id: keepId, to_id: oldId }
    ];
    const transfers = computeLinkTransfers(keepId, oldId, links);
    assert.equal(transfers.length, 0);
  });

  test("양방향 링크 모두 이전", () => {
    const links = [
      { from_id: oldId, to_id: "x" },
      { from_id: "y", to_id: oldId }
    ];
    const transfers = computeLinkTransfers(keepId, oldId, links);
    assert.equal(transfers.length, 2);

    const fromTransfer = transfers.find(t => t.direction === "from");
    assert.equal(fromTransfer.from_id, keepId);
    assert.equal(fromTransfer.to_id, "x");

    const toTransfer = transfers.find(t => t.direction === "to");
    assert.equal(toTransfer.from_id, "y");
    assert.equal(toTransfer.to_id, keepId);
  });

  test("oldId와 무관한 링크는 이전 대상 아님", () => {
    const links = [
      { from_id: "a", to_id: "b" }
    ];
    const transfers = computeLinkTransfers(keepId, oldId, links);
    assert.equal(transfers.length, 0);
  });
});
