import { test, after } from "node:test";
import assert from "node:assert/strict";

import {
  createStreamableSession,
  validateStreamableSession,
  closeStreamableSession
} from "../../lib/sessions.js";
import { teardownTestResources, assertCleanShutdown } from "../_lifecycle.js";

/**
 * lib/sessions.js import 체인이 Redis ioredis 클라이언트를 즉시 연결하므로
 * 테스트 종료 후 lifecycle helper로 정리하지 않으면 event loop가 유지되어
 * node:test가 "Promise resolution is still pending" 메시지와 함께 cleanup hang.
 *
 * MEMENTO_METRICS_DEFAULT=off (CP2) 적용 후 prom-client collectDefaultMetrics
 * timer가 비활성화되므로 assertCleanShutdown이 active handle 0을 검증할 수 있다.
 */
after(async () => {
  await teardownTestResources();
  await assertCleanShutdown();
});

test("streamable SSE writes initial comment and flushes headers", async () => {
  const sessionId = await createStreamableSession(true);
  const { valid, session } = await validateStreamableSession(sessionId);

  assert.strictEqual(valid, true);

  const writes = [];
  let flushed = 0;

  session.setSseResponse({
    flushHeaders() {
      flushed += 1;
    },
    write(chunk) {
      writes.push(chunk);
    },
    end() {}
  });

  assert.strictEqual(flushed, 1);
  assert.deepStrictEqual(writes.slice(0, 1), [": connected\n\n"]);

  await closeStreamableSession(sessionId);
});

test("streamable SSE clears heartbeat when response is detached", async () => {
  const sessionId = await createStreamableSession(true);
  const { valid, session } = await validateStreamableSession(sessionId);

  assert.strictEqual(valid, true);

  let ended = 0;

  session.setSseResponse({
    flushHeaders() {},
    write() {},
    end() {
      ended += 1;
    }
  });

  session.setSseResponse(null);
  await closeStreamableSession(sessionId);

  assert.strictEqual(ended, 0);
});
