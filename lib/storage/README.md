# lib/storage — 스토리지 어댑터 계층

작성자: 최진호
작성일: 2026-05-13

## 목적

데이터 액세스 레이어를 추상화하기 위한 인터페이스 계층이다. 현재는 `lib/tools/db.js`의 `getPrimaryPool()`과 `queryWithAgentVector()`를 직접 호출하는 25개 이상의 호출 사이트가 존재한다. 이 계층은 v4.1에서 진행될 SQLite 마이그레이션과 호출 사이트 전환을 위한 토대를 마련한다.

현재 버전에서는 인터페이스 정의와 PgVectorStore 래퍼만 완성 상태이며, 호출 사이트(`lib/memory/` 등)는 수정하지 않는다.

## 어댑터 인터페이스 (StorageAdapter)

모든 어댑터는 아래 계약을 구현한다.

| 메서드/프로퍼티 | 시그니처 | 설명 |
|-|-|-|
| query | (sql, params?) → {rows, rowCount} | 단순 SQL 실행 |
| queryAsAgent | (agentId, sql, params?) → {rows, rowCount} | 에이전트 컨텍스트 + 벡터 타입 활성화 쿼리 |
| transaction | (fn(client)) → any | BEGIN/COMMIT/ROLLBACK 자동 관리 트랜잭션 |
| migrate | (filePath, opsClass) → number | SQL 파일 읽어 opsClass.apply(sql)에 위임 |
| close | () → void | 연결 풀 또는 파일 핸들 종료 |
| engine | 'pgvector' \| 'sqlite-vec' | 엔진 식별자 (읽기 전용) |
| vectorSupport | 'native' \| 'extension' \| 'none' | 벡터 연산 지원 수준 (읽기 전용) |

## 파일 목록

- `index.js` — `getStorage()` 팩토리 함수 및 StorageAdapter JSDoc typedef 정의
- `PgVectorStore.js` — PostgreSQL + pgvector 어댑터 (완성)
- `SqliteVecStore.js` — SQLite + sqlite-vec 어댑터 stub (v4.1 구현 예정)

## 환경변수 MEMENTO_STORAGE

| 값 | 선택 어댑터 | 상태 |
|-|-|-|
| pgvector (기본) | PgVectorStore | 운영 가능 |
| sqlite-vec | SqliteVecStore | stub, v4.1 예정 |

알 수 없는 값은 pgvector로 폴백한다.

## 사용법

현재 단계에서는 호출 사이트를 마이그레이션하지 않는다. v4.1에서 `lib/memory/` 전반의 `getPrimaryPool()`, `queryWithAgentVector()` 호출을 `getStorage().query()`, `getStorage().queryAsAgent()`로 교체한다.

테스트 코드에서 싱글톤을 초기화해야 하는 경우 `_resetStorageForTest()`를 사용한다.

```js
import { getStorage, _resetStorageForTest } from "../lib/storage/index.js";

// 어댑터 획득
const store = getStorage();
const { rows } = await store.query("SELECT 1");

// 테스트 후 싱글톤 초기화
_resetStorageForTest();
```
