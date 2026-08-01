/**
 * Fail-closed 인증 단위 테스트
 *
 * 작성자: Weasley Open Source
 * 작성일: 2026-04-10
 *
 * 검증 대상:
 *   - WEASLEY_DEEPMIND_ACCESS_KEY="" + AUTH_DISABLED 미설정 → fail-closed
 *   - WEASLEY_DEEPMIND_ACCESS_KEY="" + AUTH_DISABLED=true  → master 허용
 *   - ACCESS_KEY 설정 + 헤더 정상 → valid: true
 *   - ACCESS_KEY 설정 + 헤더 누락 → valid: false
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveAuthConfig, buildAuthDecision } from "../../lib/auth.js";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));

describe("resolveAuthConfig — fail-closed 설정 해석", () => {

  it("빈 ACCESS_KEY + AUTH_DISABLED=false → { accessKey: '', authDisabled: false }", () => {
    const cfg = resolveAuthConfig("", false);
    assert.strictEqual(cfg.accessKey, "");
    assert.strictEqual(cfg.authDisabled, false);
  });

  it("빈 ACCESS_KEY + AUTH_DISABLED=true → { accessKey: '', authDisabled: true }", () => {
    const cfg = resolveAuthConfig("", true);
    assert.strictEqual(cfg.accessKey, "");
    assert.strictEqual(cfg.authDisabled, true);
  });

  it("비어있지 않은 ACCESS_KEY + AUTH_DISABLED=false → 정상 설정", () => {
    const cfg = resolveAuthConfig("wdm_test_abcd", false);
    assert.strictEqual(cfg.accessKey, "wdm_test_abcd");
    assert.strictEqual(cfg.authDisabled, false);
  });

});

describe("buildAuthDecision — fail-closed 인증 결정", () => {

  /**
   * 케이스 1: ACCESS_KEY="" + AUTH_DISABLED=false → fail-closed
   * 익명 master 권한 획득 경로 차단
   */
  it("케이스 1: 빈 ACCESS_KEY + AUTH_DISABLED 미설정 → { valid: false, reason: 'access_key_required' }", () => {
    const result = buildAuthDecision("", false, null);
    assert.strictEqual(result.valid, false);
    assert.ok(
      result.reason === "access_key_required" || result.error === "access_key_required",
      `예상 reason 'access_key_required', 실제: ${JSON.stringify(result)}`
    );
  });

  /**
   * 케이스 2: ACCESS_KEY="" + AUTH_DISABLED=true → master 허용 (opt-in)
   * 명시적 WEASLEY_DEEPMIND_AUTH_DISABLED=true opt-in만 허용
   */
  it("케이스 2: 빈 ACCESS_KEY + AUTH_DISABLED=true → { valid: true, authDisabled: true }", () => {
    const result = buildAuthDecision("", true, null);
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.authDisabled, true);
  });

  /**
   * 케이스 3: 정상 ACCESS_KEY + bearerToken 일치 → { valid: true, keyId: null }
   * master 키 인증 성공 경로
   */
  it("케이스 3: ACCESS_KEY 설정 + 올바른 bearerToken → { valid: true, keyId: null }", () => {
    const result = buildAuthDecision("wdm_test_abcd", false, "wdm_test_abcd");
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.keyId, null);
  });

  /**
   * 케이스 4: ACCESS_KEY 설정 + bearerToken 누락 → { valid: false }
   */
  it("케이스 4: ACCESS_KEY 설정 + bearerToken 없음 → { valid: false }", () => {
    const result = buildAuthDecision("wdm_test_abcd", false, null);
    assert.strictEqual(result.valid, false);
  });

  /**
   * 케이스 5: ACCESS_KEY 설정 + bearerToken 불일치 → { valid: false }
   */
  it("케이스 5: ACCESS_KEY 설정 + 잘못된 bearerToken → { valid: false }", () => {
    const result = buildAuthDecision("wdm_test_abcd", false, "wrong_key");
    assert.strictEqual(result.valid, false);
  });

});

describe("validateAuthentication — runtime fail-closed wiring", () => {
  it("does not grant anonymous master access when no key is configured", () => {
    const env = { ...process.env, DOTENV_CONFIG_PATH: ".env.missing-for-auth-test" };
    for (const key of [
      "WEASLEY_DEEPMIND_ACCESS_KEY",
      "WEASLEY_DEEPMIND_AUTH_DISABLED",
      "WEASLEY_DEEPMIND_ACCESS_KEY",
      "WEASLEY_DEEPMIND_AUTH_DISABLED"
    ]) {
      delete env[key];
    }

    const script = [
      'const { validateAuthentication } = await import("./lib/auth.js");',
      'const result = await validateAuthentication({ headers: {} }, null);',
      'if (result.valid || result.error !== "Server authentication is not configured. Set WEASLEY_DEEPMIND_ACCESS_KEY or explicitly opt out with WEASLEY_DEEPMIND_AUTH_DISABLED=true for local development.") process.exit(1);'
    ].join("\n");

    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: projectRoot,
      env,
      encoding: "utf8"
    });

    assert.strictEqual(result.status, 0, result.stderr || result.stdout);
  });
});
