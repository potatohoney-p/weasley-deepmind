import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertCleanShutdown, teardownTestResources } from "../_lifecycle.js";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const roots = [];

after(async () => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  await teardownTestResources();
  await assertCleanShutdown();
});

// Copy the production module unchanged into a minimal installed layout. Real
// kuromoji code/dictionaries are resolved from the installed test dependencies.
// A fresh process prevents a previous successful singleton from hiding failure.
function runInstalled({ specialPath = false, hoisted = false, enabled = true, text = "これはすばらしいです" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "deepmind-tokenizer-"));
  roots.push(root);
  const installRoot = specialPath ? join(root, "space 日本語 # percent%") : root;
  const packageRoot = hoisted ? join(installRoot, "packages", "deepmind") : installRoot;
  const modulePath = join(packageRoot, "lib", "memory", "embedding", "MorphemeTokenizer.js");
  mkdirSync(dirname(modulePath), { recursive: true });
  mkdirSync(join(packageRoot, "config"), { recursive: true });
  writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ type: "module" }));
  copyFileSync(join(repoRoot, "lib/memory/embedding/MorphemeTokenizer.js"), modulePath);
  copyFileSync(join(repoRoot, "config/memory.js"), join(packageRoot, "config/memory.js"));
  const dependencies = join(installRoot, "node_modules");
  if (specialPath) {
    // Place the dependency's actual package URL beneath escaped characters too,
    // so resolving a package and forgetting fileURLToPath cannot pass this test.
    const kuromoji = join(dependencies, "kuromoji");
    mkdirSync(kuromoji, { recursive: true });
    copyFileSync(join(repoRoot, "node_modules/kuromoji/package.json"), join(kuromoji, "package.json"));
    cpSync(join(repoRoot, "node_modules/kuromoji/src"), join(kuromoji, "src"), { recursive: true });
    symlinkSync(join(repoRoot, "node_modules/kuromoji/dict"), join(kuromoji, "dict"), "junction");
    for (const name of ["async", "doublearray", "zlibjs"]) {
      symlinkSync(join(repoRoot, "node_modules", name), join(dependencies, name), "junction");
    }
  } else {
    symlinkSync(join(repoRoot, "node_modules"), dependencies, "junction");
  }

  const script = `
    const { tokenizeLocal } = await import(${JSON.stringify(pathToFileURL(modulePath).href)});
    console.log(JSON.stringify(await tokenizeLocal(${JSON.stringify(text)}, 20)));
  `;
  const output = execFileSync(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: root,
    encoding: "utf8",
    timeout: 30000,
    env: { ...process.env, WEASLEY_DEEPMIND_ENABLE_KUROMOJI: String(enabled) }
  });
  return JSON.parse(output.trim());
}

const expected = ["これ", "は", "すばらしい", "です"];

test("Japanese morphology works with package-local dependencies", () => {
  assert.deepEqual(runInstalled(), expected);
});

test("Japanese morphology works from paths containing spaces and URL escapes", () => {
  assert.deepEqual(runInstalled({ specialPath: true }), expected);
});

test("Japanese morphology finds dependencies hoisted above the package", () => {
  assert.deepEqual(runInstalled({ hoisted: true }), expected);
});

test("hoisted dependencies also work beneath a non-ASCII escaped path", () => {
  assert.deepEqual(runInstalled({ specialPath: true, hoisted: true }), expected);
});

test("disabled Japanese analyzer retains the character fallback", () => {
  assert.deepEqual(runInstalled({ specialPath: true, hoisted: true, enabled: false, text: "テスト" }), ["テ", "ス", "ト"]);
});

test("short kana segments retain the no-analyzer guard", () => {
  assert.deepEqual(runInstalled({ specialPath: true, hoisted: true, text: "ア" }), ["ア"]);
});
