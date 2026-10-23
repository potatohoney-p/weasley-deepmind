import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

/** Synthetic fixture; caller owns an isolated rollback-only transaction. */
export async function checkHistoryActiveLinks(client, reconstructor) {
  const prefix = `history-links-${randomUUID()}`;
  const incident = `${prefix}-incident`;
  const resolution = `${prefix}-resolution`;
  const outside = `${prefix}-outside`;
  for (const [id, status, caseId] of [
    [incident, "open", prefix], [resolution, "resolved", prefix], [outside, "open", `${prefix}-other`]
  ]) {
    await client.query(`INSERT INTO agent_memory.fragments
      (id, content, content_hash, topic, type, case_id, resolution_status)
      VALUES ($1, $1, $1, $2, 'fact', $2, $3)`, [id, caseId, status]);
  }
  await client.query(`INSERT INTO agent_memory.fragment_links
    (from_id, to_id, relation_type, weight) VALUES ($1, $2, 'resolved_by', 1)`, [incident, resolution]);
  const live = await reconstructor.reconstruct({ caseId: prefix });
  assert.equal(live.causal_chains.length, 1, "active causal edge is preserved");
  assert.equal(live.causal_chains[0].is_resolved, true);
  assert.equal(live.unresolved_branches.length, 0);

  await client.query(`UPDATE agent_memory.fragment_links SET deleted_at = NOW()
    WHERE from_id = $1 AND to_id = $2`, [incident, resolution]);
  const deleted = await reconstructor.reconstruct({ caseId: prefix });
  assert.equal(deleted.causal_chains.length, 0, "deleted resolution must not resolve the incident");
  assert.deepEqual(deleted.unresolved_branches.map(f => f.id), [incident]);
  assert.equal(deleted.supporting_fragments.length, 2);
  assert.match(deleted.summary, /미해결 브랜치: 1개/);

  // A predicate applied to only one side of the OR leaks one of these rows.
  await client.query(`INSERT INTO agent_memory.fragment_links
    (from_id, to_id, relation_type, weight, deleted_at)
    VALUES ($1, $2, 'caused_by', 1, NOW()), ($2, $1, 'caused_by', 1, NOW())`, [incident, outside]);
  assert.deepEqual(await reconstructor._fetchLinks([incident]), [], "deleted incoming and outgoing edges are excluded");

  await client.query(`UPDATE agent_memory.fragment_links SET deleted_at = NULL
    WHERE from_id = $1 AND to_id = $2`, [incident, outside]);
  const outgoing = await reconstructor._fetchLinks([incident]);
  assert.equal(outgoing.length, 1);
  assert.equal(outgoing[0].to_id, outside, "active outgoing traversal is unchanged");
  const incoming = await reconstructor._fetchLinks([outside]);
  assert.equal(incoming.length, 1);
  assert.equal(incoming[0].from_id, incident, "active incoming traversal is unchanged");
  assert.deepEqual(await reconstructor._fetchLinks([`${prefix}-missing`]), []);
  assert.deepEqual(await reconstructor._fetchLinks([]), []);
}
