import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { migrate } from '../../scripts/db-migrate.mjs';
import type { Identity } from '../../src/server/auth/access';

const state = vi.hoisted(() => ({ pool: undefined as pg.Pool | undefined }));
vi.mock('../../src/server/db/pool', () => ({ getPool: () => state.pool }));
import { withTenant } from '../../src/server/db/tenant';
import { createDocument, type DocumentInput } from '../../src/server/documents';
import { postDocument, postInbound } from '../../src/server/posting';
import { apiError } from '../../src/server/api';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl || !decodeURIComponent(new URL(databaseUrl).pathname).endsWith('_test')) {
  throw new Error('A dedicated TEST_DATABASE_URL ending in _test is required.');
}
const schema = `outbound_${randomUUID().replaceAll('-', '')}`;
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
async function outbound(lines: { item_id: string; quantity: number }[]) {
  return createDocument(tenant, { kind: 'OUTBOUND', recipient_name: 'Test recipient', delivery_address: 'Test delivery address', warehouse_id: warehouse, source_location_id: location, destination_location_id: null, note: '', lines });
}
async function stocked(quantity = 100) {
  const d = await draft(quantity);
  await postInbound(identity, d.id, 1, randomUUID());
  return d.item;
}
async function balanceBarrier(item: string, operations: (() => Promise<unknown>)[]) {
  const blocker = await owner.connect();
  let outcomes: Promise<PromiseSettledResult<unknown>[]> | undefined;
  try {
    await blocker.query('BEGIN');
    await blocker.query(`SELECT quantity FROM "${schema}".stock_balances WHERE item_id=$1 FOR UPDATE`, [item]);
    const started = Date.now();
    outcomes = Promise.allSettled(operations.map(operation => operation()));
    let waiting = 0;
    while (Date.now() - started < 700) {
      const result = await owner.query("SELECT count(DISTINCT pid)::int AS count FROM pg_stat_activity WHERE application_name=$1 AND state='active' AND wait_event_type='Lock'", [schema]);
      waiting = result.rows[0].count;
      if (waiting >= operations.length) break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    await blocker.query('COMMIT');
    expect(waiting, 'independent transactions must both reach PostgreSQL lock waits').toBe(operations.length);
    expect(Date.now() - started, 'release must precede the 1s lock timeout').toBeLessThan(900);
    return await outcomes;
  } finally {
    await blocker.query('ROLLBACK');
    blocker.release();
    await outcomes;
  }
}

describe('P4 outbound posting against real PostgreSQL with restricted application role', () => {
  it('serializes competing outbound 80 requests from stock 100, with one shortage and stock 20', async () => {
    const item = await stocked();
    const docs = await Promise.all([outbound([{ item_id: item, quantity: 80 }]), outbound([{ item_id: item, quantity: 80 }])]);
    const keys = [randomUUID(), randomUUID()];
    const results = await balanceBarrier(item, docs.map((d, i) => () => postDocument(identity, d.id, 1, keys[i])));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { status: 409, code: 'INSUFFICIENT_STOCK' } });
    const winner = results.findIndex(result => result.status === 'fulfilled');
    const loser = 1 - winner;
    expect(await effects(docs[winner].id, item)).toMatchObject({ document: { status: 'POSTED', version: 2 }, balances: [{ quantity: '20' }], ledger: [{ quantity_delta: '-80' }], audit: [{ action: 'POST_OUTBOUND', actor_id: actor }] });
    expect(await effects(docs[loser].id, item)).toMatchObject({ document: { status: 'DRAFT', version: 1, posted_at: null }, ledger: [], audit: [] });
    await withTenant(tenant, async client => {
      expect((await client.query('SELECT key FROM idempotency_requests WHERE key=ANY($1::text[])', [keys])).rows).toEqual([{ key: keys[winner] }]);
      expect((await client.query('SELECT quantity_delta FROM stock_ledger WHERE document_id=ANY($1::uuid[])', [docs.map(d => d.id)])).rows).toEqual([{ quantity_delta: '-80' }]);
    });
  });

  it('rolls back earlier items when a later ordered item has insufficient stock', async () => {
    const items = [(await draft()).item, (await draft()).item].sort();
    for (const [index, item] of items.entries()) {
      const inbound = await draft(index === 0 ? 100 : 1, item);
      await postInbound(identity, inbound.id, 1, randomUUID());
    }
    const document = await outbound(items.map(item_id => ({ item_id, quantity: 2 })));
    const before = await snapshot();
    await expect(postDocument(identity, document.id, 1, randomUUID())).rejects.toMatchObject({ status: 409, code: 'INSUFFICIENT_STOCK' });
    expect(await snapshot()).toEqual(before);
  });

  it('leaves no stock row or other effects for a missing balance', async () => {
    const inbound = await draft();
    const document = await outbound([{ item_id: inbound.item, quantity: 1 }]);
    const before = await snapshot();
    await expect(postDocument(identity, document.id, 1, randomUUID())).rejects.toMatchObject({ status: 409, code: 'INSUFFICIENT_STOCK' });
    expect(await snapshot()).toEqual(before);
    expect((await effects(document.id, inbound.item)).balances).toEqual([]);
  });

  it('deduplicates concurrent same-key outbound and replays persisted results after a lost return', async () => {
    const item = await stocked();
    const document = await outbound([{ item_id: item, quantity: 80 }]);
    const key = randomUUID();
    const results = await balanceBarrier(item, [() => postDocument(identity, document.id, 1, key), () => postDocument(identity, document.id, 1, key)]);
    expect(results.every(result => result.status === 'fulfilled')).toBe(true);
    expect(results[0]).toEqual(results[1]);
    const saved = await withTenant(tenant, async client => (await client.query('SELECT response FROM idempotency_requests WHERE key=$1', [key])).rows);
    expect(saved).toHaveLength(1);
    expect(await postDocument(identity, document.id, 1, key)).toEqual(saved[0].response);
    const before = await snapshot();
    await expect(postDocument(identity, document.id, 1, randomUUID())).rejects.toMatchObject({ status: 409 });
    expect(await snapshot()).toEqual(before);
    expect(await effects(document.id, item)).toMatchObject({ balances: [{ quantity: '20' }], ledger: [{ quantity_delta: '-80' }], audit: [{ action: 'POST_OUTBOUND' }] });
  });

  it('rolls back a real lock timeout, maps it to retryable 503, and retries the same key', async () => {
    const item = await stocked();
    const document = await outbound([{ item_id: item, quantity: 80 }]);
    const key = randomUUID();
    const before = await snapshot();
    const blocker = await owner.connect();
    let failure: unknown;
    try {
      await blocker.query('BEGIN');
      await blocker.query(`SELECT quantity FROM "${schema}".stock_balances WHERE item_id=$1 FOR UPDATE`, [item]);
      const started = Date.now();
      try { await postDocument(identity, document.id, 1, key); }
      catch (error) { failure = error; }
      expect(failure).toMatchObject({ code: '55P03' });
      expect(Date.now() - started).toBeGreaterThanOrEqual(900);
      const response = apiError(failure);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: 'RETRYABLE_TRANSACTION' });
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
    }
    expect(await snapshot()).toEqual(before);
    await postDocument(identity, document.id, 1, key);
    expect(await effects(document.id, item)).toMatchObject({ document: { status: 'POSTED', version: 2 }, balances: [{ quantity: '20' }], ledger: [{ quantity_delta: '-80' }], audit: [{ action: 'POST_OUTBOUND' }] });
  });

  it('rejects read-only users without changing stock or document state', async () => {
    const item = await stocked();
    const document = await outbound([{ item_id: item, quantity: 80 }]);
    const before = await snapshot();
    await expect(postDocument({ ...identity, role: 'viewer' }, document.id, 1, randomUUID())).rejects.toMatchObject({ status: 403 });
    expect(await snapshot()).toEqual(before);
  });

  it('prevents foreign-tenant posting and result replay', async () => {
    const item = await stocked();
    const document = await outbound([{ item_id: item, quantity: 80 }]);
    const key = randomUUID();
    await expect(postDocument(foreignIdentity, document.id, 1, key)).rejects.toMatchObject({ status: 404 });
    await postDocument(identity, document.id, 1, key);
    const before = await snapshot();
    await expect(postDocument(foreignIdentity, document.id, 1, key)).rejects.toMatchObject({ status: 404 });
    expect(await snapshot()).toEqual(before);
    expect(await withTenant(foreignTenant, async client => (await client.query('SELECT * FROM idempotency_requests WHERE key=$1', [key])).rows)).toEqual([]);
  });
});
