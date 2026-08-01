/**
 * 스토리지 어댑터 계층 회귀 가드
 *
 * 작성자: 최진호
 * 작성일: 2026-05-13
 *
 * 검증 항목:
 * 1. getStorage() 기본 반환값이 PgVectorStore 인스턴스인지
 * 2. MEMENTO_STORAGE=sqlite-vec 설정 시 SqliteVecStore 인스턴스 반환
 * 3. SqliteVecStore 메서드 호출이 'not implemented' 에러를 던지는지
 * 4. 두 어댑터 모두 필수 인터페이스 메서드/프로퍼티를 보유하는지
 */

import { describe, it, beforeEach, after } from "node:test";
import assert                               from "node:assert/strict";

import {
  getStorage,
  _resetStorageForTest,
  PgVectorStore,
  SqliteVecStore
} from "../../lib/storage/index.js";

/** 각 테스트 전 싱글톤 초기화 및 환경변수 정리 */
beforeEach(() => {
  _resetStorageForTest();
  delete process.env.MEMENTO_STORAGE;
});

after(() => {
  _resetStorageForTest();
  delete process.env.MEMENTO_STORAGE;
});

/** 필수 인터페이스 메서드/프로퍼티 목록 */
const REQUIRED_METHODS    = ["query", "queryAsAgent", "transaction", "migrate", "close"];
const REQUIRED_PROPERTIES = ["engine", "vectorSupport"];

describe("getStorage() — 어댑터 선택", () => {

  it("MEMENTO_STORAGE 미설정 시 PgVectorStore 반환", () => {
    const store = getStorage();
    assert.ok(
      store instanceof PgVectorStore,
      `PgVectorStore 인스턴스를 기대했으나 ${store.constructor.name} 반환`
    );
  });

  it("MEMENTO_STORAGE=pgvector 명시 시 PgVectorStore 반환", () => {
    process.env.MEMENTO_STORAGE = "pgvector";
    const store = getStorage();
    assert.ok(store instanceof PgVectorStore);
  });

  it("MEMENTO_STORAGE=sqlite-vec 시 SqliteVecStore 반환", () => {
    process.env.MEMENTO_STORAGE = "sqlite-vec";
    const store = getStorage();
    assert.ok(
      store instanceof SqliteVecStore,
      `SqliteVecStore 인스턴스를 기대했으나 ${store.constructor.name} 반환`
    );
  });

  it("MEMENTO_STORAGE 알 수 없는 값 시 pgvector 폴백", () => {
    process.env.MEMENTO_STORAGE = "unknown-backend";
    const store = getStorage();
    assert.ok(store instanceof PgVectorStore, "알 수 없는 값은 pgvector로 폴백해야 한다");
  });

  it("싱글톤 보장 — 동일 인스턴스 반환", () => {
    const a = getStorage();
    const b = getStorage();
    assert.strictEqual(a, b, "getStorage()는 동일 인스턴스를 반환해야 한다");
  });

  it("_resetStorageForTest 후 새 인스턴스 생성", () => {
    const a = getStorage();
    _resetStorageForTest();
    const b = getStorage();
    assert.notStrictEqual(a, b, "_reset 후 새 인스턴스가 생성되어야 한다");
  });

});

describe("PgVectorStore — 인터페이스 준수", () => {
  let store;

  beforeEach(() => {
    _resetStorageForTest();
    delete process.env.MEMENTO_STORAGE;
    store = getStorage();
  });

  it("engine 프로퍼티가 'pgvector'", () => {
    assert.strictEqual(store.engine, "pgvector");
  });

  it("vectorSupport 프로퍼티가 'native'", () => {
    assert.strictEqual(store.vectorSupport, "native");
  });

  for (const method of REQUIRED_METHODS) {
    it(`필수 메서드 ${method} 존재`, () => {
      assert.strictEqual(
        typeof store[method],
        "function",
        `PgVectorStore.${method}는 function이어야 한다`
      );
    });
  }

  for (const prop of REQUIRED_PROPERTIES) {
    it(`필수 프로퍼티 ${prop} 존재`, () => {
      assert.ok(
        prop in store,
        `PgVectorStore에 프로퍼티 '${prop}'이 없다`
      );
    });
  }

});

describe("SqliteVecStore — stub 동작", () => {
  let store;

  beforeEach(() => {
    _resetStorageForTest();
    process.env.MEMENTO_STORAGE = "sqlite-vec";
    store = getStorage();
  });

  it("engine 프로퍼티가 'sqlite-vec'", () => {
    assert.strictEqual(store.engine, "sqlite-vec");
  });

  it("vectorSupport 프로퍼티가 'extension'", () => {
    assert.strictEqual(store.vectorSupport, "extension");
  });

  for (const method of REQUIRED_METHODS) {
    it(`필수 메서드 ${method} 존재`, () => {
      assert.strictEqual(
        typeof store[method],
        "function",
        `SqliteVecStore.${method}는 function이어야 한다`
      );
    });
  }

  for (const prop of REQUIRED_PROPERTIES) {
    it(`필수 프로퍼티 ${prop} 존재`, () => {
      assert.ok(
        prop in store,
        `SqliteVecStore에 프로퍼티 '${prop}'이 없다`
      );
    });
  }

  it("query() 호출 시 'not implemented' 에러 throw", async () => {
    await assert.rejects(
      () => store.query("SELECT 1"),
      (err) => {
        assert.ok(err.message.includes("not implemented"), `에러 메시지: ${err.message}`);
        return true;
      }
    );
  });

  it("queryAsAgent() 호출 시 'not implemented' 에러 throw", async () => {
    await assert.rejects(
      () => store.queryAsAgent("agent-1", "SELECT 1"),
      (err) => {
        assert.ok(err.message.includes("not implemented"), `에러 메시지: ${err.message}`);
        return true;
      }
    );
  });

  it("transaction() 호출 시 'not implemented' 에러 throw", async () => {
    await assert.rejects(
      () => store.transaction(async () => {}),
      (err) => {
        assert.ok(err.message.includes("not implemented"), `에러 메시지: ${err.message}`);
        return true;
      }
    );
  });

  it("migrate() 호출 시 'not implemented' 에러 throw", async () => {
    await assert.rejects(
      () => store.migrate("/tmp/test.sql", {}),
      (err) => {
        assert.ok(err.message.includes("not implemented"), `에러 메시지: ${err.message}`);
        return true;
      }
    );
  });

  it("close() 호출 시 'not implemented' 에러 throw", async () => {
    await assert.rejects(
      () => store.close(),
      (err) => {
        assert.ok(err.message.includes("not implemented"), `에러 메시지: ${err.message}`);
        return true;
      }
    );
  });

});
