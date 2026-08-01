/**
 * _ratelimit-cache.js — Rate Limit 사용량 캐시 헬퍼
 *
 * 작성자: 최진호
 * 작성일: 2026-04-20
 *
 * QuotaChecker.getUsage를 래핑하는 경량 위임 함수.
 * QuotaChecker 내부 캐시(10초 TTL)를 그대로 활용하므로
 * 매 요청마다 DB를 조회하지 않는다.
 *
 * mcp-handler.js에서 import하여 응답 직전 헤더 주입에 사용한다.
 */

import { MemoryManager } from "../memory/MemoryManager.js";

/**
 * keyId에 대한 사용량을 캐시를 통해 반환한다.
 * QuotaChecker.getUsage에 10초 TTL 캐시가 내장되어 있으므로
 * 이 함수는 MemoryManager 싱글턴 경유 위임 래퍼로 동작한다.
 *
 * @param {string} keyId
 * @returns {Promise<{ limit: number|null, current: number, remaining: number|null, resetAt: null }|null>}
 */
export async function getRateLimitUsageCached(keyId) {
  const checker = MemoryManager.getInstance().quotaChecker;
  if (!checker) return null;
  return checker.getUsage(keyId);
}
