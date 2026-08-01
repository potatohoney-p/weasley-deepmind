/**
 * scheduler-registry.test.js (node:test 이주)
 * SchedulerRegistry 단위 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-03-31
 * 수정일: 2026-04-19 (Jest → node:test 이주)
 */

import { describe, it } from "node:test";
import assert           from "node:assert/strict";

import { SchedulerRegistry } from "../../lib/scheduler-registry.js";

describe("SchedulerRegistry", () => {
    it("tracks job success", () => {
        const reg = new SchedulerRegistry();
        reg.recordSuccess("consolidate", { affected: 5 });
        const jobs = reg.getAll();
        assert.ok(jobs.consolidate.lastSuccess !== undefined);
        assert.deepStrictEqual(jobs.consolidate.lastSummary, { affected: 5 });
        assert.strictEqual(jobs.consolidate.runCount, 1);
        assert.strictEqual(jobs.consolidate.failureCount, 0);
    });

    it("tracks job failure", () => {
        const reg = new SchedulerRegistry();
        reg.recordFailure("embedding", new Error("timeout"));
        const jobs = reg.getAll();
        assert.strictEqual(jobs.embedding.lastError, "timeout");
        assert.strictEqual(jobs.embedding.failureCount, 1);
    });

    it("tracks multiple runs", () => {
        const reg = new SchedulerRegistry();
        reg.recordSuccess("consolidate");
        reg.recordSuccess("consolidate");
        reg.recordFailure("consolidate", new Error("db"));
        const jobs = reg.getAll();
        assert.strictEqual(jobs.consolidate.runCount, 3);
        assert.strictEqual(jobs.consolidate.failureCount, 1);
    });

    it("getAll returns independent copy", () => {
        const reg  = new SchedulerRegistry();
        reg.recordSuccess("job1", { x: 1 });
        const snap = reg.getAll();
        snap.job1.runCount = 999;
        assert.strictEqual(reg.getAll().job1.runCount, 1);
    });

    it("lastFailure is null before any failure", () => {
        const reg = new SchedulerRegistry();
        reg.recordSuccess("job1");
        assert.strictEqual(reg.getAll().job1.lastFailure, null);
    });
});
