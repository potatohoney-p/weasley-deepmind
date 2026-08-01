/**
 * LLM Dispatcher 인라인 mirror 재발 방지 가드
 *
 * 작성자: 최진호
 * 작성일: 2026-05-13
 *
 * `dispatchChain`을 추출하기 전, dispatcher 테스트는 `lib/llm/index.js`의 for-loop을
 * 복제한 인라인 함수를 검증했다. 인라인 mirror가 다시 도입되면 운영 코드가 깨져도
 * 단위 테스트가 통과하므로 그 회귀를 정적으로 차단한다.
 */

import { describe, it } from "node:test";
import assert            from "node:assert/strict";
import { readFileSync }  from "node:fs";
import { fileURLToPath } from "node:url";
import path              from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));

const dispatcherSource = readFileSync(
  path.resolve(here, "../../lib/llm/index.js"),
  "utf-8"
);
const testSource = readFileSync(
  path.resolve(here, "llm-dispatcher-concurrency.test.js"),
  "utf-8"
);

describe("LLM Dispatcher — 인라인 mirror 재발 방지", () => {

  it("lib/llm/index.js가 dispatchChain을 export한다", () => {
    assert.match(
      dispatcherSource,
      /export\s+async\s+function\s+dispatchChain\s*\(/,
      "dispatchChain export 함수가 존재해야 한다"
    );
  });

  it("llmJson 본문이 chain for-loop을 직접 들고 있지 않다", () => {
    /** llmJson 함수 본문에서 'for (const provider of chain)' 패턴 잔존 차단 */
    const llmJsonBody = dispatcherSource.match(
      /export\s+async\s+function\s+llmJson\s*\([\s\S]*?\n\}\n/
    );
    assert.ok(llmJsonBody, "llmJson 함수 본문을 찾을 수 없다");
    assert.doesNotMatch(
      llmJsonBody[0],
      /for\s*\(\s*const\s+provider\s+of\s+chain\s*\)/,
      "llmJson 본문에 chain for-loop이 남아 있으면 안 된다"
    );
    assert.match(
      llmJsonBody[0],
      /return\s+dispatchChain\s*\(/,
      "llmJson은 dispatchChain 호출로 위임해야 한다"
    );
  });

  it("dispatcher 테스트에 인라인 dispatchWithConcurrency 정의가 없다", () => {
    assert.doesNotMatch(
      testSource,
      /(async\s+)?function\s+dispatchWithConcurrency\s*\(/,
      "인라인 dispatchWithConcurrency 함수 정의는 잔존하면 안 된다"
    );
    assert.doesNotMatch(
      testSource,
      /Inline dispatcher that mirrors/i,
      "Inline dispatcher 주석은 잔존하면 안 된다"
    );
  });

  it("dispatcher 테스트가 실제 dispatchChain을 import한다", () => {
    assert.match(
      testSource,
      /import\s*\{[^}]*\bdispatchChain\b[^}]*\}\s*from\s*['"][^'"]*lib\/llm\/index\.js['"]/,
      "dispatchChain을 lib/llm/index.js에서 import해야 한다"
    );
  });

});
