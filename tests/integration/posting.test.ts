import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { migrate } from '../../scripts/db-migrate.mjs';
import type { Identity } from '../../src/server/auth/access';

const state = vi.hoisted(() => ({ pool: undefined as pg.Pool | undefined }));
vi.mock('../../src/server/db/pool', () => ({ getPool: () => state.pool }));
import { withTenant } from '../../src/server/db/tenant';
import { createDocument, updateDocument, type DocumentInput } from '../../src/server/documents';
import { postInbound } from '../../src/server/posting';
import { listStock, listLedger, reconcileStock } from '../../src/server/stock';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl || !decodeURIComponent(new URL(databaseUrl).pathname).endsWith('_test')) {
  throw new Error('A dedicated TEST_DATABASE_URL ending in _test is required.');
}
const schema = `posting_${randomUUID().replaceAll('-', '')}`;
const role = `app_${randomUUID().replaceAll('-', '')}`;
const password = randomBytes(32).toString('hex');
const owner = new pg.Pool({ connectionString: databaseUrl });
const appUrl = new URL(databaseUrl);
appUrl.username = role;
appUrl.password = password;
let roleCreated = false;
const tenant = randomUUID();
const foreignTenant = randomUUID();
const actor = randomUUID();
const warehouse = randomUUID();
const location = randomUUID();
const identity: Identity = { user: { id: actor, name: 'Poster', email: `${actor}@example.test` }, tenant: { id: tenant, name: 'A' }, role: 'worker' };
const foreignIdentity: Identity = { ...identity, tenant: { id: foreignTenant, name: 'B' } };
const effectTables = ['inventory_documents', 'stock_balances', 'stock_ledger', 'audit_logs', 'idempotency_requests'];

beforeAll(async () => {
  await owner.query(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD ${pg.escapeLiteral(password)}`);
  roleCreated = true;
  await migrate(databaseUrl, { schema, migrationsSchema: schema, createSchema: true, createMigrationsSchema: true, log: () => {} });
  await owner.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${role}"`);
  await owner.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${schema}" TO "${role}"`);
  await owner.query(`INSERT INTO "${schema}".tenants (id,name) VALUES ($1,'A'),($2,'B')`, [tenant, foreignTenant]);
  await owner.query(`INSERT INTO "${schema}"."user" (id,name,email) VALUES ($1,'Poster',$2)`, [actor, identity.user.email]);
  state.pool = new pg.Pool({ connectionString: appUrl.toString(), max: 6, application_name: schema, options: `-c search_path=${schema}` });
  await withTenant(tenant, async client => {
    await client.query("INSERT INTO warehouses (id,tenant_id,code,name) VALUES ($1,$2,'MAIN','Main')", [warehouse, tenant]);
    await client.query("INSERT INTO locations (id,tenant_id,warehouse_id,code,name) VALUES ($1,$2,$3,'MAIN','Main')", [location, tenant, warehouse]);
  });
}, 30_000);

