/**
 * vLLM Provider (로컬 또는 원격 배포)
 *
 * baseUrl은 반드시 사용자가 직접 지정해야 한다.
 * 공식 엔드포인트가 없으므로 기본값이 없다.
 * baseUrl 미지정 시 isAvailable()=false로 체인에서 자동 제외된다.
 *
 * 작성자: 최진호
 * 작성일: 2026-04-16
 */

import { OpenAICompatibleProvider } from "./OpenAICompatibleProvider.js";

export class VllmProvider extends OpenAICompatibleProvider {
  /**
   * @param {object} config
   * @param {string}  config.model   - 사용할 모델명 (필수, 기본값 하드코딩 금지)
   * @param {string}  config.baseUrl - 반드시 필요 (예: http://localhost:8000/v1)
   * @param {string}  [config.apiKey] - vLLM은 API 키 선택 사항
   */
  constructor(config) {
    super({
      ...config,
      name: "vllm"
      // baseUrl: 기본값 없음 — 사용자 지정 필수
    });
  }

  /**
   * vLLM은 API 키 없이도 동작하므로 apiKey 체크를 제외한다.
   * baseUrl과 model만 필수.
   *
   * @returns {Promise<boolean>}
   */
  async isAvailable() {
    return Boolean(this.baseUrl && this.config.model);
  }
}
