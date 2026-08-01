/**
 * 거부 경로 메트릭 단위 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-04-10
 *
 * authDenied / corsDenied / rbacDenied / tenantIsolationBlocked 카운터가
 * 각 거부 경로에서 정확히 증가하는지 검증한다.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  authDeniedTotal,
  corsDeniedTotal,
  rbacDeniedTotal,
  tenantIsolationBlockedTotal,
  recordAuthDenied,
  recordCorsDenied,
  recordRbacDenied,
  recordTenantIsolationBlocked,
} from "../../lib/metrics.js";

// ---------------------------------------------------------------------------
// 헬퍼: prom-client Counter의 현재 레이블 값 읽기
// ---------------------------------------------------------------------------

async function getCounterValue(counter, labels) {
  const metrics = await counter.get();
  const match   = metrics.values.find((v) =>
    Object.entries(labels).every(([k, val]) => String(v.labels[k]) === String(val))
  );
  return match ? match.value : 0;
}

// ---------------------------------------------------------------------------
// memento_auth_denied_total
// ---------------------------------------------------------------------------

describe("memento_auth_denied_total", () => {
  it("recordAuthDenied('invalid_key') 호출 시 카운터가 증가한다", async () => {
    const before = await getCounterValue(authDeniedTotal, { reason: "invalid_key" });
    recordAuthDenied("invalid_key");
    const after  = await getCounterValue(authDeniedTotal, { reason: "invalid_key" });
    assert.strictEqual(after, before + 1);
  });

  it("다른 reason 레이블은 독립적으로 증가한다", async () => {
    const before = await getCounterValue(authDeniedTotal, { reason: "missing_header" });
    recordAuthDenied("missing_header");
    const after  = await getCounterValue(authDeniedTotal, { reason: "missing_header" });
    assert.strictEqual(after, before + 1);
  });
});

// ---------------------------------------------------------------------------
// memento_cors_denied_total
// ---------------------------------------------------------------------------

describe("memento_cors_denied_total", () => {
  it("recordCorsDenied('origin_not_allowed') 호출 시 카운터가 증가한다", async () => {
    const before = await getCounterValue(corsDeniedTotal, { reason: "origin_not_allowed" });
    recordCorsDenied("origin_not_allowed");
    const after  = await getCounterValue(corsDeniedTotal, { reason: "origin_not_allowed" });
    assert.strictEqual(after, before + 1);
  });
});

// ---------------------------------------------------------------------------
// memento_rbac_denied_total
// ---------------------------------------------------------------------------

describe("memento_rbac_denied_total", () => {
  it("recordRbacDenied 호출 시 tool + reason 레이블로 카운터가 증가한다", async () => {
    const before = await getCounterValue(rbacDeniedTotal, { tool: "memory_consolidate", reason: "requires_admin" });
    recordRbacDenied("memory_consolidate", "requires_admin");
    const after  = await getCounterValue(rbacDeniedTotal, { tool: "memory_consolidate", reason: "requires_admin" });
    assert.strictEqual(after, before + 1);
  });

  it("서로 다른 tool 레이블은 독립적으로 집계된다", async () => {
    const beforeForget  = await getCounterValue(rbacDeniedTotal, { tool: "forget",   reason: "requires_write" });
    const beforeRecall  = await getCounterValue(rbacDeniedTotal, { tool: "recall",   reason: "requires_read"  });
    recordRbacDenied("forget", "requires_write");
    recordRbacDenied("recall", "requires_read");
    const afterForget   = await getCounterValue(rbacDeniedTotal, { tool: "forget",   reason: "requires_write" });
    const afterRecall   = await getCounterValue(rbacDeniedTotal, { tool: "recall",   reason: "requires_read"  });
    assert.strictEqual(afterForget, beforeForget + 1);
    assert.strictEqual(afterRecall, beforeRecall + 1);
  });
});

// ---------------------------------------------------------------------------
// memento_tenant_isolation_blocked_total
// ---------------------------------------------------------------------------

describe("memento_tenant_isolation_blocked_total", () => {
  it("recordTenantIsolationBlocked('forget') 호출 시 카운터가 증가한다", async () => {
    const before = await getCounterValue(tenantIsolationBlockedTotal, { component: "forget" });
    recordTenantIsolationBlocked("forget");
    const after  = await getCounterValue(tenantIsolationBlockedTotal, { component: "forget" });
    assert.strictEqual(after, before + 1);
  });

  it("component 별로 독립적으로 집계된다", async () => {
    const components = ["amend", "fragment_history", "graph_explore", "session_delete"];
    const befores    = await Promise.all(
      components.map((c) => getCounterValue(tenantIsolationBlockedTotal, { component: c }))
    );

    components.forEach((c) => recordTenantIsolationBlocked(c));

    const afters = await Promise.all(
      components.map((c) => getCounterValue(tenantIsolationBlockedTotal, { component: c }))
    );

    afters.forEach((after, i) => {
      assert.strictEqual(after, befores[i] + 1);
    });
  });
});
