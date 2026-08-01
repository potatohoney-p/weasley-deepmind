import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "../../lib/cli/parseArgs.js";

describe("parseArgs — L1 확장 기능", () => {
  // ── --key=value ────────────────────────────────────────────────
  it("--key=value 형태를 파싱한다", () => {
    const result = parseArgs(["--format=json"]);
    assert.strictEqual(result.format, "json");
  });

  it("--key=value 에서 = 이후 문자열 전체를 값으로 취한다", () => {
    const result = parseArgs(["--remote=https://example.com/mcp"]);
    assert.strictEqual(result.remote, "https://example.com/mcp");
  });

  // ── --no-flag ──────────────────────────────────────────────────
  it("--no-flag 를 { flag: false } 로 파싱한다", () => {
    const result = parseArgs(["--no-cache"]);
    assert.strictEqual(result.cache, false);
  });

  it("--no-flag 가 boolean false 임을 명시적으로 확인한다", () => {
    const result = parseArgs(["--no-verbose"]);
    assert.strictEqual(result.verbose, false);
    assert.strictEqual(typeof result.verbose, "boolean");
  });

  // ── 동일 키 반복 → 배열 ───────────────────────────────────────
  it("동일 키가 두 번 등장하면 배열로 누적한다", () => {
    const result = parseArgs(["--tag", "a", "--tag", "b"]);
    assert.deepStrictEqual(result.tag, ["a", "b"]);
  });

  it("동일 키가 세 번 등장하면 세 요소 배열을 반환한다", () => {
    const result = parseArgs(["--tag", "x", "--tag", "y", "--tag", "z"]);
    assert.deepStrictEqual(result.tag, ["x", "y", "z"]);
  });

  // ── 하위 호환 회귀 ────────────────────────────────────────────
  it("기존 --key value 형태는 여전히 string을 반환한다", () => {
    const result = parseArgs(["--topic", "myproject"]);
    assert.strictEqual(result.topic, "myproject");
    assert.strictEqual(typeof result.topic, "string");
  });

  it("기존 --flag 형태는 여전히 boolean true를 반환한다", () => {
    const result = parseArgs(["--json"]);
    assert.strictEqual(result.json, true);
  });

  it("기존 단일 문자 플래그 -h 는 여전히 true를 반환한다", () => {
    const result = parseArgs(["-h"]);
    assert.strictEqual(result.h, true);
  });

  it("복합 인자에서 --key=value, --no-flag, 반복 플래그가 함께 동작한다", () => {
    const result = parseArgs([
      "positional",
      "--format=table",
      "--no-color",
      "--tag", "alpha",
      "--tag", "beta",
      "--json",
    ]);
    assert.strictEqual(result.format, "table");
    assert.strictEqual(result.color, false);
    assert.deepStrictEqual(result.tag, ["alpha", "beta"]);
    assert.strictEqual(result.json, true);
    assert.deepStrictEqual(result._, ["positional"]);
  });
});