afterAll(async () => {
  await state.pool?.end();
  try { await owner.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
  finally {
    try { if (roleCreated) await owner.query(`DROP ROLE "${role}"`); }
    finally { await owner.end(); }
  }
});

async function draft(quantity = 100, existingItem?: string) {
  const item = existingItem ?? randomUUID();
  if (!existingItem) await withTenant(tenant, client => client.query('INSERT INTO items (id,tenant_id,code,name) VALUES ($1::uuid,$2,$1::text,\'Item\')', [item, tenant]));
  const input: DocumentInput = { kind: 'INBOUND', warehouse_id: warehouse, source_location_id: null, destination_location_id: location, note: '', lines: [{ item_id: item, quantity }] };
  const document = await createDocument(tenant, input);
  return { id: document.id as string, item, input };
}
async function snapshot() {
  return withTenant(tenant, async client => {
    const result: Record<string, unknown[]> = {};
    for (const table of effectTables) result[table] = (await client.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;
    return result;
  });
}
async function effects(id: string, item: string) {
  return withTenant(tenant, async client => ({
    document: (await client.query('SELECT status,version,posted_at FROM inventory_documents WHERE id=$1', [id])).rows[0],
    balances: (await client.query('SELECT quantity FROM stock_balances WHERE item_id=$1', [item])).rows,
    ledger: (await client.query('SELECT quantity_delta FROM stock_ledger WHERE document_id=$1', [id])).rows,
    audit: (await client.query('SELECT actor_id,action FROM audit_logs WHERE document_id=$1', [id])).rows,
  }));
}
// A real row lock holds both independent application transactions at a known barrier.
async function raced(id: string | string[], operations: (() => Promise<unknown>)[]) {
  const blocker = await owner.connect();
  const pending: Promise<unknown>[] = [];
  try {
    await blocker.query('BEGIN');
    await blocker.query(`SELECT id FROM "${schema}".inventory_documents WHERE id=ANY($1::uuid[]) FOR UPDATE`, [Array.isArray(id) ? id : [id]]);
    pending.push(...operations.map(operation => operation()));
    // Attach rejection handlers immediately, while keeping outcomes for later assertions.
    const outcomes = Promise.allSettled(pending);
    const deadline = Date.now() + 8000;
    let waiting = 0;
    while (Date.now() < deadline) {
      const result = await owner.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE usename=$1 AND datname=current_database() AND wait_event_type='Lock'", [role]);
      waiting = result.rows[0].count;
      if (waiting >= operations.length) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    expect(waiting, 'both requests must reach database locks before release').toBeGreaterThanOrEqual(operations.length);
    await blocker.query('COMMIT');
    return await outcomes;
  } finally {
    await blocker.query('ROLLBACK');
    blocker.release();
    await Promise.allSettled(pending);
  }
}

describe('P3 inbound posting against real PostgreSQL with a restricted application role', () => {
  it('posts 100 exactly once and replays persisted JSON after a lost response', async () => {
    const d = await draft();
    const key = randomUUID();
    await postInbound(identity, d.id, 1, key); // The caller loses this committed response.
    const persisted = await withTenant(tenant, async client => (await client.query('SELECT response FROM idempotency_requests WHERE key=$1', [key])).rows[0].response);
    expect(JSON.parse(JSON.stringify(await postInbound(identity, d.id, 1, key)))).toEqual(persisted);
    const result = await effects(d.id, d.item);
    expect(result.document).toMatchObject({ status: 'POSTED', version: 2 });
    expect(result.document.posted_at).toBeInstanceOf(Date);
    expect(result.balances).toEqual([{ quantity: '100' }]);
    expect(result.ledger).toEqual([{ quantity_delta: '100' }]);
    expect(result.audit).toHaveLength(1);
    expect(result.audit[0]).toEqual({ actor_id: actor, action: 'POST_INBOUND' });
    const before = await snapshot();
    await expect(postInbound(identity, d.id, 2, key)).rejects.toMatchObject({ status: 409 });
    await expect(postInbound(identity, (await draft()).id, 1, key)).rejects.toMatchObject({ status: 409 });
    // Compare after creating the second draft, so only rejected posting effects are measured.
    const afterDraft = await snapshot();
    await expect(postInbound(identity, d.id, 1, randomUUID())).rejects.toMatchObject({ status: 409 });
    expect(await snapshot()).toEqual(afterDraft);
    expect(before.stock_balances).toEqual(afterDraft.stock_balances);
    expect(before.stock_ledger).toEqual(afterDraft.stock_ledger);
    expect(before.audit_logs).toEqual(afterDraft.audit_logs);
    expect(before.idempotency_requests).toEqual(afterDraft.idempotency_requests);
  });

  it('serializes simultaneous requests with the same idempotency key', async () => {
    const d = await draft();
    const key = randomUUID();
    const results = await raced(d.id, [() => postInbound(identity, d.id, 1, key), () => postInbound(identity, d.id, 1, key)]);
    expect(results.every(result => result.status === 'fulfilled')).toBe(true);
    expect(results[0]).toEqual(results[1]);
    expect(await effects(d.id, d.item)).toMatchObject({ balances: [{ quantity: '100' }], ledger: [{ quantity_delta: '100' }], audit: [{ actor_id: actor }] });
    expect(await withTenant(tenant, async client => (await client.query('SELECT key FROM idempotency_requests WHERE key=$1', [key])).rowCount)).toBe(1);
  });

  it('adds concurrent different documents into a previously absent stock row', async () => {
    const first = await draft(30);
    const second = await draft(70, first.item);
    const results = await raced([first.id, second.id], [() => postInbound(identity, first.id, 1, randomUUID()), () => postInbound(identity, second.id, 1, randomUUID())]);
    expect(results.every(result => result.status === 'fulfilled')).toBe(true);
    expect((await effects(first.id, first.item)).balances).toEqual([{ quantity: '100' }]);
    expect((await effects(first.id, first.item)).ledger).toEqual([{ quantity_delta: '30' }]);
    expect((await effects(second.id, first.item)).ledger).toEqual([{ quantity_delta: '70' }]);
  });

  it('allows exactly one winner when editing and posting the same version race', async () => {
    const d = await draft();
    const results = await raced(d.id, [() => updateDocument(tenant, d.id, 1, { ...d.input, note: 'Edited', lines: [{ item_id: d.item, quantity: 250 }] }), () => postInbound(identity, d.id, 1, randomUUID())]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { status: 409 } });
    const result = await effects(d.id, d.item);
    expect(result.document.version).toBe(2);
    if (result.document.status === 'POSTED') {
      expect(result.balances).toEqual([{ quantity: '100' }]);
      expect(result.ledger).toEqual([{ quantity_delta: '100' }]);
      expect(result.audit).toHaveLength(1);
    } else {
      expect(result.document.status).toBe('DRAFT');
      expect(result.balances).toEqual([]);
      expect(result.ledger).toEqual([]);
      expect(result.audit).toEqual([]);
    }
  });

  for (const table of ['audit_logs', 'idempotency_requests']) {
    it(`rolls back all effects on a database error inserting ${table}, then retries the same key`, async () => {
      const d = await draft();
      const key = randomUUID();
      const before = await snapshot();
      await owner.query(`CREATE FUNCTION "${schema}".fail_posting() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM "${schema}".stock_ledger WHERE document_id='${d.id}'::uuid)
             OR NOT EXISTS (SELECT 1 FROM "${schema}".inventory_documents WHERE id='${d.id}'::uuid AND status='POSTED') THEN
            RAISE EXCEPTION 'fault did not occur after ledger and document update' USING ERRCODE = 'P0002';
          END IF;
          RAISE EXCEPTION 'injected posting failure' USING ERRCODE = 'P0001';
        END $$`);
      await owner.query(`CREATE TRIGGER fail_posting BEFORE INSERT ON "${schema}".${table} FOR EACH ROW EXECUTE FUNCTION "${schema}".fail_posting()`);
      try {
        await expect(postInbound(identity, d.id, 1, key)).rejects.toMatchObject({ code: 'P0001' });
        expect(await snapshot()).toEqual(before);
      } finally {
        await owner.query(`DROP TRIGGER fail_posting ON "${schema}".${table}`);
        await owner.query(`DROP FUNCTION "${schema}".fail_posting()`);
      }
      await postInbound(identity, d.id, 1, key);
      expect((await effects(d.id, d.item)).balances).toEqual([{ quantity: '100' }]);
    });
  }

  it('reconciles posted stock against ledger sums and reports precise corruption', async () => {
    const d = await draft();
    await postInbound(identity, d.id, 1, randomUUID());
    expect(await reconcileStock(tenant)).toEqual({ consistent: true, mismatches: [] });
    expect((await listStock(tenant)).find(row => row.item_id === d.item)).toMatchObject({ quantity: '100', location_id: location });
    expect((await listLedger(tenant)).filter(row => row.document_id === d.id)).toMatchObject([{ quantity_delta: '100' }]);
    await owner.query(`UPDATE "${schema}".stock_balances SET quantity=123 WHERE tenant_id=$1 AND item_id=$2`, [tenant, d.item]);
    try {
      expect(await reconcileStock(tenant)).toEqual({ consistent: false, mismatches: [{ location_id: location, item_id: d.item, balance_quantity: '123', ledger_quantity: '100' }] });
      expect(await reconcileStock(foreignTenant)).toEqual({ consistent: true, mismatches: [] });
    } finally {
      await owner.query(`UPDATE "${schema}".stock_balances SET quantity=100 WHERE tenant_id=$1 AND item_id=$2`, [tenant, d.item]);
    }
    expect(await reconcileStock(tenant)).toEqual({ consistent: true, mismatches: [] });
  });

  it('prevents another tenant from posting a document or replaying its response', async () => {
    const d = await draft();
    const key = randomUUID();
    await expect(postInbound(foreignIdentity, d.id, 1, key)).rejects.toMatchObject({ status: 404 });
    await postInbound(identity, d.id, 1, key);
    const before = await snapshot();
    await expect(postInbound(foreignIdentity, d.id, 1, key)).rejects.toMatchObject({ status: 404 });
    expect(await snapshot()).toEqual(before);
    expect(await withTenant(foreignTenant, async client => (await client.query('SELECT * FROM idempotency_requests WHERE key=$1', [key])).rows)).toEqual([]);
  });
});
