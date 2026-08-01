import { test } from "node:test";
import assert from "node:assert/strict";

test("getClientIp returns first XFF entry when hops is undefined (legacy mode)", async () => {
  const { getClientIp } = await import("../../lib/http/helpers.js");
  const req = {
    headers: { "x-forwarded-for": "1.2.3.4, 5.6.7.8" },
    socket:  { remoteAddress: "10.0.0.1" }
  };
  assert.equal(getClientIp(req, undefined), "1.2.3.4");
});

test("getClientIp returns socket.remoteAddress when hops=0 (explicit no-trust)", async () => {
  const { getClientIp } = await import("../../lib/http/helpers.js");
  const req = {
    headers: { "x-forwarded-for": "1.2.3.4, 5.6.7.8" },
    socket:  { remoteAddress: "10.0.0.1" }
  };
  assert.equal(getClientIp(req, 0), "10.0.0.1");
});

test("getClientIp returns last hop when hops=1 (single trusted proxy)", async () => {
  const { getClientIp } = await import("../../lib/http/helpers.js");
  const req = {
    headers: { "x-forwarded-for": "1.2.3.4, 5.6.7.8" },
    socket:  { remoteAddress: "10.0.0.1" }
  };
  assert.equal(getClientIp(req, 1), "5.6.7.8");
});

test("getClientIp returns first hop when hops>=chain length", async () => {
  const { getClientIp } = await import("../../lib/http/helpers.js");
  const req = {
    headers: { "x-forwarded-for": "1.2.3.4, 5.6.7.8" },
    socket:  { remoteAddress: "10.0.0.1" }
  };
  assert.equal(getClientIp(req, 5), "1.2.3.4");
});

test("getClientIp falls back to socket.remoteAddress when XFF missing", async () => {
  const { getClientIp } = await import("../../lib/http/helpers.js");
  const req = { headers: {}, socket: { remoteAddress: "10.0.0.1" } };
  assert.equal(getClientIp(req, 1), "10.0.0.1");
  assert.equal(getClientIp(req, undefined), "10.0.0.1");
});

test("getClientIp trims whitespace and rejects empty entries", async () => {
  const { getClientIp } = await import("../../lib/http/helpers.js");
  const req = {
    headers: { "x-forwarded-for": " 1.2.3.4 ,  , 5.6.7.8 " },
    socket:  { remoteAddress: "10.0.0.1" }
  };
  assert.equal(getClientIp(req, 1), "5.6.7.8");
});
