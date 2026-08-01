/**
 * Admin 세션 관리 API 계약 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-03-26
 *
 * GET /sessions, GET /sessions/:id, POST /sessions/:id/reflect,
 * DELETE /sessions/:id, POST /sessions/cleanup 엔드포인트 검증.
 * DB/Redis 의존성 없이 라우팅 + 응답 형태 계약만 단위 테스트.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";

const ADMIN_BASE      = "/v1/internal/model/nothing";
const SESSION_PREFIX  = `${ADMIN_BASE}/sessions`;
const TEST_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

/* ------------------------------------------------------------------ */
/*  공통 유틸리티                                                       */
/* ------------------------------------------------------------------ */

function fakeRes() {
  const _headers = {};
  const res      = {
    statusCode : 0,
    _body      : null,
    _headers,
    setHeader(k, v)    { _headers[k.toLowerCase()] = v; },
    writeHead(code, h) { res.statusCode = code; if (h) Object.assign(_headers, h); },
    end(body)          { res._body = body ?? ""; },
    write()            {}
  };
  return res;
}

function fakeReq({ method = "GET", pathname = "/", headers = {}, body = null } = {}) {
  const req = new Readable({ read() {} });
  req.method  = method;
  req.url     = pathname;
  req.headers = { ...headers };
  if (body) {
    req.push(JSON.stringify(body));
    req.push(null);
  }
  return req;
}

function validateMasterKey(req, accessKey) {
  if (!accessKey) return true;
  const auth = req.headers.authorization;
  if (!auth) return false;
  const match = auth.match(/^Bearer\s+(.+)$/i);
  if (!match) return false;
  return match[1] === accessKey;
}

/* ------------------------------------------------------------------ */
/*  라우팅 로직 재현 (세션 관리 엔드포인트)                               */
/* ------------------------------------------------------------------ */

