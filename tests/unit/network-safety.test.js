import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { assertSafeAuthBinding, isLoopbackHost } from "../../lib/network-safety.js";

describe("unauthenticated HTTP network boundary", () => {
  it("recognizes IPv4, IPv6, and hostname loopback listeners", () => {
    for (const host of ["127.0.0.1", "127.10.20.30", "::1", "[::1]", "localhost"]) {
      assert.equal(isLoopbackHost(host), true, host);
    }
  });

  it("rejects wildcard and routable listeners when authentication is disabled", () => {
    for (const host of ["0.0.0.0", "::", "192.168.1.10", "deepmind.example.com"]) {
      assert.throws(
        () => assertSafeAuthBinding({ host, accessKey: "", authDisabled: true }),
        /allowed only on a loopback listener/
      );
    }
  });

  it("allows a non-loopback listener when a bearer key is configured", () => {
    assert.doesNotThrow(() => assertSafeAuthBinding({
      host: "0.0.0.0",
      accessKey: "configured-secret",
      authDisabled: true
    }));
  });
});
