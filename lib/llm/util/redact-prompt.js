/**
 * LLM 프롬프트 민감 데이터 마스킹
 *
 * 작성자: 최진호
 * 작성일: 2026-04-16
 *
 * lib/logger.js의 REDACT_PATTERNS + redactString을 단일 진실 공급원으로
 * 재사용(옵션 B)하여 패턴 중복을 제거한다.
 * LLM 프롬프트 특화 패턴(sk-ant-, sk-, gsk_ 등)은 EXTRA_LLM_PATTERNS로 보강한다.
 */

import { REDACT_PATTERNS, redactString } from "../../logger.js";

/** LLM 프롬프트 전용 추가 패턴 (logger.js 패턴으로 미포괄되는 API 키 형식) */
const EXTRA_LLM_PATTERNS = [
  { pattern: /\bsk-ant-[A-Za-z0-9_-]+/g,  replacement: "sk-ant-****" },
  { pattern: /\bsk-[A-Za-z0-9]{32,}/g,    replacement: "sk-****"     },
  { pattern: /\bgsk_[A-Za-z0-9_-]+/g,     replacement: "gsk_****"    }
];

// REDACT_PATTERNS export — 외부 모듈이 참조할 경우를 위해 재노출
export { REDACT_PATTERNS };

/**
 * 프롬프트 텍스트에서 민감 패턴을 마스킹한다.
 *
 * 1단계: lib/logger.js의 redactString으로 공통 패턴 처리
 * 2단계: EXTRA_LLM_PATTERNS으로 LLM 특화 패턴 추가 처리
 *
 * @param {string} text - 원본 프롬프트 텍스트
 * @returns {string}    - 마스킹된 텍스트
 */
export function redactPrompt(text) {
  if (!text || typeof text !== "string") return text;
  let result = redactString(text);
  for (const { pattern, replacement } of EXTRA_LLM_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}
