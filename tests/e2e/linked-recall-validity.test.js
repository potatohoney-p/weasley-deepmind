/**
 * Execute LinkStore's production SQL against PostgreSQL, without model calls.
 * Every fixture is transaction-local and rolled back. A configured but broken
 * DATABASE_URL fails setup rather than silently reporting a successful test.
 */

import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

describe("linked recall validity (PostgreSQL)", { skip: !process.env.DATABASE_URL }, () => {
  let pool, client, store, lifecycle;
  const prefix = `linked-validity-${randomUUID()}`;
  const agent = `${prefix}-agent`;
  const keyA = `${prefix}-key-a`;
  const keyB = `${prefix}-key-b`;
  const keyOther = `${prefix}-key-other`;
  const seed = `${prefix}-seed`;

  before(async () => {
    const { LinkStore } = await import("../../lib/memory/link/LinkStore.js");
    lifecycle = await import("../_lifecycle.js");
    store = new LinkStore();
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    client = await pool.connect();
  });

  beforeEach(async () => {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.current_agent_id', $1, true)", [agent]);
    for (const key of [keyA, keyB, keyOther]) {
      await client.query(
        `INSERT INTO agent_memory.api_keys (id, name, key_hash, key_prefix)
         VALUES ($1, $1, $1, 'synthetic')`,
        [key]
      );
    }
    await addFragment("seed");
  });

  afterEach(async () => { if (client) await client.query("ROLLBACK"); });
  after(async () => {
    client?.release();
    await pool?.end();
    await lifecycle?.teardownTestResources();
    await lifecycle?.assertCleanShutdown();
  });

  async function addFragment(name, {
    keyId = keyA, agentId = agent, workspace = "workspace-a", expired = false
  } = {}) {
    const id = `${prefix}-${name}`;
    await client.query(
      `INSERT INTO agent_memory.fragments
         (id, content, topic, type, importance, content_hash, agent_id, key_id, workspace, valid_to)
       VALUES ($1, $2, $3, 'fact', 0.7, $1, $4, $5, $6,
               CASE WHEN $7::boolean THEN NOW() ELSE NULL END)`,
      [id, `Synthetic memory ${name}`, prefix, agentId, keyId, workspace, expired]
    );
    return id;
  }

  async function addNeighbor(name, { incoming = false, ...opts } = {}) {
    const id = await addFragment(name, opts);
    await client.query(
      `INSERT INTO agent_memory.fragment_links (from_id, to_id, relation_type)
       VALUES ($1, $2, 'related')`,
      incoming ? [id, seed] : [seed, id]
    );
    return id;
  }

  async function readLinked(options = {}) {
    const { sql, params } = store._buildLinkedFragmentsSql({
      fromIds: [seed],
      safeRelationType: null,
      keyId: [keyA, keyB],
      agentId: agent,
      workspace: "workspace-a",
      ...options
    });
    return (await client.query(sql, params)).rows;
  }

  it("removes expired outgoing and incoming neighbors while retaining explicit history", async () => {
    const current = await addNeighbor("current");
    const outgoing = await addNeighbor("old-outgoing");
    const incoming = await addNeighbor("old-incoming", { incoming: true });
    const allIds = [current, outgoing, incoming].sort();
    assert.deepEqual((await readLinked()).map(row => row.id).sort(), allIds);

    await client.query(
      "UPDATE agent_memory.fragments SET valid_to = NOW() WHERE id = ANY($1::text[])",
      [[outgoing, incoming]]
    );
    assert.deepEqual((await readLinked()).map(row => row.id), [current]);
    const history = await readLinked({ includeSuperseded: true });
    assert.deepEqual(history.map(row => row.id).sort(), allIds);
    assert.equal(history.find(row => row.id === current).valid_to, null);
    assert.ok(history.find(row => row.id === outgoing).valid_to instanceof Date);
    assert.ok(history.find(row => row.id === incoming).valid_to instanceof Date);
  });

  it("history and peer options retain key and workspace boundaries", async () => {
    const own = await addNeighbor("own-old", { expired: true });
    const group = await addNeighbor("group-old", { keyId: keyB, expired: true, incoming: true });
    const peer = await addNeighbor("peer-old", { agentId: "default", expired: true });
    await addNeighbor("foreign-key-old", { keyId: keyOther, expired: true });
    await addNeighbor("foreign-workspace-old", { workspace: "workspace-b", expired: true, incoming: true });

    for (const includePeerAgents of [false, true]) {
      const rows = await readLinked({ includeSuperseded: true, includePeerAgents });
      assert.deepEqual(rows.map(row => row.id).sort(), [own, group, peer].sort());
    }
  });

  it("expired neighbors cannot consume the limit ahead of a current neighbor", async () => {
    for (let i = 0; i < 12; i++) {
      await addNeighbor(`a-expired-${i}`, { expired: true, incoming: i % 2 === 0 });
    }
    const current = await addNeighbor("z-current");
    assert.deepEqual((await readLinked()).map(row => row.id), [current]);
  });
});
