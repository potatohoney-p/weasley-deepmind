/**
 * 공통 유틸리티 — CORS, 워커 참조 저장소, Consolidator 실행 기록
 *
 * 작성자: 최진호
 * 작성일: 2026-04-04
 */

import { ALLOWED_ORIGINS, OAUTH_TRUSTED_ORIGINS, STRICT_ORIGIN } from "../config.js";

/**
 * 워커 참조 저장소 — server.js에서 setWorkerRefs()로 주입
 *
 * embeddingWorkerRef는 { current: EmbeddingWorker|null } 형태의 참조 객체를 받아
 * 비동기 초기화 후에도 최신 인스턴스에 접근할 수 있도록 한다.
 */
export const workerRefs = {
  embeddingWorkerRef: null,
  lastConsolidateRun: null
};

/**
 * 외부에서 워커 참조를 주입하는 setter
 * @param {object} refs
 * @param {object|null} refs.embeddingWorkerRef - { current: EmbeddingWorker|null } 참조 객체
 */
export function setWorkerRefs(refs) {
  if (refs.embeddingWorkerRef !== undefined) workerRefs.embeddingWorkerRef = refs.embeddingWorkerRef;
}

/**
 * Consolidator 마지막 실행 시각을 기록 — scheduler.js에서 호출
 */
export function recordConsolidateRun() {
  workerRefs.lastConsolidateRun = new Date().toISOString();
}

/**
 * CORS Origin 검증 — ALLOWED_ORIGINS 화이트리스트 기반
 * 화이트리스트 미설정(빈 Set) 시 모든 Origin 허용 (하위 호환)
 * 화이트리스트 설정 시 미등록 Origin에 "null" 반환
 */
export function getAllowedOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return "*";
  if (ALLOWED_ORIGINS.size === 0) return origin;
  return ALLOWED_ORIGINS.has(origin) ? origin : "null";
}

/**
 * Origin 헤더 허용 여부 검증 (DNS rebinding 방어)
 *
 * MCP_STRICT_ORIGIN=true 인 경우에만 적용 (opt-in).
 * - Origin 헤더 없음(CLI/curl): 항상 허용
 * - STRICT_ORIGIN=false(기본): 항상 허용 (기존 동작 유지)
 * - STRICT_ORIGIN=true: 허용 목록(신뢰 도메인 + ALLOWED_ORIGINS)에 있는 Origin만 허용
 *
 * @param {import("node:http").IncomingMessage} req
 * @returns {boolean}
 */
export function isOriginAllowed(req) {
  const origin = req.headers.origin;
  if (!origin)        return true;
  if (!STRICT_ORIGIN) return true;

  const allowlist = new Set([
    "https://claude.ai",
    "https://chatgpt.com",
    "https://platform.openai.com",
    ...OAUTH_TRUSTED_ORIGINS,
    ...ALLOWED_ORIGINS
  ]);

  return allowlist.has(origin);
}
