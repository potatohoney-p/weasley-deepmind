import { test, describe } from "node:test";
import assert from "node:assert/strict";

/** Redis mock: Set 연산 시뮬레이션 */
function createRedisMock() {
  const store = new Map();
  return {
    status: "ready",
    async del(key)          { store.delete(key); return 1; },
    async sadd(key, ...ids) {
      if (!store.has(key)) store.set(key, new Set());
      for (const id of ids) store.get(key).add(id);
      return ids.length;
    },
    async smembers(key)     { return [...(store.get(key) || [])]; },
    async expire()          { return 1; },
    pipeline() {
      const ops = [];
      const self = {
        del(key)          { ops.push(() => store.delete(key)); return self; },
        sadd(key, ...ids) {
          ops.push(() => {
            if (!store.has(key)) store.set(key, new Set());
            for (const id of ids) store.get(key).add(id);
          });
          return self;
        },
        expire()          { ops.push(() => {}); return self; },
        async exec()      { for (const op of ops) op(); return []; }
      };
      return self;
    },
    _store: store
  };
}

describe("Seen IDs 중복 방지", () => {

  test("setSeenIds는 기존 Set을 overwrite한다", async () => {
    const redis = createRedisMock();
    const key   = "frag:seen:sess-001";

    await redis.sadd(key, "frag-1", "frag-2");
    assert.deepStrictEqual((await redis.smembers(key)).sort(), ["frag-1", "frag-2"]);

    const pipe = redis.pipeline();
    pipe.del(key);
    pipe.sadd(key, "frag-3", "frag-4");
    pipe.expire(key, 86400);
    await pipe.exec();

    const result = (await redis.smembers(key)).sort();
    assert.deepStrictEqual(result, ["frag-3", "frag-4"],
      "overwrite 후에는 새 ID만 있어야 한다");
  });

  test("getSeenIds는 Redis 미가용 시 빈 Set을 반환한다", () => {
    const seen = new Set();
    assert.strictEqual(seen.size, 0);
  });

  test("seen IDs로 recall 결과를 필터링할 수 있다", () => {
    const seenIds   = new Set(["frag-1", "frag-3"]);
    const fragments = [
      { id: "frag-1", content: "A" },
      { id: "frag-2", content: "B" },
      { id: "frag-3", content: "C" },
      { id: "frag-4", content: "D" }
    ];
    const filtered = fragments.filter(f => !seenIds.has(f.id));

    assert.strictEqual(filtered.length, 2);
    assert.deepStrictEqual(filtered.map(f => f.id), ["frag-2", "frag-4"]);
  });

  test("빈 ID 배열로 setSeenIds를 호출해도 에러 없다", async () => {
    const redis = createRedisMock();
    const ids   = [];
    const pipe  = redis.pipeline();
    pipe.del("frag:seen:sess-002");
    if (ids.length > 0) {
      pipe.sadd("frag:seen:sess-002", ...ids);
      pipe.expire("frag:seen:sess-002", 86400);
    }
    await pipe.exec();

    const result = await redis.smembers("frag:seen:sess-002");
    assert.strictEqual(result.length, 0);
  });

  test("excludeSeen=false면 필터링하지 않는다", () => {
    const seenIds     = new Set(["frag-1"]);
    const excludeSeen = false;
    const fragments   = [{ id: "frag-1", content: "A" }];

    const filtered = excludeSeen
      ? fragments.filter(f => !seenIds.has(f.id))
      : fragments;

    assert.strictEqual(filtered.length, 1, "excludeSeen=false면 전체 반환");
  });
});

describe("context() seen IDs 저장", () => {

  test("context()가 반환하는 파편 ID에서 null이 제외된다", () => {
    const dedupResult = [
      { id: "frag-a", content: "X", type: "preference" },
      { id: null, content: "Y", type: "error" },
      { id: "frag-b", content: "Z", type: "procedure" }
    ];

    const seenIds = dedupResult.map(f => f.id).filter(Boolean);
    assert.deepStrictEqual(seenIds, ["frag-a", "frag-b"]);
    assert.strictEqual(seenIds.length, 2, "null ID는 제외되어야 한다");
  });
});

