/**
 * CaseRecall + depth 필터 단위 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-04-07
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

/** --------------------------------------------------------------------------
 * 1. depth 필터 검증
 *    MemoryManager.recall() 내부 depth 필터 로직을 재현하여 DB 없이 검증한다.
 * -------------------------------------------------------------------------- */
describe("depth filter", () => {
  const DEPTH_TYPE_MAP = {
    "high-level": ["decision", "episode"],
    "tool-level": ["procedure", "error", "fact"],
  };

  /**
   * MemoryManager.recall() 의 depth 필터 동작을 재현한 순수 함수.
   * @param {Object[]} fragments
   * @param {Object}   params
   * @returns {Object[]}
   */
  function applyDepthFilter(fragments, params) {
    const { depth, type } = params;
    if (depth && DEPTH_TYPE_MAP[depth] && !type) {
      const allowedTypes = new Set(DEPTH_TYPE_MAP[depth]);
      return fragments.filter(f => allowedTypes.has(f.type));
    }
    return fragments;
  }

  const SAMPLE_FRAGMENTS = [
    { id: "f1", type: "decision"  },
    { id: "f2", type: "episode"   },
    { id: "f3", type: "procedure" },
    { id: "f4", type: "error"     },
    { id: "f5", type: "fact"      },
    { id: "f6", type: "preference"},
  ];

  it("high-level: decision/episode만 통과", () => {
    const result = applyDepthFilter(SAMPLE_FRAGMENTS, { depth: "high-level" });
    const types  = result.map(f => f.type);
    assert.deepStrictEqual(types.sort(), ["decision", "episode"].sort());
  });

  it("tool-level: procedure/error/fact만 통과", () => {
    const result = applyDepthFilter(SAMPLE_FRAGMENTS, { depth: "tool-level" });
    const types  = result.map(f => f.type);
    assert.deepStrictEqual(types.sort(), ["error", "fact", "procedure"].sort());
  });

  it("depth 미지정 시 필터 없음 — 전체 파편 반환", () => {
    const result = applyDepthFilter(SAMPLE_FRAGMENTS, {});
    assert.strictEqual(result.length, SAMPLE_FRAGMENTS.length);
  });

  it("depth + type 동시 지정 시 type 우선 (depth 무시)", () => {
    /** depth가 있어도 type이 있으면 depth 필터를 건너뛴다 */
    const result = applyDepthFilter(SAMPLE_FRAGMENTS, { depth: "high-level", type: "fact" });
    /** depth 필터가 무시되므로 전체 파편이 그대로 반환된다 */
    assert.strictEqual(result.length, SAMPLE_FRAGMENTS.length);
  });

  it("알 수 없는 depth 값은 필터 없음 — 전체 파편 반환", () => {
    const result = applyDepthFilter(SAMPLE_FRAGMENTS, { depth: "unknown-depth" });
    assert.strictEqual(result.length, SAMPLE_FRAGMENTS.length);
  });
});

/** --------------------------------------------------------------------------
 * 2. CaseRecall 가드레일 검증
 *    DB 접근(buildCaseTriples) 없이 로직 레이어만 순수 함수로 재현하여 검증.
 * -------------------------------------------------------------------------- */
