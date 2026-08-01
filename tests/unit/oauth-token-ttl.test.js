/**
 * OAuth token TTL 설정 단위 테스트
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

process.env.DOTENV_CONFIG_PATH ??= ".env.test";

const { OAUTH_TOKEN_TTL_SECONDS, OAUTH_REFRESH_TTL_SECONDS } = await import("../../lib/config.js");

describe("OAuth token TTL", () => {
  test("access token TTL은 SESSION_TTL_MINUTES에서 초 단위로 산출된다", () => {
    const expected = Number(process.env.SESSION_TTL_MINUTES || 43200) * 60;
    assert.equal(OAUTH_TOKEN_TTL_SECONDS, expected);
  });

  test("refresh token TTL은 access token TTL의 2배다", () => {
    assert.equal(OAUTH_REFRESH_TTL_SECONDS, OAUTH_TOKEN_TTL_SECONDS * 2);
  });

  test("refresh token 만료 시각은 access token보다 늦다", () => {
    const now = Date.now();
    const accessExpiresAt  = now + OAUTH_TOKEN_TTL_SECONDS * 1000;
    const refreshExpiresAt = now + OAUTH_REFRESH_TTL_SECONDS * 1000;
    assert.ok(refreshExpiresAt > accessExpiresAt);
  });
});
