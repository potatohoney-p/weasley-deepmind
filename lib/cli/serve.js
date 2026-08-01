import { fork } from "child_process";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const usage = [
  "Usage: memento-mcp serve",
  "",
  "Start the Memento MCP server (HTTP + SSE).",
  "",
  "Options:",
  "  (none)",
  "",
  "Examples:",
  "  memento-mcp serve",
].join("\n");

export default async function serve(_args) {
  const serverPath = path.resolve(__dirname, "..", "..", "server.js");
  console.log("Starting Memento MCP server...");
  const child = fork(serverPath, [], { stdio: "inherit" });
  child.on("exit", (code) => process.exit(code ?? 0));
}