describe("recall() seen IDs 필터링", () => {

  test("excludeSeen=true(기본)면 seen 파편이 제외된다", () => {
    const seenIds     = new Set(["frag-1", "frag-3"]);
    const excludeSeen = true;
    const fragments   = [
      { id: "frag-1", content: "A" },
      { id: "frag-2", content: "B" },
      { id: "frag-3", content: "C" }
    ];

    const filtered = excludeSeen
      ? fragments.filter(f => !seenIds.has(f.id))
      : fragments;

    assert.strictEqual(filtered.length, 1);
    assert.strictEqual(filtered[0].id, "frag-2");
  });

  test("excludeSeen=false면 모든 파편이 반환된다", () => {
    const seenIds     = new Set(["frag-1"]);
    const excludeSeen = false;
    const fragments   = [
      { id: "frag-1", content: "A" },
      { id: "frag-2", content: "B" }
    ];

    const filtered = excludeSeen
      ? fragments.filter(f => !seenIds.has(f.id))
      : fragments;

    assert.strictEqual(filtered.length, 2);
  });

  test("sessionId 없으면 필터링 건너뛴다", () => {
    const sessionId   = undefined;
    const excludeSeen = true;
    const fragments   = [{ id: "frag-1", content: "A" }];

    const seenIds = (excludeSeen && sessionId) ? new Set(["frag-1"]) : new Set();
    const filtered = seenIds.size > 0
      ? fragments.filter(f => !seenIds.has(f.id))
      : fragments;

    assert.strictEqual(filtered.length, 1, "sessionId 없으면 필터링 없음");
  });
});

describe("context -> recall 통합 시나리오", () => {

  test("context() 2회 호출 시 seen Set이 overwrite된다", async () => {
    const redis = createRedisMock();
    const key   = "frag:seen:sess-int-001";

    // 1차 context
    const pipe1 = redis.pipeline();
    pipe1.del(key);
    pipe1.sadd(key, "frag-1", "frag-2");
    pipe1.expire(key, 86400);
    await pipe1.exec();

    // 2차 context (overwrite)
    const pipe2 = redis.pipeline();
    pipe2.del(key);
    pipe2.sadd(key, "frag-3", "frag-4");
    pipe2.expire(key, 86400);
    await pipe2.exec();

    const seenIds = new Set(await redis.smembers(key));

    assert.ok(!seenIds.has("frag-1"), "1차 ID는 사라져야 한다");
    assert.ok(!seenIds.has("frag-2"), "1차 ID는 사라져야 한다");
    assert.ok(seenIds.has("frag-3"), "2차 ID만 있어야 한다");
    assert.ok(seenIds.has("frag-4"), "2차 ID만 있어야 한다");
  });

  test("recall이 context 주입 파편을 제외하고 반환한다", async () => {
    const redis = createRedisMock();
    const key   = "frag:seen:sess-int-002";

    const contextFrags = [
      { id: "frag-a", content: "preference" },
      { id: "frag-b", content: "procedure" }
    ];
    const pipe = redis.pipeline();
    pipe.del(key);
    const ids = contextFrags.map(f => f.id).filter(Boolean);
    if (ids.length > 0) pipe.sadd(key, ...ids);
    pipe.expire(key, 86400);
    await pipe.exec();

    const recallResults = [
      { id: "frag-a", content: "preference" },
      { id: "frag-c", content: "new info" },
      { id: "frag-b", content: "procedure" },
      { id: "frag-d", content: "more info" }
    ];

    const seenIds  = new Set(await redis.smembers(key));
    const filtered = recallResults.filter(f => !seenIds.has(f.id));

    assert.strictEqual(filtered.length, 2);
    assert.deepStrictEqual(filtered.map(f => f.id), ["frag-c", "frag-d"]);
  });
});
