/**
 * CSRF Origin 검증 단위 테스트 (session-handler.js: isRotateOriginAllowed)
 *
 * 작성자: 최진호
 * 작성일: 2026-04-20
 *
 * isRotateOriginAllowed는 handleSessionRotate 내부 함수이므로
 * HTTP 핸들러를 직접 호출하여 403/200 응답 코드로 간접 검증한다.
 *
 * 검증 대상:
 *  1. Origin 헤더 없음 + 비-localhost 소켓 → 403
 *  2. 알 수 없는 외부 Origin → 403 (화이트리스트 설정 시)
 *  3. 화이트리스트 포함 Origin → 통과 (auth 실패로 401)
 *  4. localhost Origin → 항상 통과 (auth 실패로 401)
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";

process.env.DOTENV_CONFIG_PATH ??= ".env.test";
process.env.MEMENTO_METRICS_DEFAULT ??= "off";
process.env.REDIS_ENABLED ??= "false";
process.env.CACHE_ENABLED ??= "false";

const { teardownTestResources } = await import("../_lifecycle.js");

/** 공통 fake 응답 헬퍼 */
function fakeRes() {
  const _headers = {};
  const res      = {
    statusCode  : 0,
    _body       : null,
    _headers,
    setHeader(k, v)    { _headers[k.toLowerCase()] = v; },
    getHeader(k)       { return _headers[k.toLowerCase()]; },
    writeHead(code, h) { res.statusCode = code; if (h) Object.assign(_headers, h); },
    end(body)          { res._body = body ?? ""; },
    write()            {}
  };
  return res;
}

/** fake req 헬퍼 */
function fakeReq({ origin, remoteAddress = "203.0.113.5" } = {}) {
  const headers = {
    "content-type": "application/json",
  };
  if (origin !== undefined) headers["origin"] = origin;

  const body   = JSON.stringify({});
  const stream = Readable.from([body]);
  stream.headers      = headers;
  stream.method       = "POST";
  stream.url          = "/session/rotate";
  stream.socket       = { remoteAddress };
  stream.headers      = headers;

  return stream;
}

describe("handleSessionRotate: CSRF Origin 검증", () => {
  let handleSessionRotate;

  before(async () => {
    /** auth 우회 — CSRF/rate-limit 계층만 단위 검증하기 위해 인증 비활성화 */
    process.env.MEMENTO_AUTH_DISABLED = "true";
    ({ handleSessionRotate } = await import("../../lib/handlers/session-handler.js"));
  });

  after(async () => {
    await teardownTestResources();
  });

  /** 화이트리스트가 비어 있을 때 (기본) 외부 Origin도 통과하는지 확인 */
  it("ALLOWED_ORIGINS 비어 있을 때: Origin 없음 + 비-localhost 소켓 → 403", async () => {
    /** origin 헤더 없고, 소켓 IP가 외부 IP */
    const req = fakeReq({ remoteAddress: "203.0.113.5" });
    const res = fakeRes();

    await handleSessionRotate(req, res);
    /** origin 없고 비-localhost 소켓이면 403 */
    assert.strictEqual(res.statusCode, 403, `statusCode=${res.statusCode}`);
  });

  it("localhost Origin → CSRF 허용 (403이 아님)", async () => {
    const req = fakeReq({ origin: "http://localhost:3000", remoteAddress: "127.0.0.1" });
    const res = fakeRes();

    await handleSessionRotate(req, res);
    /** CSRF 통과 → 403이 아닌 다른 에러(400/401/404) */
    assert.notStrictEqual(res.statusCode, 403, "localhost가 CSRF로 거부됨");
    assert.ok(res.statusCode > 0, "응답 없음");
  });

  it("127.0.0.1 Origin → CSRF 허용 (403이 아님)", async () => {
    const req = fakeReq({ origin: "http://127.0.0.1:8080", remoteAddress: "127.0.0.1" });
    const res = fakeRes();

    await handleSessionRotate(req, res);
    assert.notStrictEqual(res.statusCode, 403, "127.0.0.1이 CSRF로 거부됨");
    assert.ok(res.statusCode > 0, "응답 없음");
  });

  it("ALLOWED_ORIGINS 설정 시 외부 미등록 Origin → 403", async () => {
    const original = process.env.ALLOWED_ORIGINS;
    process.env.ALLOWED_ORIGINS = "https://allowed.example.com";

    try {
      /** 모듈 캐시를 피하기 위해 config 재로드 없이 직접 동적 import */
      const { ALLOWED_ORIGINS: live } = await import("../../lib/config.js");
      /** 이 테스트는 ALLOWED_ORIGINS Set을 직접 조작해 검증한다 */
      live.clear();
      live.add("https://allowed.example.com");

      const req = fakeReq({ origin: "https://evil.example.com", remoteAddress: "1.2.3.4" });
      const res = fakeRes();

      await handleSessionRotate(req, res);
      assert.strictEqual(res.statusCode, 403, `외부 미등록 Origin이 허용됨: statusCode=${res.statusCode}`);
    } finally {
      /** 테스트 후 원상 복구 */
      const { ALLOWED_ORIGINS: live } = await import("../../lib/config.js");
      live.clear();
      if (original) {
        original.split(",").map(v => v.trim()).filter(Boolean).forEach(o => live.add(o));
      }
      if (original === undefined) delete process.env.ALLOWED_ORIGINS;
      else process.env.ALLOWED_ORIGINS = original;
    }
  });

  it("화이트리스트 포함 Origin → CSRF 허용 (403이 아님)", async () => {
    const { ALLOWED_ORIGINS: live } = await import("../../lib/config.js");
    live.clear();
    live.add("https://trusted.example.com");

    try {
      const req = fakeReq({ origin: "https://trusted.example.com", remoteAddress: "1.2.3.4" });
      const res = fakeRes();

      await handleSessionRotate(req, res);
      /** CSRF 통과 → 403이 아닌 다른 에러(400/401/404) */
      assert.notStrictEqual(res.statusCode, 403, "화이트리스트 Origin이 CSRF로 거부됨");
      assert.ok(res.statusCode > 0, "응답 없음");
    } finally {
      live.clear();
    }
  });
});
