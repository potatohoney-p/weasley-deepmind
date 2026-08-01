import { fork } from "child_process";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const usage = [
  "Usage: weasley-deepmind serve",
  "",
  "Start the Weasley DeepMind server (HTTP + SSE).",
  "",
  "Options:",
  "  (none)",
  "",
  "Examples:",
  "  weasley-deepmind serve",
].join("\n");

export default async function serve(_args) {
  const serverPath = path.resolve(__dirname, "..", "..", "server.js");
  console.log("Starting Weasley DeepMind server...");
  const child = fork(serverPath, [], { stdio: "inherit" });
  child.on("exit", (code) => process.exit(code ?? 0));
}
