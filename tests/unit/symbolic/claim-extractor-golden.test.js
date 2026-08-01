/**
 * ClaimExtractor 골든셋 정확도 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-04-15
 *
 * 20개 골든셋을 ClaimExtractor 로 돌려 polarity 일치율 >= 0.7 을 요구한다.
 * MorphemeIndex 는 Gemini CLI 의존성이 있으므로 stub 으로 대체하여
 * 단위 테스트 독립성을 유지한다 (Gemini 없는 CI 환경에서도 결정적 동작 보장).
 */

import { test, describe } from "node:test";
import assert              from "node:assert/strict";
import { readFileSync }    from "node:fs";
import { fileURLToPath }   from "node:url";
import path                from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.resolve(__dirname, "../../..");

const GOLDEN = JSON.parse(
  readFileSync(path.join(ROOT, "tests/fixtures/claim-golden-20.json"), "utf-8")
);

const { ClaimExtractor } = await import("../../../lib/symbolic/ClaimExtractor.js");

/** Gemini CLI 회피용 stub. 공백 분리 기반 단순 토큰화. */
class StubMorphemeIndex {
  async tokenize(text) {
    if (typeof text !== "string") return [];
    return text.toLowerCase()
      .replace(/[^\w\sㄱ-ㅎ가-힣]/g, " ")
      .split(/\s+/)
      .filter(w => w.length > 1)
      .slice(0, 10);
  }
}

describe("ClaimExtractor — 골든셋 20개", () => {

  test("골든셋 파일은 20개 항목이어야 한다", () => {
    assert.equal(GOLDEN.length, 20);
  });

  test("extract() 는 polarity 일치율 >= 70% 를 달성해야 한다", async () => {
    const extractor = new ClaimExtractor({ morphemeIndex: new StubMorphemeIndex() });

    let correct = 0;
    const mismatches = [];

    for (const item of GOLDEN) {
      const claims = await extractor.extract(item.content, item.topic);
      assert.ok(Array.isArray(claims) && claims.length > 0,
        `#${item.id} claim 배열이 비어있음`);

      const [c] = claims;
      assert.equal(c.extractor,   "morpheme-rule", `#${item.id} extractor 불일치`);
      assert.equal(c.ruleVersion, "v1",            `#${item.id} ruleVersion 불일치`);
      assert.ok(typeof c.subject  === "string",    `#${item.id} subject 누락`);
      assert.ok(typeof c.predicate === "string",   `#${item.id} predicate 누락`);
      assert.ok(["positive", "negative", "uncertain"].includes(c.polarity),
        `#${item.id} polarity 값 오류`);
      assert.ok(c.confidence >= 0 && c.confidence <= 1,
        `#${item.id} confidence 범위 오류`);

      if (c.polarity === item.expected.polarity) {
        correct += 1;
      } else {
        mismatches.push({
          id       : item.id,
          content  : item.content,
          expected : item.expected.polarity,
          actual   : c.polarity
        });
      }
    }

    const accuracy = correct / GOLDEN.length;
    if (accuracy < 0.7) {
      console.error("[claim-extractor-golden] mismatches:\n" +
        mismatches.map(m => ` - #${m.id} expected=${m.expected} actual=${m.actual} content="${m.content}"`).join("\n"));
    }
    assert.ok(accuracy >= 0.7,
      `polarity accuracy=${(accuracy*100).toFixed(1)}% (>=70% 요구)`);
  });

  test("빈 content 는 빈 배열 반환", async () => {
    const extractor = new ClaimExtractor({ morphemeIndex: new StubMorphemeIndex() });
    assert.deepEqual(await extractor.extract("",    "t"), []);
    assert.deepEqual(await extractor.extract("   ", "t"), []);
    assert.deepEqual(await extractor.extract(null,  "t"), []);
  });

  test("negative 마커는 positive 마커보다 우선 적용", async () => {
    const extractor = new ClaimExtractor({ morphemeIndex: new StubMorphemeIndex() });
    const [c] = await extractor.extract("Redis를 사용하지 않는다", "cache");
    assert.equal(c.polarity, "negative");
  });

  test("uncertain 마커는 모든 polarity 마커보다 최우선", async () => {
    const extractor = new ClaimExtractor({ morphemeIndex: new StubMorphemeIndex() });
    const [c] = await extractor.extract("아마도 Redis를 사용할 수도 있음", "cache");
    assert.equal(c.polarity, "uncertain");
  });
});
