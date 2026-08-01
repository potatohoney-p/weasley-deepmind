/**
 * E2E 통합 테스트 공통 cleanup 모듈
 *
 * 각 테스트 파일 최상단에 `import "./_cleanup.js";` 한 줄로 사용한다.
 * 테스트 suite 종료 후 Redis/DB Pool 핸들을 명시적으로 닫아
 * Node 이벤트 루프가 자연 종료되도록 보장한다.
 *
 * assertCleanShutdown 옵션:
 * 통합 테스트는 외부 서비스(Redis, PostgreSQL, HTTP agent)와 연결되어
 * active handle이 unit 테스트보다 많을 수 있다. 필요 시 개별 파일에서
 * _lifecycle.js의 assertCleanShutdown을 직접 호출하고 ignoreNames를 확장한다.
 *
 *   import { assertCleanShutdown } from "../_lifecycle.js";
 *   after(async () => {
 *     await assertCleanShutdown({ ignoreNames: ["TCP", "TLSSocket"], ignoreRequests: true });
 *   });
 */

import { after }       from "node:test";
import { redisClient } from "../../lib/redis.js";

after(async () => {
  try { await redisClient.quit(); } catch (_) { /* noop */ }
  try {
    const { getPrimaryPool } = await import("../../lib/tools/db.js");
    await getPrimaryPool()?.end();
  } catch (_) { /* noop */ }
});