async function routeSessionApi(req, res, {
  accessKey                  = "test-master-key",
  streamableSessions         = new Map(),
  legacySseSessions          = new Map(),
  pool                       = null,
  getSessionCountsFn         = () => ({ streamable: 0, legacy: 0, total: 0 }),
  getActivityFn              = async () => null,
  getUnreflectedSessionsFn   = async () => [],
  markReflectedFn            = async () => {},
  autoReflectFn              = async () => null,
  closeStreamableSessionFn   = async () => {},
  closeLegacySseSessionFn    = async () => {},
  cleanupExpiredSessionsFn   = async () => {},
  deleteActivityFn           = async () => {},
} = {}) {
  res.setHeader("access-control-allow-origin", req.headers.origin || "*");
  res.setHeader("content-type", "application/json; charset=utf-8");

  const url = new URL(req.url || "/", "http://localhost");

  if (!validateMasterKey(req, accessKey)) {
    res.statusCode = 401;
    res.end(JSON.stringify({ error: "Unauthorized" }));
    return;
  }

  /** POST /sessions/cleanup */
  if (req.method === "POST" && url.pathname === `${SESSION_PREFIX}/cleanup`) {
    try {
      await cleanupExpiredSessionsFn();
      res.statusCode = 200;
      res.end(JSON.stringify({ ok: true, message: "Cleanup completed" }));
    } catch (_err) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: "Internal error" }));
    }
    return;
  }

  /** POST /sessions/:id/reflect */
  const reflectMatch = url.pathname.match(
    /^\/v1\/internal\/model\/nothing\/sessions\/([0-9a-f-]{36})\/reflect$/
  );
  if (req.method === "POST" && reflectMatch) {
    try {
      const sessionId = reflectMatch[1];
      await autoReflectFn(sessionId);
      await markReflectedFn(sessionId);
      res.statusCode = 200;
      res.end(JSON.stringify({ ok: true }));
    } catch (_err) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: "Internal error" }));
    }
    return;
  }

  /** GET /sessions/:id */
  const sessionDetailMatch = url.pathname.match(
    /^\/v1\/internal\/model\/nothing\/sessions\/([0-9a-f-]{36})$/
  );
  if (req.method === "GET" && sessionDetailMatch) {
    try {
      const sessionId = sessionDetailMatch[1];
      let session     = streamableSessions.get(sessionId);
      let type        = "streamable";

      if (!session) {
        session = legacySseSessions.get(sessionId);
        type    = "legacy";
      }

      if (!session) {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: "Session not found" }));
        return;
      }

      const defaultPool = {
        query: async () => ({ rows: [] })
      };
      const p = pool || defaultPool;

      const [activity, searchEventsR, toolFeedbackR] = await Promise.all([
        getActivityFn(sessionId),
        p.query("search_events", [sessionId]),
        p.query("tool_feedback", [sessionId])
      ]);

      res.statusCode = 200;
      res.end(JSON.stringify({
        sessionId,
        type,
        authenticated:  session.authenticated ?? false,
        keyId:          session.keyId ?? null,
        createdAt:      session.createdAt ?? null,
        expiresAt:      session.expiresAt ?? null,
        lastAccessedAt: session.lastAccessedAt ?? null,
        activity:       activity ?? null,
        searchEvents:   searchEventsR.rows,
        toolFeedback:   toolFeedbackR.rows
      }));
    } catch (_err) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: "Internal error" }));
    }
    return;
  }

  /** DELETE /sessions/:id */
  const sessionDeleteMatch = url.pathname.match(
    /^\/v1\/internal\/model\/nothing\/sessions\/([0-9a-f-]{36})$/
  );
  if (req.method === "DELETE" && sessionDeleteMatch) {
    try {
      const sessionId = sessionDeleteMatch[1];

      if (streamableSessions.has(sessionId)) {
        await closeStreamableSessionFn(sessionId);
      } else if (legacySseSessions.has(sessionId)) {
        await closeLegacySseSessionFn(sessionId);
      }

      await deleteActivityFn(sessionId);
      res.statusCode = 200;
      res.end(JSON.stringify({ ok: true }));
    } catch (_err) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: "Internal error" }));
    }
    return;
  }

  /** GET /sessions */
  if (req.method === "GET" && url.pathname === SESSION_PREFIX) {
    try {
      const sessions = [];

      for (const [id, s] of streamableSessions.entries()) {
        sessions.push({
          sessionId:      id,
          type:           "streamable",
          authenticated:  s.authenticated ?? false,
          keyId:          s.keyId ?? null,
          createdAt:      s.createdAt ?? null,
          expiresAt:      s.expiresAt ?? null,
          lastAccessedAt: s.lastAccessedAt ?? null
        });
      }

      for (const [id, s] of legacySseSessions.entries()) {
        sessions.push({
          sessionId:      id,
          type:           "legacy",
          authenticated:  s.authenticated ?? false,
          keyId:          s.keyId ?? null,
          createdAt:      s.createdAt ?? null,
          expiresAt:      s.expiresAt ?? null,
          lastAccessedAt: s.lastAccessedAt ?? null
        });
      }

      const activityResults = await Promise.all(
        sessions.map(s => getActivityFn(s.sessionId))
      );
      for (let i = 0; i < sessions.length; i++) {
        sessions[i].activity = activityResults[i] ?? null;
      }

      const unreflected = await getUnreflectedSessionsFn(1000);
      const counts      = getSessionCountsFn();

      res.statusCode = 200;
      res.end(JSON.stringify({
        sessions,
        counts: {
          streamable:  counts.streamable,
          legacy:      counts.legacy,
          total:       counts.total,
          unreflected: unreflected.length
        }
      }));
    } catch (_err) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: "Internal error" }));
    }
    return;
  }

  res.statusCode = 404;
  res.end(JSON.stringify({ error: "Not found" }));
}

/* ================================================================== */
/*  테스트: GET /sessions — 세션 목록 조회                               */
/* ================================================================== */

