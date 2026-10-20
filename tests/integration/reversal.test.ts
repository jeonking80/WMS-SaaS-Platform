import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { migrate } from '../../scripts/db-migrate.mjs';
import type { Identity } from '../../src/server/auth/access';

const state = vi.hoisted(() => ({ pool: undefined as pg.Pool | undefined }));
vi.mock('../../src/server/db/pool', () => ({ getPool: () => state.pool }));
import { withTenant } from '../../src/server/db/tenant';
import { createDocument, parseDocument, type DocumentInput } from '../../src/server/documents';
import { postDocument, postInbound } from '../../src/server/posting';
import { reverseDocument } from '../../src/server/reverse';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl || !decodeURIComponent(new URL(databaseUrl).pathname).endsWith('_test')) {
  throw new Error('A dedicated TEST_DATABASE_URL ending in _test is required.');
}
const schema = `reversal_${randomUUID().replaceAll('-', '')}`;
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
const identity: Identity = { user: { id: actor, name: 'Poster', email: `${actor}@example.test` }, tenant: { id: tenant, name: 'A' }, role: 'admin' };
const foreignIdentity: Identity = { ...identity, tenant: { id: foreignTenant, name: 'B' } };
const effectTables = ['inventory_document_lines', 'inventory_documents', 'stock_balances', 'stock_ledger', 'audit_logs', 'idempotency_requests'];

