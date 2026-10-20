// A deliberately small contract, not an SQL parser or PostgreSQL emulator.
// If the production reader changes this SELECT, review the adapter explicitly.
const supportedSelect = `
  SELECT id, content, topic, keywords, type, importance, utility_score,
  source, linked_to, agent_id, key_id, affect, access_count,
  accessed_at, created_at, ttl_tier, verified_at, is_anchor, valid_to,
  context_summary, session_id, workspace,
  case_id, goal, outcome, phase, resolution_status, assertion_status
  FROM agent_memory.fragments
  WHERE id = ANY($1) AND (agent_id = $2 OR agent_id = 'default') AND valid_to IS NULL
  AND (key_id IS NOT DISTINCT FROM $3 OR key_id = ANY($4::text[]))
  ORDER BY importance DESC, accessed_at DESC NULLS LAST
`.replace(/\s+/g, " ").trim();

export function readSyntheticRows(rows, agentId, sql, params) {
  const [ids, agent, key, group] = Array.isArray(params) ? params : [];
  if (!Array.isArray(params) || typeof sql !== "string" || sql.replace(/\s+/g, " ").trim() !== supportedSelect ||
    params.length !== 4 || agentId !== "default" || agent !== "default" ||
    key !== "offline-synthetic" || !Array.isArray(group) || group.length !== 1 || group[0] !== key ||
    !Array.isArray(ids) || ids.length > 25 || ids.some(id => typeof id !== "string") ||
    new Set(ids).size !== ids.length) {
    throw new Error("Unsupported synthetic reader query or parameters");
  }
  return { rows: structuredClone(rows.filter(row => ids.includes(row.id) &&
    row.valid_to === null && row.agent_id === agent && row.key_id === key)
    .sort((a, b) => b.importance - a.importance)) };
}
