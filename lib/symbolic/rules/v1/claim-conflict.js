/**
 * Claim Conflict Rules v1 — Phase 3 실구현
 *
 * 작성자: 최진호
 * 작성일: 2026-04-15
 *
 * Phase 3: ClaimConflictDetector 를 통해 동일 (subject, predicate, object) 에서
 * positive ↔ negative 대립 쌍을 탐지한다.
 *
 * 이 모듈은 순수 함수 인터페이스만 제공하고 실제 SQL 호출은
 * ClaimStore → ClaimConflictDetector 체인이 담당한다.
 *
 * 사용 예:
 *   import { ClaimConflictDetector } from '../../ClaimConflictDetector.js';
 *   const detector = new ClaimConflictDetector();
 *   const result   = await detectPolarityConflict({ fragmentId, keyId }, { detector });
 */

import { ClaimConflictDetector } from "../../ClaimConflictDetector.js";

/**
 * @param {{ fragmentId: string, keyId?: string|null, minConfidence?: number }} input
 * @param {{ detector?: ClaimConflictDetector }} [deps]
 * @returns {Promise<import('../../ClaimConflictDetector.js').DetectionResult>}
 */
export async function detectPolarityConflict(input, deps = {}) {
  const detector = deps.detector || new ClaimConflictDetector();
  const { fragmentId, keyId = null, minConfidence } = input || {};
  return detector.detectPolarityConflicts(
    fragmentId,
    keyId,
    Number.isFinite(minConfidence) ? { minConfidence } : {}
  );
}
