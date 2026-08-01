-- rollback-migration-032.sql
-- v2.8.0 Symbolic Memory Phase 0 롤백 스크립트
-- 작성자: 최진호
-- 작성일: 2026-04-15
--
-- 실행 순서: 인덱스 → 컬럼 → 테이블 순 (의존성 역순)
-- 주의사항:
--   1) 파일명이 `rollback-` prefix 인 이유: scripts/migrate.js 는 `migration-*.sql` 만
--      auto-pickup 한다. 롤백 파일이 `migration-` 로 시작하면 자동 실행되어 버린다.
--      수동 실행 전용: `psql $DATABASE_URL -f lib/memory/rollback-migration-032.sql`
--   2) fragment_claims 데이터가 남아있으면 복구 불가. 프로덕션 롤백 전 백업 필수.
--   3) schema_migrations 레코드는 별도로 DELETE 필요:
--      DELETE FROM agent_memory.schema_migrations WHERE filename = 'migration-032-fragment-claims.sql';

BEGIN;

-- 1) fragments.validation_warnings 컬럼 제거 (Phase 3 advisory warning)
ALTER TABLE agent_memory.fragments
    DROP COLUMN IF EXISTS validation_warnings;

-- 2) partial unique 인덱스 제거
DROP INDEX IF EXISTS agent_memory.uq_fragment_claims_tenant;
DROP INDEX IF EXISTS agent_memory.uq_fragment_claims_master;

-- 3) 조회 인덱스 제거
DROP INDEX IF EXISTS agent_memory.idx_fragment_claims_fragment;
DROP INDEX IF EXISTS agent_memory.idx_fragment_claims_key_subject_pred;

-- 4) 테이블 제거 (CASCADE 로 의존 객체 함께 삭제)
DROP TABLE IF EXISTS agent_memory.fragment_claims CASCADE;

COMMIT;
