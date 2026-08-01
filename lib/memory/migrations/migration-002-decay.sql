-- Migration 002: last_decay_at 컬럼 추가 (멱등성 보장)
-- 작성자: Weasley Open Source / 2026-03-03


ALTER TABLE agent_memory.fragments
    ADD COLUMN IF NOT EXISTS last_decay_at TIMESTAMPTZ;