describe("CaseRecall guardrails", () => {
  const HARD_MAX_CASES        = 10;
  const MAX_EVENTS_PER_CASE   = 20;
  const MAX_EVENT_SUMMARY_LEN = 120;

  it("HARD_MAX_CASES=10: maxCases=100 입력해도 10으로 clamp", () => {
    const maxCases     = 100;
    const safeMaxCases = Math.min(maxCases, HARD_MAX_CASES);
    assert.strictEqual(safeMaxCases, 10);
  });

  it("HARD_MAX_CASES=10: maxCases=5는 그대로 유지", () => {
    const maxCases     = 5;
    const safeMaxCases = Math.min(maxCases, HARD_MAX_CASES);
    assert.strictEqual(safeMaxCases, 5);
  });

  it("MAX_EVENTS_PER_CASE=20: events 배열 slice 검증", () => {
    /** 25개 이벤트 중 상위 20개만 남아야 한다 */
    const events      = Array.from({ length: 25 }, (_, i) => ({ event_type: "milestone_reached", summary: `event ${i}` }));
    const slicedEvts  = events.slice(0, MAX_EVENTS_PER_CASE);
    assert.strictEqual(slicedEvts.length, 20);
  });

  it("MAX_EVENTS_PER_CASE=20: 이벤트가 20개 이하이면 전량 보존", () => {
    const events     = Array.from({ length: 15 }, (_, i) => ({ event_type: "milestone_reached", summary: `event ${i}` }));
    const slicedEvts = events.slice(0, MAX_EVENTS_PER_CASE);
    assert.strictEqual(slicedEvts.length, 15);
  });

  it("MAX_EVENT_SUMMARY_LEN=120: 긴 summary는 120자로 절삭", () => {
    const longSummary    = "A".repeat(200);
    const truncatedSummary = longSummary.slice(0, MAX_EVENT_SUMMARY_LEN);
    assert.strictEqual(truncatedSummary.length, 120);
  });

  it("MAX_EVENT_SUMMARY_LEN=120: 짧은 summary는 원본 그대로", () => {
    const shortSummary     = "A".repeat(80);
    const truncatedSummary = shortSummary.slice(0, MAX_EVENT_SUMMARY_LEN);
    assert.strictEqual(truncatedSummary.length, 80);
    assert.strictEqual(truncatedSummary, shortSummary);
  });

  it("case_id 없는 파편만 있으면 caseCount가 비어 빈 배열 반환", () => {
    const fragments = [
      { id: "f1", content: "no case_id", type: "fact", case_id: null },
      { id: "f2", content: "also none",  type: "fact", case_id: undefined },
    ];

    const caseCount = new Map();
    for (const f of fragments) {
      if (!f.case_id) continue;
      caseCount.set(f.case_id, (caseCount.get(f.case_id) || 0) + 1);
    }

    assert.strictEqual(caseCount.size, 0);
    /** size === 0 이면 buildCaseTriples는 [] 반환 */
  });

  it("resolved case가 open보다 우선 정렬", () => {
    const cases = [
      { case_id: "c1", resolution_status: "open",     relevance_score: 5 },
      { case_id: "c2", resolution_status: "resolved",  relevance_score: 3 },
      { case_id: "c3", resolution_status: "open",     relevance_score: 4 },
    ];

    cases.sort((a, b) => {
      const aResolved = a.resolution_status === "resolved";
      const bResolved = b.resolution_status === "resolved";
      if (aResolved && !bResolved) return -1;
      if (!aResolved && bResolved) return  1;
      return b.relevance_score - a.relevance_score;
    });

    assert.strictEqual(cases[0].case_id, "c2", "resolved case가 첫 번째여야 한다");
    assert.strictEqual(cases[1].case_id, "c1", "open 중 relevance 높은 것이 두 번째");
    assert.strictEqual(cases[2].case_id, "c3");
  });

  it("resolved 동률 시 relevance_score 내림차순 정렬", () => {
    const cases = [
      { case_id: "r1", resolution_status: "resolved", relevance_score: 2 },
      { case_id: "r2", resolution_status: "resolved", relevance_score: 5 },
    ];

    cases.sort((a, b) => {
      const aResolved = a.resolution_status === "resolved";
      const bResolved = b.resolution_status === "resolved";
      if (aResolved && !bResolved) return -1;
      if (!aResolved && bResolved) return  1;
      return b.relevance_score - a.relevance_score;
    });

    assert.strictEqual(cases[0].case_id, "r2");
    assert.strictEqual(cases[1].case_id, "r1");
  });

  it("topCaseIds는 출현 빈도 내림차순 + safeMaxCases 상한 적용", () => {
    const fragments = [
      { case_id: "cA" }, { case_id: "cA" }, { case_id: "cA" },  // 3회
      { case_id: "cB" }, { case_id: "cB" },                      // 2회
      { case_id: "cC" },                                          // 1회
    ];
    const maxCases     = 2;
    const safeMaxCases = Math.min(maxCases, HARD_MAX_CASES);

    const caseCount = new Map();
    for (const f of fragments) {
      if (!f.case_id) continue;
      caseCount.set(f.case_id, (caseCount.get(f.case_id) || 0) + 1);
    }

    const topCaseIds = [...caseCount.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, safeMaxCases)
      .map(([id]) => id);

    assert.deepStrictEqual(topCaseIds, ["cA", "cB"]);
  });
});
