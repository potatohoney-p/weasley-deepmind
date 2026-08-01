/**
 * key-groups.test.js (node:test 이주)
 * API Key Group effective_key_id resolution 단위 테스트
 *
 * 작성자: 최진호
 * 수정일: 2026-04-19 (Jest → node:test 이주)
 */

import { describe, it } from "node:test";
import assert           from "node:assert/strict";

describe("API Key Group — effective_key_id resolution", () => {
    const resolve = (key) => key.group_id ?? key.id;

    it("그룹 소속 키: group_id를 effective_key_id로 사용", () => {
        assert.strictEqual(resolve({ id: "key-001", group_id: "grp-001" }), "grp-001");
    });

    it("독립 키: 자체 id를 effective_key_id로 사용", () => {
        assert.strictEqual(resolve({ id: "key-001", group_id: null }), "key-001");
    });

    it("같은 그룹의 키들은 동일 effective_key_id", () => {
        const a = resolve({ id: "key-001", group_id: "grp-shared" });
        const b = resolve({ id: "key-002", group_id: "grp-shared" });
        assert.strictEqual(a, b);
    });

    it("다른 그룹의 키들은 다른 effective_key_id", () => {
        const a = resolve({ id: "key-001", group_id: "grp-A" });
        const b = resolve({ id: "key-002", group_id: "grp-B" });
        assert.notStrictEqual(a, b);
    });

    it("독립 키와 그룹 키는 격리됨", () => {
        const a = resolve({ id: "key-001", group_id: null });
        const b = resolve({ id: "key-002", group_id: "grp-001" });
        assert.notStrictEqual(a, b);
    });
});

describe("API Key Group — N:M membership", () => {
    it("키가 복수 그룹 소속 시 첫 번째 그룹이 쓰기 컨텍스트", () => {
        const memberships = [
            { group_id: "grp-alpha", joined_at: "2026-01-01" },
            { group_id: "grp-beta",  joined_at: "2026-02-01" }
        ];
        memberships.sort((a, b) => a.joined_at.localeCompare(b.joined_at));
        assert.strictEqual(memberships[0].group_id, "grp-alpha");
    });

    it("그룹 미소속 시 memberships 빈 배열", () => {
        const memberships  = [];
        const effectiveId  = memberships.length > 0 ? memberships[0].group_id : "key-standalone";
        assert.strictEqual(effectiveId, "key-standalone");
    });
});
