import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import RedisParser from "redis-parser";
import { EmbeddingCache } from "../../lib/memory/embedding/EmbeddingCache.js";

function payload(values, offset = 0, suffix = 0) {
  const bytes = Buffer.from(new Float32Array(values).buffer);
  const backing = Buffer.alloc(bytes.length + offset + suffix, 0xaa);
  bytes.copy(backing, offset);
  return backing.subarray(offset, offset + bytes.length + suffix);
}

function reader(bytes) {
  return new EmbeddingCache({ redis: { status: "ready", getBuffer: async () => bytes } });
}

describe("embedding cache binary payload integrity", () => {
  for (const offset of [0, 1, 2, 3, 4, 7]) {
    it(`decodes the exact view at byte offset ${offset}`, async () => {
      const values = [0.25, -1.5, 0, 32768];
      assert.deepEqual(await reader(payload(values, offset)).get("query"), values);
    });
  }
  it("decodes the actual ioredis RESP parser's unaligned bulk reply", async () => {
    const values = [0.25, -1.5, 0, 32768];
    const bytes = payload(values);
    let reply;
    const parser = new RedisParser({
      returnBuffers: true,
      returnReply: value => { reply = value; },
      returnError: error => { throw error; }
    });
    // The 5-byte RESP bulk header creates an unaligned view of the payload.
    const frame = Buffer.alloc(bytes.length + 7);
    frame.write(`$${bytes.length}\r\n`);
    bytes.copy(frame, 5);
    frame.write("\r\n", bytes.length + 5);
    parser.execute(frame);
    assert.equal(reply.byteOffset % 4, 1);
    assert.deepEqual(await reader(reply).get("query"), values);
  });
  for (const tail of [1, 2, 3]) {
    it(`rejects ${tail} trailing bytes rather than truncating a vector`, async () => {
      assert.equal(await reader(payload([1, 2], 0, tail)).get("query"), null);
    });
  }
  it("rejects empty and non-buffer payloads", async () => {
    for (const value of [Buffer.alloc(0), "abcd", new Uint8Array(4)]) {
      assert.equal(await reader(value).get("query"), null);
    }
  });
  it("rejects nonfinite cached coordinates", async () => {
    for (const value of [NaN, Infinity, -Infinity]) {
      assert.equal(await reader(payload([1, value])).get("query"), null);
    }
  });
  it("does not publish empty, nonfinite or Float32-overflow vectors", () => {
    const redis = { status: "ready", set: mock.fn(async () => "OK") };
    const cache = new EmbeddingCache({ redis });
    for (const vector of [[], [NaN], [Infinity], [-Infinity], [Number.MAX_VALUE]]) {
      cache.set("query", vector);
    }
    assert.equal(redis.set.mock.calls.length, 0);
  });
  it("preserves the existing Float32 wire bytes and TTL for finite vectors", async () => {
    let stored;
    const redis = {
      status: "ready",
      set: mock.fn(async (_key, bytes) => { stored = bytes; }),
      getBuffer: async () => stored
    };
    const cache = new EmbeddingCache({ redis, ttlSeconds: 90 });
    const vector = [0.1, -0.2, 1e-30];
    cache.set("query", vector);
    assert.deepEqual(stored, Buffer.from(new Float32Array(vector).buffer));
    assert.deepEqual(await cache.get("query"), Array.from(new Float32Array(vector)));
    assert.deepEqual(redis.set.mock.calls[0].arguments.slice(2), ["EX", 90]);
  });
});
