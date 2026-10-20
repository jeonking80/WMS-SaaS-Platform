import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { migrate } from '../../scripts/db-migrate.mjs';
import type { Identity } from '../../src/server/auth/access';

const state = vi.hoisted(() => ({ pool: undefined as pg.Pool | undefined }));
vi.mock('../../src/server/db/pool', () => ({ getPool: () => state.pool }));
import { withTenant } from '../../src/server/db/tenant';
import { createDocument, updateDocument, type DocumentInput } from '../../src/server/documents';
import { reverseDocument } from '../../src/server/reverse';
import { postDocument, postInbound } from '../../src/server/posting';
import { pagedDocuments, parseQuery } from '../../src/server/queries';
import { getDocument, listDocuments } from '../../src/server/documents';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl || !decodeURIComponent(new URL(databaseUrl).pathname).endsWith('_test')) {
  throw new Error('A dedicated TEST_DATABASE_URL ending in _test is required.');
}
const schema = `delivery_${randomUUID().replaceAll('-', '')}`;
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

async function outbound() {
  const item = randomUUID();
  await withTenant(tenant, client => client.query("INSERT INTO items (id,tenant_id,code,name) VALUES ($1::uuid,$2,$1::text,'Item')", [item, tenant]));
  const base: DocumentInput = { kind: 'INBOUND', warehouse_id: warehouse, source_location_id: null, destination_location_id: location, note: '', lines: [{ item_id: item, quantity: 10 }] };
  const receipt = await createDocument(tenant, base);
  await postInbound(identity, receipt.id, 1, randomUUID());
  const input: DocumentInput = { ...base, kind: 'OUTBOUND', source_location_id: location, destination_location_id: null, recipient_name: '  Kim  ', delivery_address: '  Seoul  ', lines: [{ item_id: item, quantity: 3 }] };
  return { document: await createDocument(tenant, input), input, item };
}
describe('outbound delivery persisted against PostgreSQL', () => {
  it('round trips create, edit, list and detail and posts without changing destination', async () => {
    const { document, input, item } = await outbound();
    expect(document).toMatchObject({ recipient_name: 'Kim', delivery_address: 'Seoul' });
    const edited = await updateDocument(tenant, document.id, 1, { ...input, recipient_name: ' Lee ', delivery_address: ' Busan ' });
    expect(edited).toMatchObject({ recipient_name: 'Lee', delivery_address: 'Busan', version: 2 });
    expect((await listDocuments(tenant)).find(row => row.id === document.id)).toMatchObject({ recipient_name: 'Lee', delivery_address: 'Busan' });
    expect((await pagedDocuments(tenant, parseQuery(new URLSearchParams({ q: 'Busan' })))).documents).toEqual([expect.objectContaining({ id: document.id, delivery_address: 'Busan' })]);
    await postDocument(identity, document.id, 2, randomUUID());
    expect(await getDocument(tenant, document.id)).toMatchObject({ recipient_name: 'Lee', delivery_address: 'Busan', status: 'POSTED' });
    const balance = await withTenant(tenant, async client => (await client.query('SELECT quantity FROM stock_balances WHERE item_id=$1', [item])).rows);
    expect(balance).toEqual([{ quantity: '7' }]);
    await expect(getDocument(foreignTenant, document.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(updateDocument(tenant, document.id, 3, input)).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });
  it('blocks legacy drafts until filled and retains committed legacy replays', async () => {
    const { document, input } = await outbound();
    await withTenant(tenant, client => client.query('UPDATE inventory_documents SET recipient_name=NULL,delivery_address=NULL WHERE id=$1', [document.id]));
    await expect(postDocument(identity, document.id, 1, randomUUID())).rejects.toMatchObject({ code: 'DELIVERY_REQUIRED' });
    await updateDocument(tenant, document.id, 1, input);
    const key = randomUUID();
    const response = await postDocument(identity, document.id, 2, key);
    // Simulate a historic successful shipment that predated the nullable columns.
    await owner.query(`UPDATE "${schema}".inventory_documents SET recipient_name=NULL,delivery_address=NULL WHERE id=$1`, [document.id]);
    expect(await postDocument(identity, document.id, 2, key)).toEqual(response);
    expect(await getDocument(tenant, document.id)).toMatchObject({ recipient_name: null, delivery_address: null, status: 'POSTED' });
  });
  it('preserves original shipping while accounting reversals remain without shipping', async () => {
    const { document } = await outbound();
    await postDocument(identity, document.id, 1, randomUUID());
    const reversed = await reverseDocument({ ...identity, role: 'admin' }, document.id, 2, randomUUID());
    expect(await getDocument(tenant, document.id)).toMatchObject({ status: 'REVERSED', recipient_name: 'Kim', delivery_address: 'Seoul' });
    expect(await getDocument(tenant, reversed.reversal.id)).toMatchObject({ kind: 'INBOUND', recipient_name: null, delivery_address: null });
    const receipt = await createDocument(tenant, { kind: 'INBOUND', warehouse_id: warehouse, source_location_id: null, destination_location_id: location, note: '', lines: document.lines.map((line: { item_id: string; quantity: number }) => ({ item_id: line.item_id, quantity: line.quantity })) });
    await postInbound(identity, receipt.id, 1, randomUUID());
    const receiptReversal = await reverseDocument({ ...identity, role: 'admin' }, receipt.id, 2, randomUUID());
    expect(await getDocument(tenant, receiptReversal.reversal.id)).toMatchObject({ kind: 'OUTBOUND', status: 'POSTED', recipient_name: null, delivery_address: null });
  });
  it('enforces paired trimmed outbound-only columns in the database', async () => {
    const { document } = await outbound();
    for (const clause of ["recipient_name=NULL", "recipient_name=' '", "delivery_address=' Seoul '", "kind='INBOUND',source_location_id=NULL,destination_location_id=source_location_id"]) {
      await expect(withTenant(tenant, client => client.query(`UPDATE inventory_documents SET ${clause} WHERE id=$1`, [document.id]))).rejects.toMatchObject({ code: '23514' });
    }
  });
});
