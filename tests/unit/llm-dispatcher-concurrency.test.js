/**
 * Unit tests: LLM Dispatcher — Provider-level Concurrency Control
 *
 * 작성자: 최진호
 * 작성일: 2026-04-24
 * 수정일: 2026-05-13
 *
 * `lib/llm/index.js`의 dispatcher 코어(`dispatchChain`)를 직접 호출하여
 * 세마포어 통합 분기를 검증한다. mock provider 배열과 deps(getSemaphoreFn,
 * getLimitFn, concurrencyEnabled, concurrencyWaitMs)를 주입하므로
 * buildChain·env·createProvider 의존성 없이 dispatcher 본체를 그대로 검증한다.
 */

import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

import { LlmProvider }                   from "../../lib/llm/LlmProvider.js";
import { dispatchChain }                 from "../../lib/llm/index.js";
import { resetSemaphores, getSemaphore } from "../../lib/llm/util/semaphore.js";
import { redisClient }                   from "../../lib/redis.js";

after(async () => {
  try { await redisClient.quit(); } catch (_) {}
});

beforeEach(() => {
  resetSemaphores();
});

/**
 * 테스트용 controllable provider.
 *
 * `dispatchChain`이 호출하는 메서드는 `provider.callJson(prompt, options)`이며
 * 객체를 그대로 반환한다.
 *
 * @param {string}  name
 * @param {object}  [opts]
 * @param {boolean} [opts.shouldFail=false]
 * @param {*}       [opts.responseValue={ok:true}]
 * @param {string}  [opts.baseUrl=""]
 * @param {string}  [opts.model=""]
 * @param {number}  [opts.holdMs=0]
 */
function createMockProvider(name, {
  shouldFail    = false,
  responseValue = { ok: true },
  baseUrl       = "",
  model         = "",
  holdMs        = 0
} = {}) {
  return Object.assign(Object.create(LlmProvider.prototype), {
    name,
    config    : { name, baseUrl: baseUrl || null, model: model || null },
    callCount : 0,
    async isAvailable()   { return true; },
    async isCircuitOpen() { return false; },
    async recordSuccess() {},
    async recordFailure() {},
    async callJson(_prompt, _options) {
      this.callCount++;
      if (holdMs > 0) await new Promise(r => setTimeout(r, holdMs));
      if (shouldFail) throw new Error(`${name}: simulated failure`);
      return responseValue;
    }
  });
}

/**
 * chainKey의 prefix로 mock semaphore를 라우팅하는 deps.getSemaphoreFn 빌더.
 * dispatchChain이 사용하는 buildChainKey 형식("name|baseUrl|model")의 앞부분으로
 * 매칭하므로 baseUrl/model 무관하게 동일 sem을 부여할 수 있다.
 */
function makeRoutingSemaphoreFn(map) {
  return (chainKey, limit, waitMs) => {
    for (const [prefix, sem] of map) {
      if (chainKey === prefix || chainKey.startsWith(prefix + "|")) return sem;
    }
    return getSemaphore(chainKey, limit, waitMs);
  };
}

// ---------------------------------------------------------------------------
// a. concurrencyEnabled=false: semaphore not used, all calls pass through
// ---------------------------------------------------------------------------
describe("dispatcher: concurrency disabled", () => {
  it("calls pass through without semaphore when concurrencyEnabled=false", async () => {
    const p1 = createMockProvider("gemini-cli");
    const result = await dispatchChain([p1], "test", {}, { concurrencyEnabled: false });
    assert.deepEqual(result, { ok: true });
    assert.equal(p1.callCount, 1);
  });

  it("multiple concurrent calls all succeed without semaphore throttling", async () => {
    const p1 = createMockProvider("ollama", { holdMs: 30 });
    const results = await Promise.all([
      dispatchChain([p1], "t1", {}, { concurrencyEnabled: false }),
      dispatchChain([p1], "t2", {}, { concurrencyEnabled: false }),
      dispatchChain([p1], "t3", {}, { concurrencyEnabled: false })
    ]);
    assert.equal(results.length, 3);
    assert.equal(p1.callCount, 3);
  });
});

