/**
 * feedbackFactor.js — tool_feedback 기반 importance 보정 계수 결정
 *
 * 작성자: 최진호
 * 작성일: 2026-06-15
 */

const POSITIVE_FACTOR = 1.1;
const NEGATIVE_FACTOR = 0.85;
const MIXED_FACTOR    = 0.95;

/**
 * 세션별 tool_feedback 집계 결과로부터 importance 보정 계수를 반환한다.
 *
 * @param {boolean} allRelevant   - 해당 세션의 모든 피드백이 relevant=true
 * @param {boolean} allSufficient - 해당 세션의 모든 피드백이 sufficient=true
 * @returns {number} 보정 계수 (0.85 | 0.95 | 1.1)
 */
export function feedbackFactor(allRelevant, allSufficient) {
  if (!allRelevant)                         return NEGATIVE_FACTOR;
  if (allRelevant && allSufficient)         return POSITIVE_FACTOR;
  return MIXED_FACTOR;
}
