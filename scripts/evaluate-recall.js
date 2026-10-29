import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runEvaluation } from "./recall-eval/evaluate.js";

try {
  const args = process.argv.slice(2);
  const options = {
    corpus: fileURLToPath(new URL("./recall-eval/fixtures/instrument-revisions.json", import.meta.url)),
    variant: "current"
  };
  const seen = new Set();
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i].replace(/^--/, "");
    if (!args[i].startsWith("--") || !["corpus", "variant"].includes(name) || seen.has(name) || !args[i + 1]) {
      throw new Error("Usage: node scripts/evaluate-recall.js [--corpus FILE] [--variant current|legacy-cache]");
    }
    seen.add(name); options[name] = args[i + 1];
  }
  const report = await runEvaluation(JSON.parse(readFileSync(options.corpus, "utf8")), options);
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  process.exitCode = report.passed ? 0 : 1;
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 2;
}
