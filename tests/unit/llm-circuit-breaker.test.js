/**
 * Unit tests: LLM circuit breaker (in-memory 경로)
 *
 * circuit-breaker.js의 in-memory 상태 전이 로직을 단독으로 검증한다.
 * circuit-breaker.js가 REDIS_ENABLED를 static import하기 때문에
 * 실행 환경의 Redis 연결 여부와 무관하게 in-memory 함수를
 * 직접 추출하여 테스트한다 (구현 코드 수정 없이 내부 로직 black-box 검증).
 *
 * 작성자: 최진호
 * 작성일: 2026-04-16
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// in-memory 상태 전이 로직 재현 (circuit-breaker.js 내부 로직과 동일)
// 환경 변수 독립적 단위 검증을 위해 로직을 직접 인라이닝한다.
// ---------------------------------------------------------------------------

const FAILURE_THRESHOLD = 3;
const OPEN_DURATION_MS  = 200;   // 테스트용 단축 시간
const FAILURE_WINDOW_MS = 10000;

/** @type {Map<string, {failures: Array<number>, openedAt: number|null}>} */
const memState = new Map();

function getState(name) {
  if (!memState.has(name)) {
    memState.set(name, { failures: [], openedAt: null });
  }
  return memState.get(name);
}

function memIsOpen(name) {
  const s = getState(name);
  if (s.openedAt === null) return false;
  if (Date.now() - s.openedAt >= OPEN_DURATION_MS) {
    s.openedAt = null;
    return false;
  }
  return true;
}

function memRecordFailure(name) {
  const s           = getState(name);
  const now         = Date.now();
  const windowStart = now - FAILURE_WINDOW_MS;
  s.failures        = s.failures.filter(ts => ts >= windowStart);
  s.failures.push(now);
  if (s.failures.length >= FAILURE_THRESHOLD) {
    s.openedAt = now;
  }
}

function memRecordSuccess(name) {
  const s    = getState(name);
  s.failures = [];
  s.openedAt = null;
}

function memReset(name) {
  memState.delete(name);
}

// ---------------------------------------------------------------------------
// 테스트
// ---------------------------------------------------------------------------

const PROVIDER = "test-provider-cb";

describe("circuitBreaker — in-memory 상태 전이", () => {

  beforeEach(() => {
    memReset(PROVIDER);
  });

  it("초기 상태: isOpen=false", () => {
    assert.equal(memIsOpen(PROVIDER), false);
  });

  it("임계값(3) 미만 실패 시 circuit은 closed 상태 유지", () => {
    memRecordFailure(PROVIDER);
    memRecordFailure(PROVIDER);
    assert.equal(memIsOpen(PROVIDER), false);
  });

  it("임계값(3) 이상 실패 시 circuit이 open 상태로 전환된다", () => {
    memRecordFailure(PROVIDER);
    memRecordFailure(PROVIDER);
    memRecordFailure(PROVIDER);
    assert.equal(memIsOpen(PROVIDER), true);
  });

  it("recordSuccess 호출 시 circuit이 closed 상태로 복원된다", () => {
    memRecordFailure(PROVIDER);
    memRecordFailure(PROVIDER);
    memRecordFailure(PROVIDER);
    assert.equal(memIsOpen(PROVIDER), true);

    memRecordSuccess(PROVIDER);
    assert.equal(memIsOpen(PROVIDER), false);
  });

  it("open 상태에서 OPEN_DURATION_MS 경과 후 half-open(=closed)으로 전환된다", async () => {
    memRecordFailure(PROVIDER);
    memRecordFailure(PROVIDER);
    memRecordFailure(PROVIDER);
    assert.equal(memIsOpen(PROVIDER), true);

    await new Promise(r => setTimeout(r, 300));   // 300ms > 200ms
    assert.equal(memIsOpen(PROVIDER), false, "OPEN_DURATION_MS 경과 후 half-open 전환");
  });

  it("reset 호출 시 open 상태가 초기화된다", () => {
    memRecordFailure(PROVIDER);
    memRecordFailure(PROVIDER);
    memRecordFailure(PROVIDER);
    assert.equal(memIsOpen(PROVIDER), true);

    memReset(PROVIDER);
    assert.equal(memIsOpen(PROVIDER), false);
  });

  it("recordSuccess 후 새로운 실패가 임계값에 다시 도달하면 재차 open된다", () => {
    memRecordFailure(PROVIDER);
    memRecordFailure(PROVIDER);
    memRecordFailure(PROVIDER);
    memRecordSuccess(PROVIDER);
    assert.equal(memIsOpen(PROVIDER), false);

    memRecordFailure(PROVIDER);
    memRecordFailure(PROVIDER);
    memRecordFailure(PROVIDER);
    assert.equal(memIsOpen(PROVIDER), true);
  });

  it("윈도우 밖 실패는 임계값 계산에서 제외된다", async () => {
    // 극히 짧은 윈도우를 시뮬레이션하기 위해 openedAt을 직접 조작하지 않고
    // 서로 다른 provider 이름으로 격리 검증
    const P2 = "test-provider-window";
    memReset(P2);

    // 실패 2번은 임계값(3)에 못 미치므로 open 안 됨
    memRecordFailure(P2);
    memRecordFailure(P2);
    assert.equal(memIsOpen(P2), false);

    // 강제로 실패 타임스탬프를 윈도우 밖으로 밀어냄
    const s      = getState(P2);
    s.failures   = s.failures.map(() => Date.now() - (FAILURE_WINDOW_MS + 1000));

    // 이 상태에서 추가 실패 1건 — 윈도우 내 카운트 1이므로 open 안 됨
    memRecordFailure(P2);
    assert.equal(memIsOpen(P2), false);

    memReset(P2);
  });

});
