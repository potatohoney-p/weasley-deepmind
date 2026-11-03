/**
 * CLI: export — 파편 JSONL 백업
 *
 * MemoryManager 직접 경유 없이 PostgreSQL raw query로 파편을 읽어
 * JSONL(한 줄에 하나의 파편 JSON) 형식으로 stdout 또는 파일로 출력한다.
 *
 * 출력 필드:
 *   id, content, topic, type, keywords, importance, source, agent_id,
 *   created_at, is_anchor, case_id, idempotency_key,
 *   goal, outcome, phase, resolution_status, assertion_status
 *
 * 작성자: Weasley Open Source
 * 작성일: 2026-04-20
 */

import pg   from "pg";
import fs   from "node:fs";
import path from "node:path";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD } from "../config.js";

const SCHEMA     = "agent_memory";
const BATCH_SIZE = 200; /** 커서 없이 LIMIT/OFFSET 배치 */

export const usage = [
  "Usage: weasley-deepmind export [options]",
  "",
  "Export memory fragments as JSONL (one JSON per line).",
  "",
  "Options:",
  "  --key <wdm_xxx>      API key filter (key_id). Omit for master (all fragments).",
  "  --topic <name>        Filter by topic",
  "  --type <type>         Filter by fragment type (fact|decision|error|preference|procedure|relation)",
  "  --since <ISO>         Filter created_at >= ISO timestamp (e.g. 2026-01-01)",
  "  --limit <n>           Max fragments to export (default: unlimited)",
  "  --output <FILE>       Write to file instead of stdout",
  "  --json                Wrap output in a JSON array (not JSONL)",
  "",
  "Examples:",
  "  weasley-deepmind export > backup.jsonl",
  "  weasley-deepmind export --topic infra --type fact --output infra-facts.jsonl",
  "  weasley-deepmind export --since 2026-04-01 --limit 500",
  "  weasley-deepmind export --key wdm_xxx --output my-fragments.jsonl",
].join("\n");

export default async function exportCmd(args) {
  const outputFile = args.output;
  const useJsonArray = args.json === true;

  /** 필터 파라미터 구성 */
  const conditions = ["valid_to IS NULL"];
  const params     = [];

  if (args.key) {
    params.push(args.key);
    conditions.push(`key_id = $${params.length}`);
  }
  if (args.topic) {
    params.push(args.topic);
    conditions.push(`topic = $${params.length}`);
  }
  if (args.type) {
    params.push(args.type);
    conditions.push(`type = $${params.length}`);
  }
  if (args.since) {
    const ts = new Date(args.since);
    if (isNaN(ts.getTime())) {
      console.error(`[export] Invalid --since value: "${args.since}". Use ISO format (e.g. 2026-01-01).`);
      process.exitCode = 1;
      return;
    }
    params.push(ts.toISOString());
    conditions.push(`created_at >= $${params.length}::timestamptz`);
  }

  const hardLimit  = args.limit ? parseInt(args.limit, 10) : null;
  if (hardLimit !== null && (isNaN(hardLimit) || hardLimit <= 0)) {
    console.error(`[export] --limit must be a positive integer, got: ${args.limit}`);
    process.exitCode = 1;
    return;
  }

  const SELECT_FIELDS = `
    id, content, topic, type, keywords, importance, source, agent_id,
    created_at, is_anchor, case_id, idempotency_key,
    goal, outcome, phase, resolution_status, assertion_status
  `;

  let exported  = 0;
  let offset    = 0;
  let done      = false;
  const allRows = useJsonArray ? [] : null;

  let pool;
  let outStream;
  let onStdoutError;
  let onStdoutClose;
  try {
    pool = new pg.Pool({
      host: DB_HOST, port: DB_PORT, database: DB_NAME,
      user: DB_USER, password: DB_PASSWORD, max: 2,
    });
    if (outputFile) {
      outStream = fs.createWriteStream(path.resolve(outputFile), { encoding: "utf8" });
    } else {
      // Finish our adapter only: stdout belongs to the CLI's caller. Forward each
      // write callback so success waits for buffered writes, including the last one.
      outStream = new Writable({
        write(chunk, encoding, callback) {
          process.stdout.write(chunk, encoding, callback);
        }
      });
      onStdoutError = err => outStream.destroy(err);
      onStdoutClose = () => outStream.destroy(new Error("Output stream closed before export completed"));
      process.stdout.on("error", onStdoutError);
      process.stdout.on("close", onStdoutClose);
    }

    // Install stream error handling before the first database await. The pipeline
    // owns file completion, backpressure and premature-close/error propagation.
    await pipeline(async function* ({ signal }) {
      await pool.query(`SET search_path TO ${SCHEMA}, public`);
      while (!done) {
        signal.throwIfAborted();
        const batchLimit = hardLimit !== null
          ? Math.min(BATCH_SIZE, hardLimit - exported)
          : BATCH_SIZE;
        const batchParams = [...params, batchLimit, offset];
        const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
        const sql = `
          SELECT ${SELECT_FIELDS}
          FROM   ${SCHEMA}.fragments
          ${whereClause}
          ORDER  BY created_at ASC
          LIMIT  $${batchParams.length - 1}
          OFFSET $${batchParams.length}
        `;

        const { rows } = await pool.query(sql, batchParams);
        signal.throwIfAborted();
        for (const row of rows) {
          if (useJsonArray) allRows.push(row);
          else yield JSON.stringify(row) + "\n";
        }
        exported += rows.length;
        offset   += rows.length;

        if (rows.length < BATCH_SIZE) done = true;
        if (hardLimit !== null && exported >= hardLimit) done = true;
      }
      if (useJsonArray) {
        yield JSON.stringify(allRows, null, 2) + (outputFile ? "\n" : "");
      }
    }, outStream);

    process.stderr.write(`Exported ${exported} fragments\n`);
  } catch (err) {
    console.error(`[export] ${err.message}`);
    process.exitCode = 1;
  } finally {
    if (onStdoutError) process.stdout.removeListener("error", onStdoutError);
    if (onStdoutClose) process.stdout.removeListener("close", onStdoutClose);
    if (pool) await pool.end();
  }
}
