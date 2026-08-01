// tests/unit/workspace-isolation.test.js
import { describe, it } from "node:test";
import assert from "node:assert/strict";

/**
 * workspace 우선순위 해석 로직 검증
 */
function resolveWorkspace(params) {
  return params.workspace ?? params._defaultWorkspace ?? null;
}

/**
 * workspace 검색 필터 조건 생성 검증
 */
function buildWorkspaceCondition(workspace, paramIdx) {
  if (!workspace) return null;
  return { condition: `(workspace = $${paramIdx} OR workspace IS NULL)`, value: workspace };
}

describe("workspace 우선순위 해석", () => {
  it("params.workspace가 _defaultWorkspace보다 우선", () => {
    const result = resolveWorkspace({ workspace: "my-project", _defaultWorkspace: "other" });
    assert.equal(result, "my-project");
  });

  it("params.workspace 미지정 시 _defaultWorkspace 사용", () => {
    const result = resolveWorkspace({ _defaultWorkspace: "default-ws" });
    assert.equal(result, "default-ws");
  });

  it("둘 다 없으면 null", () => {
    const result = resolveWorkspace({});
    assert.equal(result, null);
  });

  it("params.workspace가 null이면 _defaultWorkspace로 폴백 (null은 미지정으로 취급)", () => {
    const result = resolveWorkspace({ workspace: null, _defaultWorkspace: "other" });
    assert.equal(result, "other");
  });
});

describe("workspace 검색 필터 조건 생성", () => {
  it("workspace 지정 시 OR IS NULL 조건 생성", () => {
    const result = buildWorkspaceCondition("my-project", 3);
    assert.equal(result.condition, "(workspace = $3 OR workspace IS NULL)");
    assert.equal(result.value, "my-project");
  });

  it("workspace null 시 필터 없음", () => {
    const result = buildWorkspaceCondition(null, 3);
    assert.equal(result, null);
  });

  it("paramIdx가 올바르게 반영됨", () => {
    const result = buildWorkspaceCondition("ws", 7);
    assert.equal(result.condition, "(workspace = $7 OR workspace IS NULL)");
  });
});
