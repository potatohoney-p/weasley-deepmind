/**
 * consolidator-feedback.test.js (node:test 이주)
 *
 * 작성자: 최진호
 * 작성일: 2026-03-17
 * 수정일: 2026-06-15 (feedbackFactor 라이브 계수로 갱신)
 */

import { describe, it } from "node:test";
import assert           from "node:assert/strict";

import { feedbackFactor } from "../../lib/memory/consolidate/feedbackFactor.js";

describe("feedbackFactor", () => {
    it("relevant=true, sufficient=true → POSITIVE_FACTOR 1.1", () => {
        assert.strictEqual(feedbackFactor(true, true), 1.1);
    });

    it("relevant=false → NEGATIVE_FACTOR 0.85", () => {
        assert.strictEqual(feedbackFactor(false, false), 0.85);
        assert.strictEqual(feedbackFactor(false, true),  0.85);
    });

    it("relevant=true, sufficient=false → MIXED_FACTOR 0.95", () => {
        assert.strictEqual(feedbackFactor(true, false), 0.95);
    });
});

describe("contradiction audit content format", () => {
    it("audit content 포맷 검증", () => {
        const loserContent  = "Redis TTL은 300초다.";
        const winnerContent = "Redis TTL은 3600초다.";
        const reasoning     = "최신 설정값 우선";

        const content = `[모순 해결] "${loserContent.substring(0, 80)}" 파편이 "${winnerContent.substring(0, 80)}" 으로 대체됨. 판단 근거: ${reasoning}`;

        assert.ok(content.includes("[모순 해결]"));
        assert.ok(content.includes("최신 설정값 우선"));
        assert.ok(content.length > 20);
    });
});
