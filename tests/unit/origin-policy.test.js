/**
 * Origin 정책 단위 테스트
 *
 * validateOrigin / validateAdminOrigin의 현재 호환성 기본값과 allowlist 동작을
 * 실제 export 기준으로 검증한다.
 */

import { describe, test, after } from "node:test";
import assert from "node:assert/strict";

process.env.DOTENV_CONFIG_PATH ??= ".env.test";
process.env.MEMENTO_METRICS_DEFAULT ??= "off";
process.env.REDIS_ENABLED ??= "false";
process.env.CACHE_ENABLED ??= "false";

const { validateOrigin } = await import("../../lib/http/helpers.js");
const { validateAdminOrigin } = await import("../../lib/admin/admin-auth.js");
const { ALLOWED_ORIGINS, ADMIN_ALLOWED_ORIGINS } = await import("../../lib/config.js");
const { teardownTestResources } = await import("../_lifecycle.js");

function fakeRes() {
  const res = { statusCode: 0, _body: null };
  res.end   = (body) => { res._body = body ?? ""; };
  return res;
}

async function withSetContents(targetSet, values, fn) {
  const original = [...targetSet];
  targetSet.clear();
  for (const value of values) targetSet.add(value);
  try {
    return await fn();
  } finally {
    targetSet.clear();
    for (const value of original) targetSet.add(value);
  }
}

after(async () => {
  await teardownTestResources();
});

describe("validateOrigin", () => {
  test("Origin 헤더 없음 -> 허용", async () => {
    await withSetContents(ALLOWED_ORIGINS, [], () => {
      const req = { headers: { host: "example.com" } };
      const res = fakeRes();
      assert.equal(validateOrigin(req, res), true);
      assert.equal(res.statusCode, 0);
    });
  });

  test("ALLOWED_ORIGINS 미설정 + cross-origin 요청 -> 허용", async () => {
    await withSetContents(ALLOWED_ORIGINS, [], () => {
      const req = { headers: { host: "example.com", origin: "https://evil.com" } };
      const res = fakeRes();
      assert.equal(validateOrigin(req, res), true);
      assert.equal(res.statusCode, 0);
    });
  });

  test("ALLOWED_ORIGINS 설정 + 화이트리스트 일치 -> 허용", async () => {
    await withSetContents(ALLOWED_ORIGINS, ["https://claude.ai"], () => {
      const req = { headers: { host: "memento.example.com", origin: "https://claude.ai" } };
      const res = fakeRes();
      assert.equal(validateOrigin(req, res), true);
      assert.equal(res.statusCode, 0);
    });
  });

  test("ALLOWED_ORIGINS 설정 + 화이트리스트 불일치 -> 거부", async () => {
    await withSetContents(ALLOWED_ORIGINS, ["https://claude.ai"], () => {
      const req = { headers: { host: "memento.example.com", origin: "https://evil.com" } };
      const res = fakeRes();
      assert.equal(validateOrigin(req, res), false);
      assert.equal(res.statusCode, 403);
      assert.equal(res._body, "Forbidden (Origin not allowed)");
    });
  });
});

describe("validateAdminOrigin", () => {
  test("Origin 헤더 없음 -> 허용", async () => {
    await withSetContents(ADMIN_ALLOWED_ORIGINS, [], () => {
      const req = { headers: { host: "admin.example.com" } };
      const res = fakeRes();
      assert.equal(validateAdminOrigin(req, res), true);
      assert.equal(res.statusCode, 0);
    });
  });

  test("ADMIN_ALLOWED_ORIGINS 미설정 + cross-origin 요청 -> 허용", async () => {
    await withSetContents(ADMIN_ALLOWED_ORIGINS, [], () => {
      const req = { headers: { host: "admin.example.com", origin: "https://attacker.com" } };
      const res = fakeRes();
      assert.equal(validateAdminOrigin(req, res), true);
      assert.equal(res.statusCode, 0);
    });
  });

  test("ADMIN_ALLOWED_ORIGINS 설정 + 화이트리스트 일치 -> 허용", async () => {
    await withSetContents(ADMIN_ALLOWED_ORIGINS, ["https://trusted-admin.example.com"], () => {
      const req = { headers: { host: "memento.example.com", origin: "https://trusted-admin.example.com" } };
      const res = fakeRes();
      assert.equal(validateAdminOrigin(req, res), true);
      assert.equal(res.statusCode, 0);
    });
  });

  test("ADMIN_ALLOWED_ORIGINS 설정 + 화이트리스트 불일치 -> 거부", async () => {
    await withSetContents(ADMIN_ALLOWED_ORIGINS, ["https://trusted-admin.example.com"], () => {
      const req = { headers: { host: "memento.example.com", origin: "https://evil.com" } };
      const res = fakeRes();
      assert.equal(validateAdminOrigin(req, res), false);
      assert.equal(res.statusCode, 403);
      assert.equal(res._body, "Forbidden (Admin origin not allowed)");
    });
  });
});
