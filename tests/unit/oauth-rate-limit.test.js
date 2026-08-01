/**
 * OAuth + Admin rate limit 및 body cap 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-04-10
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { RateLimiter, DualRateLimiter } from "../../lib/rate-limiter.js";
import { readJsonBody, readRawBody } from "../../lib/utils.js";

/* ------------------------------------------------------------------ */
/*  공통 유틸리티                                                       */
/* ------------------------------------------------------------------ */

/**
 * 지정 크기의 페이로드를 흘려 보내는 가짜 Request Readable 생성
 */
function fakeReqWithBody(bodyStr) {
  const req    = new Readable({ read() {} });
  req.method   = "POST";
  req.url      = "/register";
  req.headers  = { "content-type": "application/json", host: "localhost" };
  req.socket   = { remoteAddress: "127.0.0.1" };
  req.push(Buffer.from(bodyStr, "utf8"));
  req.push(null);
  return req;
}

/* ------------------------------------------------------------------ */
/*  body cap 테스트                                                     */
/* ------------------------------------------------------------------ */

describe("OAuth POST /register body cap", () => {
  it("accepts body within 2MB limit", async () => {
    const body = JSON.stringify({ redirect_uris: ["https://example.com/callback"] });
    const req  = fakeReqWithBody(body);
    const result = await readJsonBody(req);
    assert.ok(Array.isArray(result.redirect_uris));
  });

  it("rejects body exceeding 1MB custom limit with statusCode 413", async () => {
    const oversized = "x".repeat(1_100_000);
    const req       = fakeReqWithBody(oversized);
    let thrown;
    try {
      await readJsonBody(req, 1_000_000);
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown, "should have thrown");
    assert.strictEqual(thrown.statusCode, 413);
    assert.strictEqual(thrown.message, "Payload too large");
  });
});

describe("readRawBody body cap", () => {
  it("rejects body exceeding limit with statusCode 413", async () => {
    const oversized = "a".repeat(1_100_000);
    const req       = fakeReqWithBody(oversized);
    let thrown;
    try {
      await readRawBody(req, 1_000_000);
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown, "should have thrown");
    assert.strictEqual(thrown.statusCode, 413);
  });

  it("accepts body within limit and returns raw string", async () => {
    const content = "grant_type=authorization_code&code=abc123";
    const req     = fakeReqWithBody(content);
    const result  = await readRawBody(req);
    assert.strictEqual(result, content);
  });
});

/* ------------------------------------------------------------------ */
/*  Rate limiter: admin auth brute force (IP 기반 101번 → 429)          */
/* ------------------------------------------------------------------ */

describe("Admin auth brute force rate limit", () => {
  it("allows first 100 requests and blocks the 101st (IP-based)", () => {
    const limiter = new DualRateLimiter({
      windowMs: 60_000,
      perIp:    100,
      perKey:   1000
    });

    const clientIp = "10.0.0.1";
    let allowed    = 0;
    let blocked    = 0;

    for (let i = 0; i < 101; i++) {
      if (limiter.allow(clientIp)) {
        allowed++;
      } else {
        blocked++;
      }
    }

    assert.strictEqual(allowed, 100, "first 100 should be allowed");
    assert.strictEqual(blocked,   1, "101st should be blocked (429)");
  });

  it("different IPs have independent limits", () => {
    const limiter = new DualRateLimiter({
      windowMs: 60_000,
      perIp:    5,
      perKey:   1000
    });

    for (let i = 0; i < 5; i++) limiter.allow("10.0.0.1");
    assert.strictEqual(limiter.allow("10.0.0.1"), false, "IP 1 should be blocked");
    assert.ok(limiter.allow("10.0.0.2"), "IP 2 should still be allowed");
  });
});

/* ------------------------------------------------------------------ */
/*  Rate limiter: OAuth /register 경로 IP rate limit                   */
/* ------------------------------------------------------------------ */

describe("OAuth register rate limit", () => {
  it("blocks IP after perIp limit", () => {
    const limiter = new RateLimiter({ windowMs: 60_000, maxRequests: 30 });
    const ip      = "ip:192.168.0.1";

    for (let i = 0; i < 30; i++) limiter.allow(ip);
    assert.strictEqual(limiter.allow(ip), false);
  });
});
