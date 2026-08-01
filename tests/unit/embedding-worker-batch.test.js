/**
 * EmbeddingWorker 배치화(_embedMany) 단위 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-04-27
 *
 * 시나리오:
 * a. 정상 50건 - generateBatchEmbeddings 1회 + UPDATE 1회
 * b. 빈 content 1건 사전 차단 - 49건만 batch
 * c. batch 400 응답 input[37] - dead-letter 1건, 나머지 49건 재batch
 * d. 인덱스 미명시 에러 - 전체 단건 fallback(_embedOne)
 */

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

const MOCK_CONFIG = {
  batchSize   : 200,
  intervalMs  : 100,
  retryLimit  : 3,
  retryDelayMs: 10,
  queueKey    : "test:embedding_queue"
};

/**
 * EmbeddingWorker의 _embedMany / _embedChunk / _embedOne 로직을
 * 의존성 주입 방식으로 재구현한 테스트용 클래스.
 */
class TestableEmbeddingWorkerBatch extends EventEmitter {
  constructor({ config, redis, db, embedding }) {
    super();
    this.config    = config;
    this.redis     = redis;
    this.db        = db;
    this.embedding = embedding;
  }

  async _embedMany(rows) {
    const valid = rows.filter(r => typeof r.content === "string" && r.content.trim().length > 0);
    if (valid.length === 0) return;

    const BYTE_CAP  = 256 * 1024;
    const COUNT_CAP = 200;

    const chunks = [];
    let   chunk  = [];
    let   bytes  = 0;

    for (const row of valid) {
      const rowBytes = Buffer.byteLength(row.content, "utf8");
      if (chunk.length > 0 && (bytes + rowBytes > BYTE_CAP || chunk.length >= COUNT_CAP)) {
        chunks.push(chunk);
        chunk = [];
        bytes = 0;
      }
      chunk.push(row);
      bytes += rowBytes;
    }
    if (chunk.length > 0) chunks.push(chunk);

    for (const chunkRows of chunks) {
      await this._embedChunk(chunkRows);
    }
  }

  async _embedChunk(chunkRows) {
    const texts = chunkRows.map(r => this.embedding.prepareText(r.content, 500));

    let vecs;
    try {
      vecs = await this.embedding.generateBatch(texts);
    } catch (err) {
      const indexMatch = /Invalid 'input\[(\d+)\]'/.exec(err.message || "");
      if (indexMatch) {
        const badIdx    = parseInt(indexMatch[1], 10);
        const badRow    = chunkRows[badIdx];
        const remaining = chunkRows.filter((_, i) => i !== badIdx);

        if (badRow) {
          const deadLetterKey = `queue:${this.config.queueKey}:dead`;
          await this.redis.lpush(deadLetterKey, JSON.stringify({
            fragmentId: badRow.id,
            error     : err.message,
            failedAt  : new Date().toISOString()
          }));
        }

        if (remaining.length > 0) {
          await this._embedChunk(remaining);
        }
        return;
      }

      for (const row of chunkRows) {
        await this._embedOne(row);
      }
      return;
    }

    if (vecs.length === 0) return;

    const valueParts = [];
    const params     = [];
    let   paramIdx   = 1;

    for (let i = 0; i < chunkRows.length && i < vecs.length; i++) {
      const vecStr = this.embedding.toSql(vecs[i]);
      valueParts.push(`($${paramIdx}::uuid, $${paramIdx + 1}::vector)`);
      params.push(chunkRows[i].id, vecStr);
      paramIdx += 2;
    }

    const sql = `UPDATE agent_memory.fragments AS f SET embedding = v.vec FROM (VALUES ${valueParts.join(", ")}) AS v(id, vec) WHERE f.id = v.id::uuid`;
    await this.db.query(sql, params);

    for (const row of chunkRows) {
      this.emit("embedding_ready", { fragmentId: row.id });
    }
    this.emit("embedding_batch_done", { count: chunkRows.length });
  }

  async _embedOne(row) {
    let lastError = null;
    for (let attempt = 1; attempt <= this.config.retryLimit; attempt++) {
      try {
        const text   = this.embedding.prepareText(row.content, 500);
        const vec    = await this.embedding.generate(text);
        const vecStr = this.embedding.toSql(vec);

        await this.db.query(
          `UPDATE agent_memory.fragments SET embedding = $2::vector WHERE id = $1`,
          [row.id, vecStr]
        );
        this.emit("embedding_ready", { fragmentId: row.id });
        return;
      } catch (err) {
        lastError = err;
        if (attempt < this.config.retryLimit) {
          await new Promise(r => setTimeout(r, this.config.retryDelayMs));
        }
      }
    }

    const deadLetterKey = `queue:${this.config.queueKey}:dead`;
    await this.redis.lpush(deadLetterKey, JSON.stringify({
      fragmentId: row.id,
      error     : lastError?.message || "unknown",
      failedAt  : new Date().toISOString()
    }));
  }
}

function makeRows(n, startIdx = 0) {
  return Array.from({ length: n }, (_, i) => ({
    id     : `frag-${String(startIdx + i).padStart(4, "0")}`,
    content: `content of fragment ${startIdx + i}`
  }));
}

