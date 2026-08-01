/**
 * Policy Rules v1 — Phase 4 Soft Gating
 *
 * 작성자: 최진호
 * 작성일: 2026-04-15
 *
 * PolicyRules를 rule-function 진입점으로 감싸 SymbolicOrchestrator 파이프라인에
 * 편입시킨다. remember 경로에서 검출된 위반은 fragment.validation_warnings에
 * 누적되며 store.insert 차단은 수행하지 않는다 (soft gating).
 */

import { PolicyRules } from "../../PolicyRules.js";

const rules = new PolicyRules();

/**
 * evaluatePolicy — 파편 하나에 대한 정책 검증.
 *
 * @param {Object} input - 검사 대상 fragment
 * @param {Object} _ctx  - 호출 컨텍스트 (현재 사용 안 함, signature 호환용)
 * @returns {Promise<{ violations: Array, ruleVersion: string }>}
 */
export async function evaluatePolicy(input, _ctx = {}) {
  const violations = rules.check(input || {});
  return { violations, ruleVersion: "v1" };
}
