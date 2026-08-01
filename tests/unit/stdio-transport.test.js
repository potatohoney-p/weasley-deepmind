import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const cliPath = fileURLToPath(new URL("../../bin/weasley-deepmind.js", import.meta.url));

test("stdio transport keeps stdout protocol-clean and answers initialize", async () => {
  const child = spawn(process.execPath, [cliPath, "stdio"], {
    cwd: projectRoot,
    env: {
      ...process.env,
      LOG_LEVEL: "error",
      REDIS_ENABLED: "false",
      CACHE_ENABLED: "false",
      WEASLEY_DEEPMIND_AUTO_MIGRATE: "false"
    },
    stdio: ["pipe", "pipe", "pipe"]
  });

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });

  child.stdin.end(`${JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "stdio-smoke", version: "1.0.0" }
    }
  })}\n`);

  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });

  assert.strictEqual(exitCode, 0, stderr);
  const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
  assert.strictEqual(lines.length, 1, `unexpected stdout:\n${stdout}\nstderr:\n${stderr}`);

  const response = JSON.parse(lines[0]);
  assert.strictEqual(response.id, 1);
  assert.strictEqual(response.result.serverInfo.name, "weasley-deepmind-server");
  assert.strictEqual(response.result.protocolVersion, "2025-11-25");
});
