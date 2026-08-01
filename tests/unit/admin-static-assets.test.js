/**
 * Admin 정적 자산 서빙 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-03-26
 *
 * 인증 테스트(401)는 MEMENTO_ACCESS_KEY 환경변수가 모듈 로드 전에 설정되어야 한다.
 * 전체 suite 실행 시 config.js 캐시로 인해 인증 테스트가 skip될 수 있으며,
 * 이 경우 단독 실행으로 검증: MEMENTO_ACCESS_KEY=test node --test tests/unit/admin-static-assets.test.js
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { handleAdminStatic } from "../../lib/admin/admin-routes.js";
import { ACCESS_KEY } from "../../lib/config.js";

const TEST_KEY = ACCESS_KEY || "test-fallback-key";

/** mock request */
function mockReq(urlPath, { masterKey = null } = {}) {
  const headers = {};
  if (masterKey) headers.authorization = `Bearer ${masterKey}`;
  return { method: "GET", url: urlPath, headers };
}

/** mock response (콜백 기반) */
function mockRes(cb) {
  const res = {
    statusCode: 200,
    _headers:   {},
    setHeader(k, v) { res._headers[k.toLowerCase()] = v; },
    end(data) {
      res._body = data;
      cb(res);
    },
  };
  return res;
}

describe("handleAdminStatic", () => {

  it("serves admin.css with text/css content-type", (_, done) => {
    const req = mockReq("/v1/internal/model/nothing/assets/admin.css", { masterKey: TEST_KEY });
    const res = mockRes((r) => {
      assert.strictEqual(r.statusCode, 200);
      assert.strictEqual(r._headers["content-type"], "text/css");
      done();
    });
    handleAdminStatic(req, res);
  });

  it("serves admin.js with application/javascript content-type", (_, done) => {
    const req = mockReq("/v1/internal/model/nothing/assets/admin.js", { masterKey: TEST_KEY });
    const res = mockRes((r) => {
      assert.strictEqual(r.statusCode, 200);
      assert.strictEqual(r._headers["content-type"], "application/javascript");
      done();
    });
    handleAdminStatic(req, res);
  });

  it("rejects path traversal attempts with 403", (_, done) => {
    const req = mockReq("/v1/internal/model/nothing/assets/../../../etc/passwd", { masterKey: TEST_KEY });
    const res = mockRes((r) => {
      assert.ok(r.statusCode === 403 || r.statusCode === 404,
        `Expected 403 or 404, got ${r.statusCode}`);
      done();
    });
    handleAdminStatic(req, res);
  });

  it("rejects disallowed extensions with 404", (_, done) => {
    const req = mockReq("/v1/internal/model/nothing/assets/script.sh", { masterKey: TEST_KEY });
    const res = mockRes((r) => {
      assert.strictEqual(r.statusCode, 404);
      done();
    });
    handleAdminStatic(req, res);
  });

  it("serves assets without auth (browser resource requests have no auth header)", (_, done) => {
    const req = mockReq("/v1/internal/model/nothing/assets/admin.css");
    const res = mockRes((r) => {
      assert.strictEqual(r.statusCode, 200);
      done();
    });
    handleAdminStatic(req, res);
  });

  it("returns 404 for non-existent file", (_, done) => {
    const req = mockReq("/v1/internal/model/nothing/assets/nonexistent.css", { masterKey: TEST_KEY });
    const res = mockRes((r) => {
      assert.strictEqual(r.statusCode, 404);
      done();
    });
    handleAdminStatic(req, res);
  });
});
