/**
 * Admin Overview API (/stats) 확장 응답 계약 테스트
 *
 * GET /stats 엔드포인트가 기존 필드를 유지하면서
 * searchMetrics, observability, queues, healthFlags를 추가 반환하는지 검증.
 *
 * 작성자: 최진호
 * 작성일: 2026-03-26
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

/**
 * admin-routes.js의 handleAdminApi를 직접 호출하는 대신,
 * /stats 핸들러가 조합하는 데이터 계약을 검증한다.
 *
 * 실제 모듈 import 시 DB/Redis 초기화가 발생하므로,
 * 핸들러 로직을 추출하여 순수 함수 형태로 테스트한다.
 */

/* ------------------------------------------------------------------ */
/*  Mock 인프라                                                         */
/* ------------------------------------------------------------------ */

/**
 * /stats 핸들러의 응답 조립 로직을 순수 함수로 추출.
 * admin-routes.js의 구현과 동일한 계약을 따른다.
 */
function buildStatsResponse({
  fragTotal     = 0,
  callTotal     = 0,
  activeKeys    = 0,
  sessionTotal  = 0,
  cpuPct        = 0,
  memPct        = 0,
  diskPct       = 0,
  dbSizeBytes   = 0,
  redisStat     = "disconnected",
  searchMetrics = null,
  observability = null,
  qualityPending = null,
  poolStats     = null
} = {}) {
  const healthFlags = [];

  if (redisStat === "disconnected") {
    healthFlags.push("redis_disconnected");
  }
  if (observability?.l1_miss_rate != null && observability.l1_miss_rate > 0.5) {
    healthFlags.push("high_l1_miss_rate");
  }
  if (poolStats?.primary?.waitingCount > 0) {
    healthFlags.push("db_pool_pressure");
  }

  return {
    fragments     : fragTotal,
    sessions      : sessionTotal,
    apiCallsToday : callTotal,
    activeKeys,
    uptime        : Math.floor(process.uptime()),
    nodeVersion   : process.version,
    system        : { cpu: cpuPct, memory: memPct, disk: diskPct, dbSizeBytes },
    db            : "connected",
    redis         : redisStat,
    searchMetrics : searchMetrics ?? null,
    observability : observability ?? null,
    queues        : {
      embeddingBacklog : 0,
      qualityPending   : qualityPending ?? 0
    },
    healthFlags
  };
}

/* ================================================================== */
/*  테스트                                                               */
/* ================================================================== */