describe("GET /sessions — session list", () => {
  const MASTER_KEY = "test-key";
  const now        = Date.now();

  it("sessions 배열과 counts 객체를 포함한 응답 반환", async () => {
    const streamable = new Map();
    streamable.set(TEST_SESSION_ID, {
      authenticated:  true,
      keyId:          null,
      createdAt:      now,
      expiresAt:      now + 3600000,
      lastAccessedAt: now
    });

    const legacy = new Map();
    legacy.set("11111111-2222-3333-4444-555555555555", {
      authenticated:  false,
      keyId:          "42",
      createdAt:      now - 1000,
      expiresAt:      now + 3600000,
      lastAccessedAt: now - 500
    });

    const req = fakeReq({
      method:   "GET",
      pathname: SESSION_PREFIX,
      headers:  { authorization: `Bearer ${MASTER_KEY}` }
    });
    const res = fakeRes();

    await routeSessionApi(req, res, {
      accessKey:          MASTER_KEY,
      streamableSessions: streamable,
      legacySseSessions:  legacy,
      getSessionCountsFn: () => ({ streamable: 1, legacy: 1, total: 2 }),
      getActivityFn:      async () => ({ toolCalls: { remember: 3 } }),
      getUnreflectedSessionsFn: async () => [TEST_SESSION_ID]
    });

    assert.strictEqual(res.statusCode, 200);
    const body = JSON.parse(res._body);

    assert.ok(Array.isArray(body.sessions));
    assert.strictEqual(body.sessions.length, 2);
    assert.strictEqual(body.sessions[0].sessionId, TEST_SESSION_ID);
    assert.strictEqual(body.sessions[0].type, "streamable");
    assert.strictEqual(body.sessions[0].authenticated, true);
    assert.strictEqual(body.sessions[1].type, "legacy");
    assert.strictEqual(body.sessions[1].keyId, "42");

    assert.strictEqual(typeof body.counts, "object");
    assert.strictEqual(body.counts.streamable, 1);
    assert.strictEqual(body.counts.legacy, 1);
    assert.strictEqual(body.counts.total, 2);
    assert.strictEqual(body.counts.unreflected, 1);

    assert.ok(body.sessions[0].activity !== null);
  });

  it("세션 없으면 빈 배열 반환", async () => {
    const req = fakeReq({
      method:   "GET",
      pathname: SESSION_PREFIX,
      headers:  { authorization: `Bearer ${MASTER_KEY}` }
    });
    const res = fakeRes();

    await routeSessionApi(req, res, { accessKey: MASTER_KEY });

    assert.strictEqual(res.statusCode, 200);
    const body = JSON.parse(res._body);
    assert.strictEqual(body.sessions.length, 0);
    assert.strictEqual(body.counts.total, 0);
  });

  it("인증 실패 시 401 반환", async () => {
    const req = fakeReq({
      method:   "GET",
      pathname: SESSION_PREFIX,
      headers:  {}
    });
    const res = fakeRes();

    await routeSessionApi(req, res, { accessKey: MASTER_KEY });

    assert.strictEqual(res.statusCode, 401);
    assert.deepStrictEqual(JSON.parse(res._body), { error: "Unauthorized" });
  });
});

/* ================================================================== */
/*  테스트: GET /sessions/:id — 세션 상세                               */
/* ================================================================== */

