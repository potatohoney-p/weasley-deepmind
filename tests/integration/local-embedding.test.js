/**
 * 로컬 transformers.js 임베딩 provider 통합 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-04-18
 *
 * 실행:
 *   E2E_LOCAL_EMBED=1 node --test tests/integration/local-embedding.test.js
 *
 * 전제:
 *   - @huggingface/transformers 설치됨
 *   - 최초 실행 시 ~/.cache/huggingface/에 모델 다운로드 (~120MB for e5-small)
 *   - 다운로드 후 cache hit으로 실행
 *
 * E2E_LOCAL_EMBED 미설정 시 전체 suite skip.
 */

import { describe, it, before } from "node:test";
import assert                   from "node:assert/strict";
import "./_cleanup.js";

const ENABLED  = process.env.E2E_LOCAL_EMBED === "1";
const MODEL_ID = "Xenova/multilingual-e5-small";
const DIMS     = 384;

/** cosine similarity (L2 정규화된 벡터 → dot product만으로 충분) */
const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);

describe("LocalTransformersEmbedder — 실제 모델 로드", { skip: !ENABLED, timeout: 300_000 }, () => {

  describe("Xenova/multilingual-e5-small (기본값)", () => {
    /** @type {import("../../lib/embeddings/LocalTransformersEmbedder.js").LocalTransformersEmbedder} */
    let embedder;

    before(async () => {
      const { getLocalEmbedder } = await import("../../lib/embeddings/LocalTransformersEmbedder.js");
      embedder = getLocalEmbedder(MODEL_ID, DIMS);
      await embedder.init();   // 모델 다운로드/로드 비용을 before 단계에서 흡수
    });

    it("pipeline 로드 후 embed 호출이 384차원 배열을 반환한다", async () => {
      const vec = await embedder.embed("테스트 문장입니다");
      assert.ok(Array.isArray(vec),                          "반환값이 Array여야 한다");
      assert.strictEqual(vec.length, DIMS,                   `벡터 차원이 ${DIMS}이어야 한다`);
      assert.ok(vec.every(v => typeof v === "number"),       "모든 원소가 number여야 한다");
      assert.ok(vec.every(v => isFinite(v)),                 "NaN/Infinity 원소 없어야 한다");
    });

    it("동일 텍스트 두 번 embed 시 벡터가 동일하다 (결정성)", async () => {
      const text = "결정성 검증용 문장";
      const vec1 = await embedder.embed(text);
      const vec2 = await embedder.embed(text);
      assert.deepStrictEqual(vec1, vec2, "동일 입력은 동일 벡터를 반환해야 한다");
    });

    it("한국어/영어 혼합 텍스트도 정상 처리된다", async () => {
      const vec = await embedder.embed("서울에서 Seoul까지 KTX로 2 hours 40 minutes");
      assert.ok(Array.isArray(vec),          "혼합 언어 입력 시 Array 반환이어야 한다");
      assert.strictEqual(vec.length, DIMS,   "혼합 언어 입력 시 차원이 유지되어야 한다");
      assert.ok(vec.every(v => isFinite(v)), "혼합 언어 입력 시 유한한 값이어야 한다");
    });

    it("반환 벡터의 L2 norm이 1.0에 근접한다 (정규화 확인)", async () => {
      const vec  = await embedder.embed("L2 norm 정규화 검증 문장");
      const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
      assert.ok(
        Math.abs(norm - 1.0) < 0.01,
        `L2 norm이 1.0에 근접해야 한다 (실측: ${norm.toFixed(6)})`
      );
    });
  });

  describe("차원 가드", () => {
    it("modelId=e5-small, dimensions=1024 지정 시 차원 불일치 에러 throw", async () => {
      const { LocalTransformersEmbedder } = await import("../../lib/embeddings/LocalTransformersEmbedder.js");
      const badEmbedder = new LocalTransformersEmbedder({ modelId: MODEL_ID, dimensions: 1024 });
      await assert.rejects(
        () => badEmbedder.embed("차원 불일치 테스트"),
        /dim mismatch/,
        "차원이 다를 때 dim mismatch 에러가 발생해야 한다"
      );
    });
  });

  describe("싱글톤 캐싱", () => {
    it("같은 modelId로 getLocalEmbedder 두 번 호출 시 동일 인스턴스 반환", async () => {
      const { getLocalEmbedder } = await import("../../lib/embeddings/LocalTransformersEmbedder.js");
      const inst1 = getLocalEmbedder(MODEL_ID, DIMS);
      const inst2 = getLocalEmbedder(MODEL_ID, DIMS);
      assert.strictEqual(inst1, inst2, "동일 modelId에 대해 동일 인스턴스여야 한다");
    });
  });

  describe("생성된 벡터 품질 스팟 체크", () => {
    /** @type {import("../../lib/embeddings/LocalTransformersEmbedder.js").LocalTransformersEmbedder} */
    let embedder;

    before(async () => {
      const { getLocalEmbedder } = await import("../../lib/embeddings/LocalTransformersEmbedder.js");
      embedder = getLocalEmbedder(MODEL_ID, DIMS);
      await embedder.init();
    });

    it("유사한 두 문장의 cosine similarity가 무관한 두 문장보다 높다", async () => {
      const vec1 = await embedder.embed("고양이가 나무 위에 있다");
      const vec2 = await embedder.embed("나무에 고양이가 올라갔다");
      const vec3 = await embedder.embed("자동차 엔진 오일 교환 시기");

      const simSimilar   = dot(vec1, vec2);
      const simUnrelated = dot(vec1, vec3);

      assert.ok(
        simSimilar > simUnrelated,
        `유사 문장 유사도(${simSimilar.toFixed(4)}) > 무관 문장 유사도(${simUnrelated.toFixed(4)}) 이어야 한다`
      );
    });
  });
});
