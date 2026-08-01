/**
 * lib/storage — 스토리지 어댑터 진입점
 *
 * 작성자: 최진호
 * 작성일: 2026-05-13
 *
 * MEMENTO_STORAGE 환경변수로 어댑터를 선택한다.
 *   pgvector  (기본) → PgVectorStore
 *   sqlite-vec        → SqliteVecStore (v4.1 구현 예정, 현재 stub)
 */

import { PgVectorStore  } from "./PgVectorStore.js";
import { SqliteVecStore } from "./SqliteVecStore.js";

/**
 * @typedef {object} StorageAdapter
 *
 * 모든 스토리지 어댑터가 구현해야 하는 공통 인터페이스.
 * TypeScript를 사용하지 않는 프로젝트이므로 JSDoc @typedef로 명세한다.
 *
 * @property {function(string, Array=): Promise<{rows: Array, rowCount: number}>} query
 *   단순 SQL 쿼리 실행. Primary 풀에서 클라이언트를 획득하여 결과를 반환한다.
 *
 * @property {function(string, string, Array=): Promise<{rows: Array, rowCount: number}>} queryAsAgent
 *   에이전트 컨텍스트(SET LOCAL app.current_agent_id)와 벡터 타입 지원이
 *   활성화된 상태로 SQL을 실행한다. agentId가 첫 번째 인자.
 *
 * @property {function(function): Promise<any>} transaction
 *   fn(client) 형태의 콜백을 트랜잭션 안에서 실행한다. BEGIN/COMMIT/ROLLBACK을
 *   어댑터가 관리하며 fn의 반환값을 그대로 반환한다.
 *
 * @property {function(string, object): Promise<number>} migrate
 *   filePath의 SQL 파일을 읽어 opsClass.apply(sql)에 위임한다.
 *   반환값은 적용된 SQL 구문 수.
 *
 * @property {function(): Promise<void>} close
 *   연결 풀 또는 파일 핸들을 닫는다.
 *
 * @property {'pgvector' | 'sqlite-vec'} engine
 *   어댑터가 사용하는 스토리지 엔진 식별자. 읽기 전용.
 *
 * @property {'native' | 'extension' | 'none'} vectorSupport
 *   벡터 연산 지원 수준.
 *   - native    : 엔진 네이티브 벡터 타입 및 인덱스 지원 (pgvector).
 *   - extension : 외부 확장으로 벡터 연산 지원 (sqlite-vec).
 *   - none      : 벡터 연산 미지원.
 */

/** @type {StorageAdapter | null} */
let _instance = null;

/**
 * 환경변수 MEMENTO_STORAGE에 따라 스토리지 어댑터 싱글톤을 반환한다.
 *
 * 지원 값:
 *   pgvector   (기본) — PostgreSQL + pgvector 어댑터
 *   sqlite-vec         — SQLite + sqlite-vec 어댑터 (v4.1 stub)
 *
 * 알 수 없는 값은 경고 없이 pgvector로 폴백한다.
 *
 * @returns {StorageAdapter}
 */
export function getStorage() {
  if (_instance) return _instance;

  const backend = (process.env.MEMENTO_STORAGE || "pgvector").toLowerCase().trim();

  if (backend === "sqlite-vec") {
    _instance = new SqliteVecStore();
  } else {
    _instance = new PgVectorStore();
  }

  return _instance;
}

/**
 * 테스트 전용: 싱글톤 인스턴스를 초기화한다.
 * 프로덕션 코드에서 호출 금지.
 *
 * @returns {void}
 */
export function _resetStorageForTest() {
  _instance = null;
}

export { PgVectorStore, SqliteVecStore };
