import readline from "node:readline";
import { once } from "node:events";
import { spawn } from "node:child_process";
import path from "node:path";

export const usage = [
  "Usage: weasley-deepmind stdio",
  "",
  "Run Weasley DeepMind over the MCP stdio transport.",
  "Protocol messages are written to stdout; operational logs are written to stderr."
].join("\n");

function routeConsoleToStderr() {
  const write = (...values) => {
    process.stderr.write(`${values.map((value) =>
      typeof value === "string" ? value : JSON.stringify(value)
    ).join(" ")}\n`);
  };

  console.log = write;
  console.info = write;
  console.warn = write;
  console.debug = write;
}

async function runMigrationsWhenEnabled() {
  if (process.env.WEASLEY_DEEPMIND_AUTO_MIGRATE !== "true") return;

  const script = path.resolve(import.meta.dirname, "../../scripts/migrate.js");
  const child = spawn(process.execPath, [script], {
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"]
  });

  child.stdout.on("data", (chunk) => process.stderr.write(chunk));
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));

  const [code] = await once(child, "exit");
  if (code !== 0) {
    throw new Error(`Database migration failed with exit code ${code}`);
  }
}

export default async function stdio() {
  const protocolWrite = process.stdout.write.bind(process.stdout);
  routeConsoleToStderr();
  await runMigrationsWhenEnabled();

  const { dispatchJsonRpc } = await import("../jsonrpc.js");
  const input = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
    terminal: false
  });

  for await (const line of input) {
    if (!line.trim()) continue;

    let message;
    try {
      message = JSON.parse(line);
    } catch {
      const invalid = {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" }
      };
      if (!protocolWrite(`${JSON.stringify(invalid)}\n`)) {
        await once(process.stdout, "drain");
      }
      continue;
    }

    const result = await dispatchJsonRpc(message, { keyId: null, permissions: null });
    if (!result.response) continue;

    if (!protocolWrite(`${JSON.stringify(result.response)}\n`)) {
      await once(process.stdout, "drain");
    }
  }
}
