/**
 * EvaluationMetrics - tool_feedback 기반 Implicit IR 평가
 *
 * 작성자: Weasley Open Source
 * 작성일: 2026-03-11
 */

import { getPrimaryPool } from "../../tools/db.js";

/**
 * 피드백 배열에서 Precision@k 계산 (순수 함수)
 * @param {{ relevant: boolean }[]} feedbacks
 * @param {number} k
 * @returns {number|null}
 */
export function computePrecisionAt(feedbacks, k) {
  if (!feedbacks || feedbacks.length === 0) return null;
  const top      = feedbacks.slice(0, k);
  const relevant = top.filter(f => f.relevant === true).length;
  return relevant / top.length;
}

/** Production query exported for transaction-isolated SQL acceptance tests. */
export const ROLLING_PRECISION_SQL = `
  WITH ranked_feedback AS (
    SELECT session_id, relevant, sufficient, created_at,
           ROW_NUMBER() OVER (
             PARTITION BY session_id ORDER BY created_at DESC, id DESC
           ) AS feedback_rank
    FROM agent_memory.tool_feedback
    WHERE session_id IS NOT NULL
      AND created_at > NOW() - INTERVAL '30 days'
  ), recent_sessions AS (
    SELECT session_id,
           count(*) FILTER (WHERE feedback_rank <= 5)::int AS top_count,
           count(*) FILTER (WHERE feedback_rank <= 5 AND relevant = true)::int AS rel_count,
           count(*)::int AS total,
           count(*) FILTER (WHERE sufficient = true)::int AS suf_count
    FROM ranked_feedback
    GROUP BY session_id
    ORDER BY MAX(created_at) DESC, session_id ASC
    LIMIT $1
  )
  SELECT COUNT(*)::int AS sample_sessions,
         AVG(rel_count::float / top_count::float) AS avg_precision_at_5,
         AVG(suf_count::float / total::float) AS avg_sufficient_rate
  FROM recent_sessions
`;

/**
 * 최근 N 세션의 rolling Precision@5 계산
 * 세션별 최신 피드백 최대 5건의 관련성 비율을 동일 가중 평균한다.
 * created_at 동률은 id DESC로 정렬한다. sufficient_rate는 세션 전체를 유지한다.
 * @param {number} [windowSessions=100]
 * @returns {Promise<{ precision_at_5: number|null, sample_sessions: number, sufficient_rate: number|null }>}
 */
export async function computeRollingPrecision(windowSessions = 100) {
  const pool = getPrimaryPool();
  if (!pool) return { precision_at_5: null, sample_sessions: 0, sufficient_rate: null };

  try {
    const result = await pool.query(ROLLING_PRECISION_SQL, [windowSessions]);

    const row = result.rows[0];
    return {
      precision_at_5 : row.avg_precision_at_5  !== null ? parseFloat(row.avg_precision_at_5)  : null,
      sufficient_rate: row.avg_sufficient_rate  !== null ? parseFloat(row.avg_sufficient_rate) : null,
      sample_sessions: parseInt(row.sample_sessions) || 0
    };
  } catch {
    return { precision_at_5: null, sample_sessions: 0, sufficient_rate: null };
  }
}

/**
 * task_feedback 기반 downstream task 성공률
 * @param {number} [windowDays=30]
 * @returns {Promise<{ success_rate: number|null, total_sessions: number }>}
 */
export async function computeTaskSuccessRate(windowDays = 30) {
  const pool = getPrimaryPool();
  if (!pool) return { success_rate: null, total_sessions: 0 };

  try {
    const result = await pool.query(
      `SELECT
         count(*)::int                                        AS total_sessions,
         count(*) FILTER (WHERE overall_success = true)::int AS success_count
       FROM agent_memory.task_feedback
       WHERE created_at > NOW() - ($1 || ' days')::INTERVAL`,
      [windowDays]
    );

    const row   = result.rows[0];
    const total = parseInt(row.total_sessions) || 0;
    const succ  = parseInt(row.success_count)  || 0;

    return {
      success_rate  : total > 0 ? succ / total : null,
      total_sessions: total
    };
  } catch {
    return { success_rate: null, total_sessions: 0 };
  }
}