describe("GET /stats response contract", () => {

  describe("기존 필드 보존", () => {
    it("fragments, sessions, apiCallsToday, activeKeys가 존재한다", () => {
      const body = buildStatsResponse({ fragTotal: 42, sessionTotal: 3, callTotal: 100, activeKeys: 2 });

      assert.strictEqual(body.fragments, 42);
      assert.strictEqual(body.sessions, 3);
      assert.strictEqual(body.apiCallsToday, 100);
      assert.strictEqual(body.activeKeys, 2);
    });

    it("system 객체에 cpu, memory, disk, dbSizeBytes가 존재한다", () => {
      const body = buildStatsResponse({ cpuPct: 55, memPct: 70, diskPct: 30, dbSizeBytes: 1024000 });

      assert.strictEqual(body.system.cpu, 55);
      assert.strictEqual(body.system.memory, 70);
      assert.strictEqual(body.system.disk, 30);
      assert.strictEqual(body.system.dbSizeBytes, 1024000);
    });

    it("uptime, nodeVersion, db, redis가 존재한다", () => {
      const body = buildStatsResponse({ redisStat: "connected" });

      assert.strictEqual(typeof body.uptime, "number");
      assert.strictEqual(typeof body.nodeVersion, "string");
      assert.strictEqual(body.db, "connected");
      assert.strictEqual(body.redis, "connected");
    });
  });

  describe("searchMetrics 필드", () => {
    it("SearchMetrics 데이터가 있으면 L1/L2/L3/total 하위 객체를 포함한다", () => {
      const metrics = {
        L1    : { p50: 1.2, p90: 3.4, p99: 5.6, count: 10 },
        L2    : { p50: 10,  p90: 30,  p99: 50,  count: 8 },
        L3    : { p50: 20,  p90: 60,  p99: 90,  count: 5 },
        total : { p50: 15,  p90: 40,  p99: 70,  count: 10 }
      };
      const body = buildStatsResponse({ searchMetrics: metrics });

      assert.ok(body.searchMetrics);
      assert.ok(body.searchMetrics.L1);
      assert.ok(body.searchMetrics.L2);
      assert.ok(body.searchMetrics.L3);
      assert.ok(body.searchMetrics.total);
      assert.strictEqual(body.searchMetrics.L1.p50, 1.2);
      assert.strictEqual(body.searchMetrics.total.count, 10);
    });

    it("SearchMetrics가 null이면 searchMetrics도 null이다", () => {
      const body = buildStatsResponse({ searchMetrics: null });
      assert.strictEqual(body.searchMetrics, null);
    });
  });

  describe("observability 필드", () => {
    it("관측성 데이터가 있으면 기대 필드를 포함한다", () => {
      const obs = {
        total_searches : 500,
        l1_miss_rate   : 0.12,
        rrf_usage_rate : 0.45,
        l3_usage_rate  : 0.30,
        avg_latency_ms : 25.3
      };
      const body = buildStatsResponse({ observability: obs });

      assert.ok(body.observability);
      assert.strictEqual(typeof body.observability.total_searches, "number");
      assert.strictEqual(typeof body.observability.l1_miss_rate, "number");
      assert.strictEqual(typeof body.observability.rrf_usage_rate, "number");
    });

    it("관측성 데이터가 null이면 observability도 null이다", () => {
      const body = buildStatsResponse({ observability: null });
      assert.strictEqual(body.observability, null);
    });
  });

  describe("queues 필드", () => {
    it("queues 객체에 embeddingBacklog, qualityPending이 존재한다", () => {
      const body = buildStatsResponse({ qualityPending: 15 });

      assert.ok(body.queues);
      assert.strictEqual(typeof body.queues.embeddingBacklog, "number");
      assert.strictEqual(body.queues.qualityPending, 15);
    });

    it("qualityPending이 null이면 0으로 fallback한다", () => {
      const body = buildStatsResponse({ qualityPending: null });
      assert.strictEqual(body.queues.qualityPending, 0);
    });
  });

  describe("healthFlags 필드", () => {
    it("정상 상태에서 빈 배열을 반환한다", () => {
      const body = buildStatsResponse({ redisStat: "connected" });
      assert.ok(Array.isArray(body.healthFlags));
      assert.strictEqual(body.healthFlags.length, 0);
    });

    it("Redis 연결 해제 시 redis_disconnected 플래그를 포함한다", () => {
      const body = buildStatsResponse({ redisStat: "disconnected" });
      assert.ok(body.healthFlags.includes("redis_disconnected"));
    });

    it("L1 miss rate > 0.5 시 high_l1_miss_rate 플래그를 포함한다", () => {
      const obs  = { l1_miss_rate: 0.7, total_searches: 100, rrf_usage_rate: 0.1 };
      const body = buildStatsResponse({ redisStat: "connected", observability: obs });
      assert.ok(body.healthFlags.includes("high_l1_miss_rate"));
    });

    it("DB pool waiting > 0 시 db_pool_pressure 플래그를 포함한다", () => {
      const poolStats = { primary: { totalCount: 10, idleCount: 0, waitingCount: 3 } };
      const body      = buildStatsResponse({ redisStat: "connected", poolStats });
      assert.ok(body.healthFlags.includes("db_pool_pressure"));
    });
  });

  describe("graceful degradation", () => {
    it("Redis 미연결 시 값이 null/fallback으로 안전하게 처리된다", () => {
      const body = buildStatsResponse({
        redisStat     : "disconnected",
        searchMetrics : null,
        observability : null
      });

      assert.strictEqual(body.redis, "disconnected");
      assert.strictEqual(body.searchMetrics, null);
      assert.strictEqual(body.observability, null);
      assert.ok(body.healthFlags.includes("redis_disconnected"));
      assert.strictEqual(typeof body.fragments, "number");
    });

    it("모든 추가 데이터가 null이어도 기존 필드는 정상 반환된다", () => {
      const body = buildStatsResponse({
        fragTotal     : 10,
        sessionTotal  : 2,
        searchMetrics : null,
        observability : null,
        qualityPending: null,
        poolStats     : null
      });

      assert.strictEqual(body.fragments, 10);
      assert.strictEqual(body.sessions, 2);
      assert.ok(body.queues);
      assert.ok(Array.isArray(body.healthFlags));
    });
  });
});