describe("GET /sessions/:id — session detail", () => {
  const MASTER_KEY = "test-key";
  const now        = Date.now();

  it("streamable 세션 상세 + activity + searchEvents + toolFeedback 반환", async () => {
    const streamable = new Map();
    streamable.set(TEST_SESSION_ID, {
      authenticated:  true,
      keyId:          null,
      createdAt:      now,
      expiresAt:      now + 3600000,
      lastAccessedAt: now
    });

    const mockPool = {
      query: async (sql) => {
        if (sql.includes("search_events")) {
          return { rows: [{ id: "se1", query_type: "keyword", result_count: 5, latency_ms: 12, created_at: "2026-03-26" }] };
        }
        if (sql.includes("tool_feedback")) {
          return { rows: [{ tool_name: "remember", relevant: true, sufficient: true, suggestion: null, created_at: "2026-03-26" }] };
        }
        return { rows: [] };
      }
    };

    const req = fakeReq({
      method:   "GET",
      pathname: `${SESSION_PREFIX}/${TEST_SESSION_ID}`,
      headers:  { authorization: `Bearer ${MASTER_KEY}` }
    });
    const res = fakeRes();

    await routeSessionApi(req, res, {
      accessKey:          MASTER_KEY,
      streamableSessions: streamable,
      pool:               mockPool,
      getActivityFn:      async () => ({ toolCalls: { recall: 2 }, reflected: false })
    });

    assert.strictEqual(res.statusCode, 200);
    const body = JSON.parse(res._body);

    assert.strictEqual(body.sessionId, TEST_SESSION_ID);
    assert.strictEqual(body.type, "streamable");
    assert.strictEqual(body.authenticated, true);
    assert.ok(body.activity !== null);
    assert.strictEqual(body.searchEvents.length, 1);
    assert.strictEqual(body.searchEvents[0].id, "se1");
    assert.strictEqual(body.toolFeedback.length, 1);
    assert.strictEqual(body.toolFeedback[0].tool_name, "remember");
  });

  it("legacy 세션도 조회 가능", async () => {
    const legacy = new Map();
    legacy.set(TEST_SESSION_ID, {
      authenticated:  false,
      createdAt:      now,
      expiresAt:      now + 3600000,
      lastAccessedAt: now
    });

    const req = fakeReq({
      method:   "GET",
      pathname: `${SESSION_PREFIX}/${TEST_SESSION_ID}`,
      headers:  { authorization: `Bearer ${MASTER_KEY}` }
    });
    const res = fakeRes();

    await routeSessionApi(req, res, {
      accessKey:         MASTER_KEY,
      legacySseSessions: legacy
    });

    assert.strictEqual(res.statusCode, 200);
    const body = JSON.parse(res._body);
    assert.strictEqual(body.type, "legacy");
  });

  it("존재하지 않는 세션 ID 시 404 반환", async () => {
    const req = fakeReq({
      method:   "GET",
      pathname: `${SESSION_PREFIX}/${TEST_SESSION_ID}`,
      headers:  { authorization: `Bearer ${MASTER_KEY}` }
    });
    const res = fakeRes();

    await routeSessionApi(req, res, { accessKey: MASTER_KEY });

    assert.strictEqual(res.statusCode, 404);
    assert.deepStrictEqual(JSON.parse(res._body), { error: "Session not found" });
  });

  it("인증 실패 시 401 반환", async () => {
    const req = fakeReq({
      method:   "GET",
      pathname: `${SESSION_PREFIX}/${TEST_SESSION_ID}`,
      headers:  {}
    });
    const res = fakeRes();

    await routeSessionApi(req, res, { accessKey: MASTER_KEY });

    assert.strictEqual(res.statusCode, 401);
  });
});

/* ================================================================== */
/*  테스트: POST /sessions/:id/reflect — 세션 reflect                   */
/* ================================================================== */

describe("POST /sessions/:id/reflect — trigger reflect", () => {
  const MASTER_KEY = "test-key";

  it("autoReflect + markReflected 호출 후 { ok: true } 반환", async () => {
    let reflectedId = null;
    let markedId    = null;

    const req = fakeReq({
      method:   "POST",
      pathname: `${SESSION_PREFIX}/${TEST_SESSION_ID}/reflect`,
      headers:  { authorization: `Bearer ${MASTER_KEY}` }
    });
    const res = fakeRes();

    await routeSessionApi(req, res, {
      accessKey:       MASTER_KEY,
      autoReflectFn:   async (id) => { reflectedId = id; },
      markReflectedFn: async (id) => { markedId = id; }
    });

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(JSON.parse(res._body), { ok: true });
    assert.strictEqual(reflectedId, TEST_SESSION_ID);
    assert.strictEqual(markedId, TEST_SESSION_ID);
  });

  it("인증 실패 시 401 반환", async () => {
    const req = fakeReq({
      method:   "POST",
      pathname: `${SESSION_PREFIX}/${TEST_SESSION_ID}/reflect`,
      headers:  {}
    });
    const res = fakeRes();

    await routeSessionApi(req, res, { accessKey: MASTER_KEY });

    assert.strictEqual(res.statusCode, 401);
  });
});

/* ================================================================== */
/*  테스트: DELETE /sessions/:id — 세션 종료                             */
/* ================================================================== */

