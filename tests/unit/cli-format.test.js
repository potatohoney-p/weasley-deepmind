/**
 * H4: CLI 출력 포맷 — renderTable / renderJson / renderCsv 검증
 *
 * 작성자: 최진호
 * 작성일: 2026-04-20
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderTable, renderJson, renderCsv, resolveFormat } from "../../lib/cli/_format.js";

describe("renderTable", () => {
  it("renders header, separator, and data rows", () => {
    const rows    = [{ id: "abc", value: "hello" }];
    const columns = ["id", "value"];
    const out     = renderTable(rows, columns);

    const lines = out.split("\n");
    assert.ok(lines[0].includes("id"),    "header must include 'id'");
    assert.ok(lines[0].includes("value"), "header must include 'value'");
    assert.ok(lines[1].startsWith("|-"),  "separator must start with '|-'");
    assert.ok(lines[2].includes("abc"),   "data row must include cell value 'abc'");
    assert.ok(lines[2].includes("hello"), "data row must include cell value 'hello'");
  });

  it("returns '(no data)' for empty rows", () => {
    assert.strictEqual(renderTable([], ["col"]), "(no data)");
  });

  it("truncates long cell values and adds ellipsis", () => {
    // Force max width overflow: 10 columns each 20 chars
    const cols = Array.from({ length: 10 }, (_, i) => `col${i}`);
    const row  = Object.fromEntries(cols.map(c => [c, "a".repeat(30)]));
    const out  = renderTable([row], cols);
    assert.ok(out.includes("\u2026"), "truncated cells must end with ellipsis (…)");
    // Total line width must not exceed 80 + newline overhead
    const maxLine = Math.max(...out.split("\n").map(l => l.length));
    assert.ok(maxLine <= 82, `max line width (${maxLine}) exceeds 82 chars`);
  });

  it("uses only pipe and hyphen characters (no box-drawing)", () => {
    const rows = [{ a: "x", b: "y" }];
    const out  = renderTable(rows, ["a", "b"]);
    const boxChars = /[\u2500-\u257F]/;
    assert.ok(!boxChars.test(out), "renderTable must not use box-drawing characters");
  });
});

describe("renderJson", () => {
  it("pretty-prints by default", () => {
    const out = renderJson({ x: 1 });
    assert.ok(out.includes("\n"), "pretty JSON must contain newlines");
    assert.strictEqual(JSON.parse(out).x, 1);
  });

  it("compact mode when pretty=false", () => {
    const out = renderJson({ x: 1 }, false);
    assert.ok(!out.includes("\n"), "compact JSON must not contain newlines");
    assert.strictEqual(JSON.parse(out).x, 1);
  });
});

describe("renderCsv", () => {
  it("renders header and data rows", () => {
    const rows = [{ id: "1", name: "Alice" }];
    const out  = renderCsv(rows, ["id", "name"]);
    const lines = out.split("\n");
    assert.strictEqual(lines[0], "id,name");
    assert.strictEqual(lines[1], "1,Alice");
  });

  it("escapes cells containing commas", () => {
    const rows = [{ a: "hello, world", b: "ok" }];
    const out  = renderCsv(rows, ["a", "b"]);
    assert.ok(out.includes('"hello, world"'), "comma cell must be quoted");
  });

  it("escapes cells containing double-quotes", () => {
    const rows = [{ a: 'say "hi"', b: "ok" }];
    const out  = renderCsv(rows, ["a", "b"]);
    assert.ok(out.includes('"say ""hi"""'), "double-quote cell must be escaped as \"\"");
  });
});

describe("resolveFormat", () => {
  it("prefers args.format over everything", () => {
    assert.strictEqual(resolveFormat({ format: "csv", json: true }), "csv");
  });

  it("falls back to json when args.json is true", () => {
    assert.strictEqual(resolveFormat({ json: true }), "json");
  });

  it("uses fallback when not TTY and no flags", () => {
    // process.stdout.isTTY is falsy in test runner
    assert.strictEqual(resolveFormat({}, "table"), "table");
    assert.strictEqual(resolveFormat({}), "json");
  });
});
