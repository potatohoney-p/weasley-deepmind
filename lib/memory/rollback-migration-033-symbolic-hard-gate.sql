/*
 * rollback-migration-033-symbolic-hard-gate.sql
 *
 * 작성자: 최진호
 * 작성일: 2026-04-15
 *
 * migration-033 롤백: api_keys.symbolic_hard_gate 컬럼 제거.
 * 컬럼 제거 전에 참조하는 코드가 없어야 한다 (SYMBOLIC_CONFIG.policyRules=false).
 */

ALTER TABLE agent_memory.api_keys
  DROP COLUMN IF EXISTS symbolic_hard_gate;