describe("DELETE /sessions/:id — terminate session", () => {
  const MASTER_KEY = "test-key";

  it("streamable 세션 종료 시 closeStreamableSession + deleteActivity 호출", async () => {
    let closedId  = null;
    let deletedId = null;

    const streamable = new Map();
    streamable.set(TEST_SESSION_ID, { authenticated: true });

    const req = fakeReq({
      method:   "DELETE",
      pathname: `${SESSION_PREFIX}/${TEST_SESSION_ID}`,
      headers:  { authorization: `Bearer ${MASTER_KEY}` }
    });
    const res = fakeRes();

    await routeSessionApi(req, res, {
      accessKey:                 MASTER_KEY,
      streamableSessions:        streamable,
      closeStreamableSessionFn:  async (id) => { closedId = id; },
      deleteActivityFn:          async (id) => { deletedId = id; }
    });

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(JSON.parse(res._body), { ok: true });
    assert.strictEqual(closedId, TEST_SESSION_ID);
    assert.strictEqual(deletedId, TEST_SESSION_ID);
  });

  it("legacy 세션 종료 시 closeLegacySseSession 호출", async () => {
    let closedId = null;

    const legacy = new Map();
    legacy.set(TEST_SESSION_ID, { authenticated: false });

    const req = fakeReq({
      method:   "DELETE",
      pathname: `${SESSION_PREFIX}/${TEST_SESSION_ID}`,
      headers:  { authorization: `Bearer ${MASTER_KEY}` }
    });
    const res = fakeRes();

    await routeSessionApi(req, res, {
      accessKey:               MASTER_KEY,
      legacySseSessions:       legacy,
      closeLegacySseSessionFn: async (id) => { closedId = id; },
      deleteActivityFn:        async () => {}
    });

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(JSON.parse(res._body), { ok: true });
    assert.strictEqual(closedId, TEST_SESSION_ID);
  });

  it("존재하지 않는 세션도 ok 반환 (멱등성)", async () => {
    const req = fakeReq({
      method:   "DELETE",
      pathname: `${SESSION_PREFIX}/${TEST_SESSION_ID}`,
      headers:  { authorization: `Bearer ${MASTER_KEY}` }
    });
    const res = fakeRes();

    await routeSessionApi(req, res, { accessKey: MASTER_KEY });

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(JSON.parse(res._body), { ok: true });
  });

  it("인증 실패 시 401 반환", async () => {
    const req = fakeReq({
      method:   "DELETE",
      pathname: `${SESSION_PREFIX}/${TEST_SESSION_ID}`,
      headers:  {}
    });
    const res = fakeRes();

    await routeSessionApi(req, res, { accessKey: MASTER_KEY });

    assert.strictEqual(res.statusCode, 401);
  });
});

/* ================================================================== */
/*  테스트: POST /sessions/cleanup — 만료 세션 정리                      */
/* ================================================================== */

describe("POST /sessions/cleanup — cleanup expired sessions", () => {
  const MASTER_KEY = "test-key";

  it("cleanupExpiredSessions 호출 후 { ok: true, message } 반환", async () => {
    let called = false;

    const req = fakeReq({
      method:   "POST",
      pathname: `${SESSION_PREFIX}/cleanup`,
      headers:  { authorization: `Bearer ${MASTER_KEY}` }
    });
    const res = fakeRes();

    await routeSessionApi(req, res, {
      accessKey:                 MASTER_KEY,
      cleanupExpiredSessionsFn:  async () => { called = true; }
    });

    assert.strictEqual(res.statusCode, 200);
    const body = JSON.parse(res._body);
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.message, "Cleanup completed");
    assert.strictEqual(called, true);
  });

  it("인증 실패 시 401 반환", async () => {
    const req = fakeReq({
      method:   "POST",
      pathname: `${SESSION_PREFIX}/cleanup`,
      headers:  {}
    });
    const res = fakeRes();

    await routeSessionApi(req, res, { accessKey: MASTER_KEY });

    assert.strictEqual(res.statusCode, 401);
  });

  it("cleanup 실패 시 500 반환", async () => {
    const req = fakeReq({
      method:   "POST",
      pathname: `${SESSION_PREFIX}/cleanup`,
      headers:  { authorization: `Bearer ${MASTER_KEY}` }
    });
    const res = fakeRes();

    await routeSessionApi(req, res, {
      accessKey:                MASTER_KEY,
      cleanupExpiredSessionsFn: async () => { throw new Error("Redis down"); }
    });

    assert.strictEqual(res.statusCode, 500);
  });
});
