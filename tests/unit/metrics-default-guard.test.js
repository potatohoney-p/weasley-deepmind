/**
 * metrics-default-guard.test.js
 *
 * WEASLEY_DEEPMIND_METRICS_DEFAULT 환경변수에 따른 collectDefaultMetrics 가드 동작 검증.
 * 모듈 캐시를 우회하기 위해 각 케이스마다 fresh import 를 사용한다.
 *
 * 작성자: Weasley Open Source
 * 작성일: 2026-04-20
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

/** prom-client default metrics 이름 패턴 (node.js 공통 접두사) */
const DEFAULT_METRIC_PREFIX = "mcp_process_";

/**
 * metrics.js 를 캐시 무효화 후 fresh import 한다.
 * Node ESM 캐시는 query string으로 무력화한다.
 */
async function importFreshMetrics(suffix) {
  const url = new URL(`../../lib/metrics.js?bust=${suffix}`, import.meta.url).href;
  return import(url);
}

describe("metrics-default-guard", () => {
  const originalEnv = process.env.WEASLEY_DEEPMIND_METRICS_DEFAULT;

  after(() => {
    // 원래 환경 복원
    if (originalEnv === undefined) {
      delete process.env.WEASLEY_DEEPMIND_METRICS_DEFAULT;
    } else {
      process.env.WEASLEY_DEEPMIND_METRICS_DEFAULT = originalEnv;
    }
  });

  it("WEASLEY_DEEPMIND_METRICS_DEFAULT=off 시 default metrics 가 register 에 미등록", async () => {
    process.env.WEASLEY_DEEPMIND_METRICS_DEFAULT = "off";
    const { register } = await importFreshMetrics("off-1");

    const metrics     = await register.getMetricsAsJSON();
    const hasDefault  = metrics.some(m => m.name.startsWith(DEFAULT_METRIC_PREFIX));

    assert.equal(
      hasDefault,
      false,
      `WEASLEY_DEEPMIND_METRICS_DEFAULT=off 임에도 default metric 이 등록됨: ${
        metrics.filter(m => m.name.startsWith(DEFAULT_METRIC_PREFIX)).map(m => m.name).join(", ")
      }`
    );
  });

  it("WEASLEY_DEEPMIND_METRICS_DEFAULT=off 시 커스텀 메트릭(mcp_http_requests_total)은 정상 존재", async () => {
    process.env.WEASLEY_DEEPMIND_METRICS_DEFAULT = "off";
    const { register } = await importFreshMetrics("off-2");

    const metrics = await register.getMetricsAsJSON();
    const found   = metrics.some(m => m.name === "mcp_http_requests_total");

    assert.equal(found, true, "mcp_http_requests_total 이 register 에 없음");
  });

  it("WEASLEY_DEEPMIND_METRICS_DEFAULT 미설정 시 default metrics 가 register 에 등록됨", async () => {
    delete process.env.WEASLEY_DEEPMIND_METRICS_DEFAULT;
    const { register } = await importFreshMetrics("on-1");

    const metrics    = await register.getMetricsAsJSON();
    const hasDefault = metrics.some(m => m.name.startsWith(DEFAULT_METRIC_PREFIX));

    assert.equal(
      hasDefault,
      true,
      "WEASLEY_DEEPMIND_METRICS_DEFAULT 미설정 임에도 default metric 이 미등록"
    );
  });

  it("WEASLEY_DEEPMIND_METRICS_DEFAULT=off 시 register 에 prom-client 내부 interval 이 없어 즉시 종료 가능", async () => {
    process.env.WEASLEY_DEEPMIND_METRICS_DEFAULT = "off";
    // importFreshMetrics 만으로 hang 이 없으면 pass — 별도 타임아웃 감지는 runner 가 담당
    const { register } = await importFreshMetrics("off-3");
    assert.ok(register, "register export 가 정상 반환됨");
  });
});
