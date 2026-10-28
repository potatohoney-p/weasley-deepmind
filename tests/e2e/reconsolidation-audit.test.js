import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

// No configured DB is an explicit skip; configured connection/query failures fail.
test("reconsolidation audits the locked pre-update state on migrated PostgreSQL", {
  skip: !process.env.DATABASE_URL,
  timeout: 20_000,
}, async () => {
  const url = new URL(process.env.DATABASE_URL);
  process.env.POSTGRES_HOST = url.hostname;
  process.env.POSTGRES_PORT = url.port || "5432";
  process.env.POSTGRES_DB = url.pathname.slice(1);
  process.env.POSTGRES_USER = decodeURIComponent(url.username);
  process.env.POSTGRES_PASSWORD = decodeURIComponent(url.password);
  const { getPrimaryPool, shutdownPool } = await import("../../lib/tools/db.js");
  const { reconsolidate } = await import("../../lib/memory/link/ReconsolidationEngine.js");
  const pool = getPrimaryPool();
  const prefix = `recon-audit-${randomUUID()}`;
  const ids = [prefix + "-a", prefix + "-b"];
  let locker;
  let pending;
  try {
    for (const id of ids) {
      await pool.query(`INSERT INTO agent_memory.fragments
        (id,content,topic,type,importance,content_hash,agent_id)
        VALUES ($1,$1,'audit-test','fact',0.5,$1,'default')`, [id]);
    }
    const link = (await pool.query(`INSERT INTO agent_memory.fragment_links
      (from_id,to_id,relation_type,weight,confidence) VALUES ($1,$2,'related',1.95,0.98) RETURNING id`, ids)).rows[0].id;
    const read = async () => (await pool.query("SELECT weight,confidence FROM agent_memory.fragment_links WHERE id=$1", [link])).rows[0];
    for (const [action, weight, confidence] of [
      ["reinforce",1.95,0.98], ["reinforce",2,1], ["decay",0.05,0.04],
      ["restore",1.9,0.99], ["soft_delete",1,0.5],
    ]) {
      await pool.query("UPDATE agent_memory.fragment_links SET weight=$2,confidence=$3,deleted_at=NULL WHERE id=$1", [link,weight,confidence]);
      const before = await read();
      const row = await reconsolidate(link, action);
      assert.equal(Number(row.old_weight), Number(before.weight));
      assert.equal(Number(row.old_confidence), Number(before.confidence));
      const audit = (await pool.query("SELECT * FROM agent_memory.link_reconsolidations WHERE link_id=$1 ORDER BY id DESC LIMIT 1", [link])).rows[0];
      assert.equal(Number(audit.old_weight), Number(before.weight));
      assert.equal(Number(audit.old_confidence), Number(before.confidence));
      assert.equal(Number(audit.new_weight), Number(row.new_weight));
      assert.equal(Number(audit.new_confidence), Number(row.new_confidence));
    }
    assert.equal(await reconsolidate(link, "reinforce"), null); // soft deleted
    await pool.query("UPDATE agent_memory.fragment_links SET deleted_at=NULL,weight=1,confidence=0.5 WHERE id=$1", [link]);
    const count = async () => Number((await pool.query("SELECT count(*) FROM agent_memory.link_reconsolidations WHERE link_id=$1", [link])).rows[0].count);
    const beforeCount = await count();
    await assert.rejects(reconsolidate(link, "reinforce", { keyId: prefix + "-missing-key" }), { code: "23503" });
    assert.equal(await count(), beforeCount);
    assert.deepEqual(await read(), { weight: 1, confidence: "0.500" });

    locker = await pool.connect();
    await locker.query("BEGIN");
    await locker.query("SELECT id FROM agent_memory.fragment_links WHERE id=$1 FOR UPDATE", [link]);
    pending = reconsolidate(link, "reinforce");
    // Observe a real blocked backend, not a timing-only assumption.
    let blocked = false;
    for (let i = 0; i < 100 && !blocked; i++) {
      const result = await pool.query("SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))) AS blocked", [locker.processID]);
      blocked = result.rows[0].blocked;
      if (!blocked) await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(blocked, true);
    const current = (await locker.query("UPDATE agent_memory.fragment_links SET weight=1.95,confidence=0.98 WHERE id=$1 RETURNING weight,confidence", [link])).rows[0];
    await locker.query("COMMIT");
    locker.release(); locker = null;
    const concurrent = await pending; pending = null;
    assert.equal(Number(concurrent.old_weight), Number(current.weight));
    assert.equal(Number(concurrent.old_confidence), Number(current.confidence));
    const concurrentAudit = (await pool.query("SELECT * FROM agent_memory.link_reconsolidations WHERE link_id=$1 ORDER BY id DESC LIMIT 1", [link])).rows[0];
    assert.equal(Number(concurrentAudit.old_weight), Number(current.weight));
    assert.equal(Number(concurrentAudit.old_confidence), Number(current.confidence));
    assert.equal(Number(concurrentAudit.new_weight), Number(concurrent.new_weight));
    assert.equal(Number(concurrentAudit.new_confidence), Number(concurrent.new_confidence));

    const beforeDeleteCount = await count();
    locker = await pool.connect();
    await locker.query("BEGIN");
    await locker.query("UPDATE agent_memory.fragment_links SET deleted_at=NOW() WHERE id=$1", [link]);
    pending = reconsolidate(link, "reinforce");
    blocked = false;
    for (let i = 0; i < 100 && !blocked; i++) {
      const result = await pool.query("SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))) AS blocked", [locker.processID]);
      blocked = result.rows[0].blocked;
      if (!blocked) await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(blocked, true);
    await locker.query("COMMIT");
    locker.release(); locker = null;
    assert.equal(await pending, null); pending = null;
    assert.equal(await count(), beforeDeleteCount);
  } finally {
    if (locker) { await locker.query("ROLLBACK"); locker.release(); }
    if (pending) await pending.catch(() => {});
    await pool.query("DELETE FROM agent_memory.fragments WHERE id=ANY($1::text[])", [ids]);
    await shutdownPool();
  }
});