// ---------------------------------------------------------------------------
// b. limit=2, 3 동시 호출 — 3번째는 슬롯 반환을 기다렸다가 진입
// ---------------------------------------------------------------------------
describe("dispatcher: limit=2, 3 concurrent calls", () => {
  it("third call proceeds after one of the first two finishes", async () => {
    const order = [];
    const p1    = createMockProvider("ollama", { holdMs: 80 });

    /** chainKey 형식 무관하게 단일 sem을 부여하여 동시 한도를 강제 */
    const sharedSem      = getSemaphore("test:ollama-limit2", 2, 5000);
    const getSemaphoreFn = makeRoutingSemaphoreFn(new Map([["ollama", sharedSem]]));
    const getLimitFn     = () => 2;

    const calls = [
      dispatchChain([p1], "r1", {}, { concurrencyEnabled: true, concurrencyWaitMs: 5000, getSemaphoreFn, getLimitFn })
        .then(r => { order.push("r1"); return r; }),
      dispatchChain([p1], "r2", {}, { concurrencyEnabled: true, concurrencyWaitMs: 5000, getSemaphoreFn, getLimitFn })
        .then(r => { order.push("r2"); return r; }),
      dispatchChain([p1], "r3", {}, { concurrencyEnabled: true, concurrencyWaitMs: 5000, getSemaphoreFn, getLimitFn })
        .then(r => { order.push("r3"); return r; })
    ];

    await Promise.all(calls);

    assert.equal(p1.callCount, 3);
    assert.equal(order.length, 3);
  });
});

// ---------------------------------------------------------------------------
// c. limit=1, waitMs=50: primary 슬롯이 점유되어 timeout → fallback 진입
// ---------------------------------------------------------------------------
describe("dispatcher: timeout triggers fallback", () => {
  it("times out on primary (limit=1, held), falls back to secondary", async () => {
    const primary   = createMockProvider("ollama",     { holdMs: 200 });
    const secondary = createMockProvider("gemini-cli", { responseValue: { fallback: true } });

    const ollamaSem    = getSemaphore("test:ollama-fb", 1, 50);
    const geminiSem    = getSemaphore("test:gemini-fb", 10, 5000);
    const getSemaphoreFn = makeRoutingSemaphoreFn(new Map([
      ["ollama",     ollamaSem],
      ["gemini-cli", geminiSem]
    ]));
    const getLimitFn = (_chainKey, name) => name === "ollama" ? 1 : 10;

    /** primary 슬롯을 외부에서 점유하여 dispatcher가 50ms timeout으로 fallback하도록 강제 */
    await ollamaSem.acquire();

    try {
      const result = await dispatchChain(
        [primary, secondary],
        "test",
        {},
        { concurrencyEnabled: true, concurrencyWaitMs: 50, getSemaphoreFn, getLimitFn }
      );
      assert.deepEqual(result, { fallback: true }, "should fallback to gemini-cli");
      assert.equal(primary.callCount,   0, "primary callJson should NOT have been called");
      assert.equal(secondary.callCount, 1, "secondary should have been called");
    } finally {
      ollamaSem.release();
    }
  });
});

// ---------------------------------------------------------------------------
// d. baseUrl이 다른 provider는 독립 chain key → 독립 semaphore
// ---------------------------------------------------------------------------
describe("dispatcher: independent semaphores for different baseUrls", () => {
  it("providers with different baseUrl use independent semaphores", async () => {
    const provA = createMockProvider("openai", { baseUrl: "https://provider-a.example.com", holdMs: 50 });
    const provB = createMockProvider("openai", { baseUrl: "https://provider-b.example.com", holdMs: 50 });

    const getLimitFn = () => 1;

    /** deps.getSemaphoreFn 미주입 — 실제 getSemaphore + buildChainKey 형식이 자연스럽게 분리되는지 검증 */
    const start = Date.now();
    await Promise.all([
      dispatchChain([provA], "pA", {}, { concurrencyEnabled: true, concurrencyWaitMs: 5000, getLimitFn }),
      dispatchChain([provB], "pB", {}, { concurrencyEnabled: true, concurrencyWaitMs: 5000, getLimitFn })
    ]);
    const elapsed = Date.now() - start;

    assert.ok(elapsed < 150, `elapsed ${elapsed}ms suggests semaphores were NOT independent`);
    assert.equal(provA.callCount, 1);
    assert.equal(provB.callCount, 1);
  });

  it("same baseUrl/model providers share a semaphore instance", () => {
    const sem1 = getSemaphore("openai|https://same.example.com|gpt-4", 5, 1000);
    const sem2 = getSemaphore("openai|https://same.example.com|gpt-4", 5, 1000);
    assert.strictEqual(sem1, sem2);
  });
});