describe("EmbeddingWorker _embedMany 배치화", () => {
  let worker;
  let mockRedis;
  let mockDb;
  let mockEmbedding;

  beforeEach(() => {
    mockRedis = {
      lpushCalls: [],
      async lpush(key, value) {
        this.lpushCalls.push({ key, value });
      }
    };

    mockDb = {
      queryCalls: [],
      async query(sql, params) {
        this.queryCalls.push({ sql, params });
        return { rows: [] };
      }
    };

    mockEmbedding = {
      batchCallCount  : 0,
      singleCallCount : 0,
      prepareText     : (content) => content,
      toSql           : (vec) => `[${vec.join(",")}]`,
      async generateBatch(texts) {
        this.batchCallCount++;
        return texts.map(() => [0.1, 0.2, 0.3]);
      },
      async generate() {
        this.singleCallCount++;
        return [0.1, 0.2, 0.3];
      }
    };

    worker = new TestableEmbeddingWorkerBatch({
      config   : MOCK_CONFIG,
      redis    : mockRedis,
      db       : mockDb,
      embedding: mockEmbedding
    });
  });

  test("a. 정상 50건 처리 - generateBatchEmbeddings 1회, UPDATE 1회", async () => {
    const rows         = makeRows(50);
    const batchDoneEvt = [];
    worker.on("embedding_batch_done", (e) => batchDoneEvt.push(e));

    await worker._embedMany(rows);

    assert.strictEqual(mockEmbedding.batchCallCount, 1, "generateBatchEmbeddings 호출 횟수");
    assert.strictEqual(mockEmbedding.singleCallCount, 0, "단건 generate 호출 없음");
    assert.strictEqual(mockDb.queryCalls.length, 1, "UPDATE 쿼리 1회");
    assert.ok(mockDb.queryCalls[0].sql.includes("VALUES"), "multi-row UPDATE SQL");
    assert.strictEqual(mockDb.queryCalls[0].params.length, 100, "50건 x 2 파라미터");
    assert.strictEqual(batchDoneEvt.length, 1, "embedding_batch_done 1회");
    assert.strictEqual(batchDoneEvt[0].count, 50, "count=50");
  });

  test("b. 빈 content 1건 사전 차단 - 49건만 batch 처리", async () => {
    const rows = makeRows(49);
    rows.splice(20, 0, { id: "frag-empty", content: "   " });
    assert.strictEqual(rows.length, 50);

    await worker._embedMany(rows);

    assert.strictEqual(mockEmbedding.batchCallCount, 1, "generateBatchEmbeddings 1회");
    assert.strictEqual(mockDb.queryCalls[0].params.length, 98, "49건 x 2 파라미터");

    const usedIds = mockDb.queryCalls[0].params.filter((_, i) => i % 2 === 0);
    assert.ok(!usedIds.includes("frag-empty"), "빈 content 파편 제외");
  });

  test("c. batch 400 input[37] 에러 - dead-letter 1건 + 나머지 49건 재batch", async () => {
    const rows    = makeRows(50);
    let firstCall = true;

    mockEmbedding.generateBatch = async function(texts) {
      this.batchCallCount++;
      if (firstCall) {
        firstCall = false;
        throw new Error("Invalid 'input[37]': string too long");
      }
      return texts.map(() => [0.1, 0.2, 0.3]);
    };

    await worker._embedMany(rows);

    assert.strictEqual(mockEmbedding.batchCallCount, 2, "첫 실패 + 재batch = 2회 호출");
    assert.strictEqual(mockRedis.lpushCalls.length, 1, "dead-letter 1건");

    const deadItem = JSON.parse(mockRedis.lpushCalls[0].value);
    assert.strictEqual(deadItem.fragmentId, rows[37].id, "37번 파편이 dead-letter");

    const updateCalls = mockDb.queryCalls.filter(q => q.sql.includes("UPDATE"));
    assert.strictEqual(updateCalls.length, 1, "UPDATE 1회 (49건)");
    assert.strictEqual(updateCalls[0].params.length, 98, "49건 x 2 파라미터");
  });

  test("d. 인덱스 미명시 에러 - 전체 단건 fallback(_embedOne) 호출", async () => {
    const rows = makeRows(5);

    mockEmbedding.generateBatch = async function() {
      this.batchCallCount++;
      throw new Error("Service unavailable");
    };

    const readyIds = [];
    worker.on("embedding_ready", (e) => readyIds.push(e.fragmentId));

    await worker._embedMany(rows);

    assert.strictEqual(mockEmbedding.batchCallCount, 1, "batch 1회 시도 후 fallback");
    assert.strictEqual(mockEmbedding.singleCallCount, 5, "단건 5회 fallback");
    assert.strictEqual(readyIds.length, 5, "5건 모두 embedding_ready 발행");
    assert.strictEqual(mockDb.queryCalls.length, 5, "UPDATE 5회 (단건)");
    assert.ok(mockDb.queryCalls[0].sql.includes("WHERE id = $1"), "단건 UPDATE SQL");
  });
});