beforeAll(async () => {
  await owner.query(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD ${pg.escapeLiteral(password)}`);
  roleCreated = true;
  await migrate(databaseUrl, { schema, migrationsSchema: schema, createSchema: true, createMigrationsSchema: true, log: () => {} });
  await owner.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${role}"`);
  await owner.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${schema}" TO "${role}"`);
  await owner.query(`REVOKE UPDATE, DELETE ON "${schema}".stock_ledger, "${schema}".audit_logs, "${schema}".idempotency_requests FROM "${role}"`);
  await owner.query(`REVOKE DELETE ON "${schema}".stock_balances FROM "${role}"`);
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
async function documentBarrier(id: string, operations: (() => Promise<unknown>)[]) {
  const blocker = await owner.connect();
  let outcomes: Promise<PromiseSettledResult<unknown>[]> | undefined;
  try {
    await blocker.query('BEGIN');
    await blocker.query(`SELECT id FROM "${schema}".inventory_documents WHERE id=$1 FOR UPDATE`, [id]);
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

async function stockBarrier(item: string, operations: (() => Promise<unknown>)[]) {
  const blocker = await owner.connect();
  let outcomes: Promise<PromiseSettledResult<unknown>[]> | undefined;
  try {
    await blocker.query('BEGIN');
    await blocker.query(`SELECT quantity FROM "${schema}".stock_balances WHERE item_id=$1 ORDER BY location_id FOR UPDATE`, [item]);
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

async function secondLocation() {
  const id = randomUUID();
  await withTenant(tenant, client => client.query("INSERT INTO locations (id,tenant_id,warehouse_id,code,name) VALUES ($1::uuid,$2,$3,$1::text,'Other')", [id, tenant, warehouse]));
  return id;
}
async function transfer(item: string, destination: string, quantity = 60, source = location) {
  return createDocument(tenant, { kind: 'TRANSFER', warehouse_id: warehouse, source_location_id: source, destination_location_id: destination, note: '', lines: [{ item_id: item, quantity }] });
}
async function quantities(item: string) {
  return withTenant(tenant, async client => (await client.query('SELECT location_id,quantity FROM stock_balances WHERE item_id=$1 ORDER BY location_id', [item])).rows);
}
async function reversalOf(id: string) {
  return withTenant(tenant, async client => (await client.query('SELECT * FROM inventory_documents WHERE reversal_of_id=$1', [id])).rows);
}

describe('P5 transfer and reversal with restricted PostgreSQL application role', () => {
  it('rejects identical transfer locations and cross-warehouse destinations before stock effects', async () => {
    const item = await stocked();
    const input: DocumentInput = { kind: 'TRANSFER', warehouse_id: warehouse, source_location_id: location, destination_location_id: location, note: '', lines: [{ item_id: item, quantity: 1 }] };
    expect(() => parseDocument(input)).toThrow('INVALID_INPUT');
    const otherWarehouse = randomUUID();
    const otherLocation = randomUUID();
    await withTenant(tenant, async client => {
      await client.query("INSERT INTO warehouses (id,tenant_id,code,name) VALUES ($1::uuid,$2,$1::text,'Other')", [otherWarehouse, tenant]);
      await client.query("INSERT INTO locations (id,tenant_id,warehouse_id,code,name) VALUES ($1::uuid,$2,$3,$1::text,'Other')", [otherLocation, tenant, otherWarehouse]);
    });
    const before = await snapshot();
    await expect(createDocument(tenant, { ...input, destination_location_id: otherLocation })).rejects.toMatchObject({ status: 404, code: 'REFERENCE_NOT_FOUND' });
    expect(await snapshot()).toEqual(before);
  });

  it('rejects foreign tenants and non-admin reversal callers without effects', async () => {
    const document = await draft();
    await postDocument(identity, document.id, 1, randomUUID());
    const before = await snapshot();
    for (const role of ['worker', 'viewer'] as const) await expect(reverseDocument({ ...identity, role }, document.id, 2, randomUUID())).rejects.toMatchObject({ status: 403 });
    await expect(reverseDocument(foreignIdentity, document.id, 2, randomUUID())).rejects.toMatchObject({ status: 404 });
    expect(await snapshot()).toEqual(before);
  });

  it('moves 60 from 100 with balanced ledger legs, then reverses exactly those effects', async () => {
    const item = await stocked();
    const destination = await secondLocation();
    const document = await transfer(item, destination);
    await postDocument(identity, document.id, 1, randomUUID());
    const original = await effects(document.id, item);
    expect(await quantities(item)).toEqual(expect.arrayContaining([{ location_id: location, quantity: '40' }, { location_id: destination, quantity: '60' }]));
    expect(original.ledger.map(row => row.quantity_delta).sort()).toEqual(['-60', '60']);
    const key = randomUUID();
    const response = await reverseDocument(identity, document.id, 2, key);
    expect(await reverseDocument(identity, document.id, 2, key)).toEqual(response);
    const reversed = await reversalOf(document.id);
    expect(reversed).toHaveLength(1);
    expect(reversed[0]).toMatchObject({ kind: 'TRANSFER', status: 'POSTED', source_location_id: destination, destination_location_id: location });
    const after = await effects(document.id, item);
    expect(after.document).toMatchObject({ status: 'REVERSED', version: 3, posted_at: original.document.posted_at });
    expect(after.ledger).toEqual(original.ledger);
    expect(await quantities(item)).toEqual(expect.arrayContaining([{ location_id: location, quantity: '100' }, { location_id: destination, quantity: '0' }]));
    await withTenant(tenant, async client => {
      expect((await client.query('SELECT item_id,quantity FROM inventory_document_lines WHERE document_id=$1', [reversed[0].id])).rows).toEqual([{ item_id: item, quantity: 60 }]);
      expect((await client.query('SELECT location_id,quantity_delta FROM stock_ledger WHERE document_id=$1', [reversed[0].id])).rows).toEqual(expect.arrayContaining([{ location_id: location, quantity_delta: '60' }, { location_id: destination, quantity_delta: '-60' }]));
    });
    const before = await snapshot();
    await expect(reverseDocument(identity, document.id, 3, randomUUID())).rejects.toMatchObject({ status: 409 });
    await expect(reverseDocument(identity, reversed[0].id, reversed[0].version, randomUUID())).rejects.toMatchObject({ status: 409 });
    await expect(postDocument(identity, document.id, 3, randomUUID())).rejects.toMatchObject({ status: 409 });
    expect(await snapshot()).toEqual(before);
  });

  it('reverses inbound by subtracting and outbound by restoring even inactive historical references', async () => {
    const inbound = await draft(100);
    await postDocument(identity, inbound.id, 1, randomUUID());
    await reverseDocument(identity, inbound.id, 2, randomUUID());
    expect((await quantities(inbound.item))[0].quantity).toBe('0');
    expect((await reversalOf(inbound.id))[0].kind).toBe('OUTBOUND');
    const item = await stocked(100);
    const document = await outbound([{ item_id: item, quantity: 100 }]);
    await postDocument(identity, document.id, 1, randomUUID());
    await owner.query(`UPDATE "${schema}".items SET active=false WHERE id=$1`, [item]);
    await reverseDocument(identity, document.id, 2, randomUUID());
    expect((await quantities(item))[0].quantity).toBe('100');
    expect((await reversalOf(document.id))[0].kind).toBe('INBOUND');
  });

  it('rolls back insufficient inbound and transfer reversals including new reversal documents and lines', async () => {
    const inbound = await draft(100);
    await postDocument(identity, inbound.id, 1, randomUUID());
    const consumed = await outbound([{ item_id: inbound.item, quantity: 1 }]);
    await postDocument(identity, consumed.id, 1, randomUUID());
    let before = await snapshot();
    await expect(reverseDocument(identity, inbound.id, 2, randomUUID())).rejects.toMatchObject({ status: 409, code: 'INSUFFICIENT_STOCK' });
    expect(await snapshot()).toEqual(before);
    const destination = await secondLocation();
    const document = await transfer(inbound.item, destination, 60);
    await postDocument(identity, document.id, 1, randomUUID());
    const outgoing = await createDocument(tenant, { kind: 'OUTBOUND', recipient_name: 'Test recipient', delivery_address: 'Test delivery address', warehouse_id: warehouse, source_location_id: destination, destination_location_id: null, note: '', lines: [{ item_id: inbound.item, quantity: 1 }] });
    await postDocument(identity, outgoing.id, 1, randomUUID());
    before = await snapshot();
    await expect(reverseDocument(identity, document.id, 2, randomUUID())).rejects.toMatchObject({ status: 409, code: 'INSUFFICIENT_STOCK' });
    expect(await snapshot()).toEqual(before);
  });

  it.each([true, false])('serializes concurrent reversals on the original document (same key: %s)', async sameKey => {
    const document = await draft();
    await postDocument(identity, document.id, 1, randomUUID());
    const key = randomUUID();
    const results = await documentBarrier(document.id, [() => reverseDocument(identity, document.id, 2, key), () => reverseDocument(identity, document.id, 2, sameKey ? key : randomUUID())]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(sameKey ? 2 : 1);
    if (sameKey) expect(results[0]).toEqual(results[1]);
    else expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { status: 409 } });
    expect(await reversalOf(document.id)).toHaveLength(1);
    expect((await quantities(document.item))[0].quantity).toBe('0');
  });

  it('locks opposing transfer locations in one order without a deadlock', async () => {
    const item = await stocked(100);
    const destination = await secondLocation();
    const seed = await transfer(item, destination, 50);
    await postDocument(identity, seed.id, 1, randomUUID());
    const forward = await transfer(item, destination, 20);
    const backward = await transfer(item, location, 20, destination);
    const results = await stockBarrier(item, [() => postDocument(identity, forward.id, 1, randomUUID()), () => postDocument(identity, backward.id, 1, randomUUID())]);
    expect(results.every(result => result.status === 'fulfilled')).toBe(true);
    expect(await quantities(item)).toEqual(expect.arrayContaining([{ location_id: location, quantity: '50' }, { location_id: destination, quantity: '50' }]));
    for (const document of [forward, backward]) expect((await effects(document.id, item)).ledger).toHaveLength(2);
  });

  it('rolls back all reversal effects after a final idempotency insert failure and retries the same key', async () => {
    const document = await draft();
    await postDocument(identity, document.id, 1, randomUUID());
    const key = randomUUID();
    const before = await snapshot();
    await owner.query(`CREATE FUNCTION "${schema}".fail_reversal_key() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.key = '${key}' THEN RAISE EXCEPTION 'injected idempotency failure'; END IF; RETURN NEW; END $$`);
    await owner.query(`CREATE TRIGGER fail_reversal_key BEFORE INSERT ON "${schema}".idempotency_requests FOR EACH ROW EXECUTE FUNCTION "${schema}".fail_reversal_key()`);
    try {
      await expect(reverseDocument(identity, document.id, 2, key)).rejects.toThrow('injected idempotency failure');
      expect(await snapshot()).toEqual(before);
    } finally {
      await owner.query(`DROP TRIGGER fail_reversal_key ON "${schema}".idempotency_requests`);
      await owner.query(`DROP FUNCTION "${schema}".fail_reversal_key()`);
    }
    await reverseDocument(identity, document.id, 2, key);
    expect(await reversalOf(document.id)).toHaveLength(1);
    expect((await quantities(document.item))[0].quantity).toBe('0');
  });
});
