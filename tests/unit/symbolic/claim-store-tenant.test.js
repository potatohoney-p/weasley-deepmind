/**
 * ClaimStore tenant isolation 가드 단위 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-04-15
 *
 * 검증 대상:
 *  - insert: fragment.key_id ≠ ctx.keyId 이면 TENANT_ISOLATION_VIOLATION throw,
 *            DB query 가 실행되지 않아야 함
 *  - insert: master(NULL) 일관성 — fragment.key_id=null && ctx.keyId=null 통과
 *  - insert: tenant(TEXT) 일관성 — fragment.key_id='api-key-42' && ctx.keyId='api-key-42' 통과
 *  - getByFragmentId / deleteByFragmentId / findPolarityConflicts SQL 에 금지 패턴
 *            (`key_id IS NULL OR`) 없음 확인
 *  - findPolarityConflicts SQL 의 threshold 바인딩 파라미터 전달 확인
 */

import { test, describe, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

/** db.js / logger.js 를 import 이전에 mock 등록 */
const mockQuery = mock.fn(async () => ({ rowCount: 0, rows: [] }));
const mockPool  = { query: mockQuery };

mock.module("../../../lib/tools/db.js", {
  namedExports: { getPrimaryPool: () => mockPool }
});
mock.module("../../../lib/logger.js", {
  namedExports: {
    logWarn : mock.fn(),
    logInfo : mock.fn(),
    logError: mock.fn()
  }
});

const { ClaimStore, TENANT_ISOLATION_VIOLATION } = await import("../../../lib/symbolic/ClaimStore.js");

const makeClaim = (over = {}) => ({
  subject    : "redis",
  predicate  : "사용",
  object     : "cache",
  polarity   : "positive",
  confidence : 0.75,
  extractor  : "morpheme-rule",
  ruleVersion: "v1",
  ...over
});

describe("ClaimStore — tenant isolation 가드", () => {
  beforeEach(() => mockQuery.mock.resetCalls());

  test("insert: fragment.key_id 와 ctx.keyId 불일치면 TENANT_ISOLATION_VIOLATION throw", async () => {
    const store = new ClaimStore();
    await assert.rejects(
      () => store.insert(
        { id: "frag-1", key_id: "api-key-A" },
        [makeClaim()],
        { keyId: "api-key-B" }
      ),
      (err) => err instanceof Error && err.message === TENANT_ISOLATION_VIOLATION
    );
    assert.equal(mockQuery.mock.callCount(), 0,
      "cross-tenant write 는 DB 쿼리가 실행되지 않아야 함");
  });

  test("insert: master(NULL) 일관 통과 — fragment.key_id=null, ctx.keyId=null", async () => {
    mockQuery.mock.mockImplementationOnce(async () => ({ rowCount: 1 }));
    const store = new ClaimStore();
    const n = await store.insert(
      { id: "frag-master", key_id: null },
      [makeClaim()],
      { keyId: null }
    );
    assert.equal(n, 1);
    assert.equal(mockQuery.mock.callCount(), 1);

    const [sql, params] = mockQuery.mock.calls[0].arguments;
    assert.match(sql, /INSERT INTO agent_memory\.fragment_claims/);
    assert.equal(params[0], "frag-master");
    assert.equal(params[1], null, "master key 는 key_id=NULL 저장");
  });

  test("insert: undefined 도 null 로 정규화되어 master 로 통과", async () => {
    mockQuery.mock.mockImplementationOnce(async () => ({ rowCount: 1 }));
    const store = new ClaimStore();
    const n = await store.insert(
      { id: "frag-u", key_id: undefined },
      [makeClaim()],
      { keyId: undefined }
    );
    assert.equal(n, 1);
  });

  test("insert: tenant 일관 통과 — fragment.key_id='api-key-42', ctx.keyId='api-key-42'", async () => {
    mockQuery.mock.mockImplementationOnce(async () => ({ rowCount: 2 }));
    const store = new ClaimStore();
    const n = await store.insert(
      { id: "frag-t", key_id: "api-key-42" },
      [makeClaim(), makeClaim({ polarity: "negative" })],
      { keyId: "api-key-42" }
    );
    assert.equal(n, 2);

    const [, params] = mockQuery.mock.calls[0].arguments;
    assert.equal(params[0], "frag-t");
    assert.equal(params[1], "api-key-42");
  });

  test("insert: master fragment 에 tenant ctx 쓰기 시도 차단", async () => {
    const store = new ClaimStore();
    await assert.rejects(
      () => store.insert(
        { id: "frag-master", key_id: null },
        [makeClaim()],
        { keyId: "api-key-X" }
      ),
      (err) => err.message === TENANT_ISOLATION_VIOLATION
    );
    assert.equal(mockQuery.mock.callCount(), 0);
  });

  test("insert: tenant fragment 에 master ctx 쓰기 시도 차단", async () => {
    const store = new ClaimStore();
    await assert.rejects(
      () => store.insert(
        { id: "frag-t", key_id: "api-key-42" },
        [makeClaim()],
        { keyId: null }
      ),
      (err) => err.message === TENANT_ISOLATION_VIOLATION
    );
    assert.equal(mockQuery.mock.callCount(), 0);
  });

  test("insert: 빈 claims 는 no-op", async () => {
    const store = new ClaimStore();
    const n = await store.insert({ id: "frag-1", key_id: null }, [], { keyId: null });
    assert.equal(n, 0);
    assert.equal(mockQuery.mock.callCount(), 0);
  });

  test("getByFragmentId SQL 은 IS NOT DISTINCT FROM 격리 패턴을 사용하고 금지 패턴을 쓰지 않는다", async () => {
    mockQuery.mock.mockImplementationOnce(async () => ({ rows: [{ id: 1 }] }));
    const store = new ClaimStore();
    await store.getByFragmentId("frag-1", "api-key-5");
    const [sql, params] = mockQuery.mock.calls[0].arguments;
    assert.match(sql, /key_id IS NOT DISTINCT FROM \$2/);
    assert.ok(!/key_id IS NULL OR/.test(sql), "금지 패턴 (key_id IS NULL OR) 사용 불가");
    assert.deepEqual(params, ["frag-1", "api-key-5"]);
  });

  test("deleteByFragmentId SQL 은 IS NOT DISTINCT FROM 격리 패턴을 사용", async () => {
    mockQuery.mock.mockImplementationOnce(async () => ({ rowCount: 3 }));
    const store = new ClaimStore();
    const n = await store.deleteByFragmentId("frag-1", null);
    assert.equal(n, 3);
    const [sql, params] = mockQuery.mock.calls[0].arguments;
    assert.match(sql, /DELETE FROM agent_memory\.fragment_claims/);
    assert.match(sql, /key_id IS NOT DISTINCT FROM \$2/);
    assert.ok(!/key_id IS NULL OR/.test(sql));
    assert.deepEqual(params, ["frag-1", null]);
  });

  test("findPolarityConflicts: 양쪽 claim 격리 + threshold 바인딩", async () => {
    mockQuery.mock.mockImplementationOnce(async () => ({
      rows: [{ f1: "a", f2: "b", subject: "redis", predicate: "사용", object: "cache" }]
    }));
    const store = new ClaimStore();
    const rows  = await store.findPolarityConflicts("frag-1", "api-key-9");
    assert.equal(rows.length, 1);

    const [sql, params] = mockQuery.mock.calls[0].arguments;
    assert.match(sql, /c1\.polarity\s+=\s+'positive'/);
    assert.match(sql, /c2\.polarity\s+=\s+'negative'/);
    assert.match(sql, /c1\.key_id IS NOT DISTINCT FROM \$2/);
    assert.match(sql, /c2\.key_id IS NOT DISTINCT FROM \$2/);
    assert.match(sql, /c1\.confidence >= \$3/);
    assert.match(sql, /c2\.confidence >= \$3/);
    assert.ok(!/key_id IS NULL OR/.test(sql));
    assert.deepEqual(params, ["frag-1", "api-key-9", 0.7]);
  });

  test("findPolarityConflicts: opts.minConfidence 전달", async () => {
    mockQuery.mock.mockImplementationOnce(async () => ({ rows: [] }));
    const store = new ClaimStore();
    await store.findPolarityConflicts("frag-1", null, { minConfidence: 0.9 });
    const [, params] = mockQuery.mock.calls[0].arguments;
    assert.equal(params[2], 0.9);
  });

  test("master(NULL) 읽기: ctx.keyId=null 전달 시 params[1]=null", async () => {
    mockQuery.mock.mockImplementationOnce(async () => ({ rows: [] }));
    const store = new ClaimStore();
    await store.getByFragmentId("frag-m", null);
    const [, params] = mockQuery.mock.calls[0].arguments;
    assert.equal(params[1], null);
  });
});
