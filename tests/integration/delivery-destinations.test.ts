import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { migrate } from '../../scripts/db-migrate.mjs';
import type { Identity } from '../../src/server/auth/access';

const state = vi.hoisted(() => ({ pool: undefined as pg.Pool | undefined }));
vi.mock('../../src/server/db/pool', () => ({ getPool: () => state.pool }));
vi.mock('../../src/server/auth/access', async importOriginal => ({ ...await importOriginal<object>(), requireIdentity: async () => identity }));
import { withTenant } from '../../src/server/db/tenant';
import { createDocument, updateDocument, type DocumentInput } from '../../src/server/documents';
import { getDocument } from '../../src/server/documents';
import { destinationCollection, destinationDetail } from '../../src/server/delivery-destinations';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl || !decodeURIComponent(new URL(databaseUrl).pathname).endsWith('_test')) {
  throw new Error('A dedicated TEST_DATABASE_URL ending in _test is required.');
}
const schema = `destinations_${randomUUID().replaceAll('-', '')}`;
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

function request(method = 'GET', body?: object, suffix = '') {
  return new Request(`http://localhost:3000/api/delivery-destinations${suffix}`, { method, headers: { origin: 'http://localhost:3000', 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
}
async function createDestination(name: string, recipient_name = 'Recipient') {
  const response = await destinationCollection(request('POST', { recipient_name, name, postal_code: '01234', address_line1: 'Seoul', address_line2: '101' }));
  expect(response.status).toBe(201);
  return (await response.json()).destination;
}
async function patch(id: string, body: object) { return destinationDetail(request('PATCH', body), { params: Promise.resolve({ id }) }); }
describe('delivery address book PostgreSQL integration', () => {
  it('backfills distinct valid historical addresses per tenant while retaining original snapshots and context', async () => {
    const upgradeSchema = `upgrade_${randomUUID().replaceAll('-', '')}`;
    try {
      await migrate(databaseUrl, { schema: upgradeSchema, migrationsSchema: upgradeSchema, createSchema: true, createMigrationsSchema: true, count: 8, log: () => {} });
      const client = await owner.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SET LOCAL search_path TO "${upgradeSchema}"`);
        await client.query("SELECT set_config('app.tenant_id',$1,true)", [foreignTenant]);
        await client.query("INSERT INTO tenants (id,name) VALUES ($1,'A'),($2,'B')", [tenant, foreignTenant]);
        await client.query("INSERT INTO warehouses (id,tenant_id,code,name) VALUES ($1,$2,'MAIN','Main')", [warehouse, tenant]);
        await client.query("INSERT INTO locations (id,tenant_id,warehouse_id,code,name) VALUES ($1,$2,$3,'MAIN','Main')", [location, tenant, warehouse]);
        await client.query("INSERT INTO warehouses (id,tenant_id,code,name) VALUES ($1,$2,'MAIN','Main')", [foreignTenant, foreignTenant]);
        await client.query("INSERT INTO locations (id,tenant_id,warehouse_id,code,name) VALUES ($1,$1,$1,'MAIN','Main')", [foreignTenant]);
        for (const address of ['Busan', 'Seoul', 'Seoul', 'x'.repeat(301)]) {
          await client.query("INSERT INTO inventory_documents (tenant_id,kind,warehouse_id,source_location_id,recipient_name,delivery_address) VALUES ($1,'OUTBOUND',$2,$3,'Kim',$4)", [tenant, warehouse, location, address]);
        }
        await client.query("INSERT INTO inventory_documents (tenant_id,kind,warehouse_id,source_location_id,recipient_name,delivery_address) VALUES ($1,'OUTBOUND',$1,$1,'Kim','Seoul')", [foreignTenant]);
        const snapshots = (await client.query('SELECT id,recipient_name,delivery_address FROM inventory_documents ORDER BY id')).rows;
        const sql = readFileSync(new URL('../../db/migrations/1792368000008_delivery-destinations.sql', import.meta.url), 'utf8').split('-- Down Migration')[0];
        await client.query(sql);
        expect((await client.query("SELECT current_setting('app.tenant_id') AS tenant")).rows[0].tenant).toBe(foreignTenant);
        expect((await client.query('SELECT tenant_id,name,address_line1 FROM delivery_destinations ORDER BY tenant_id,name')).rows).toEqual(expect.arrayContaining([
          { tenant_id: tenant, name: '기존 배송지 1', address_line1: 'Busan' },
          { tenant_id: tenant, name: '기존 배송지 2', address_line1: 'Seoul' },
          { tenant_id: foreignTenant, name: '기존 배송지 1', address_line1: 'Seoul' },
        ]));
        expect((await client.query('SELECT count(*)::int AS count FROM delivery_destinations')).rows[0].count).toBe(3);
        expect((await client.query('SELECT id,recipient_name,delivery_address FROM inventory_documents ORDER BY id')).rows).toEqual(snapshots);
        expect((await client.query('SELECT count(*)::int AS count FROM inventory_documents WHERE delivery_destination_id IS NOT NULL')).rows[0].count).toBe(0);
        await client.query('ROLLBACK');
      } finally { await client.query('ROLLBACK'); client.release(); }
    } finally { await owner.query(`DROP SCHEMA IF EXISTS "${upgradeSchema}" CASCADE`); }
  }, 30_000);
  it('supports CRUD, literal search, paging, inactive filters, and tenant isolation', async () => {
    identity.role = 'admin'; process.env.BETTER_AUTH_URL = 'http://localhost:3000';
    const a = await createDestination('Literal_%\\', 'Search');
    await createDestination('LiteralABC', 'Search');
    const found = await destinationCollection(request('GET', undefined, '?q=' + encodeURIComponent('_%\\') + '&page_size=1'));
    expect(await found.json()).toMatchObject({ destinations: [{ id: a.id, delivery_address: 'Seoul 101', postal_code: '01234' }], pagination: { total: 1, page_size: 1 } });
    const paged = await destinationCollection(request('GET', undefined, '?q=Search&page_size=1&page=2'));
    expect(await paged.json()).toMatchObject({ destinations: [expect.anything()], pagination: { total: 2, total_pages: 2 } });
    identity.role = 'worker';
    expect((await destinationCollection(request())).status).toBe(200);
    identity.role = 'admin';
    expect((await patch(a.id, { active: false })).status).toBe(200);
    identity.role = 'worker';
    expect((await destinationDetail(request(), { params: Promise.resolve({ id: a.id }) })).status).toBe(404);
    identity.role = 'admin';
    expect(await (await destinationCollection(request('GET', undefined, '?q=' + encodeURIComponent('_%\\')))).json()).toMatchObject({ destinations: [] });
    expect(await (await destinationCollection(request('GET', undefined, '?include_inactive=true&q=' + encodeURIComponent('_%\\')))).json()).toMatchObject({ destinations: [{ id: a.id, active: false }] });
    await expect(withTenant(foreignTenant, async client => (await client.query('SELECT * FROM delivery_destinations WHERE id=$1', [a.id])).rows)).resolves.toEqual([]);
    identity.tenant.id = foreignTenant;
    expect((await patch(a.id, { active: true })).status).toBe(404);
    identity.tenant.id = tenant;
  });
  it('derives snapshots, retains historical text, rejects inactive and foreign IDs, and supports direct text', async () => {
    identity.role = 'admin';
    const destination = await createDestination(randomUUID());
    const item = randomUUID();
    await withTenant(tenant, client => client.query("INSERT INTO items (id,tenant_id,code,name) VALUES ($1::uuid,$2,$1::text,'Item')", [item, tenant]));
    const input: DocumentInput = { kind: 'OUTBOUND', warehouse_id: warehouse, source_location_id: location, destination_location_id: null, note: '', delivery_destination_id: destination.id, recipient_name: 'Spoof', delivery_address: 'Spoof', lines: [{ item_id: item, quantity: 1 }] };
    const doc = await createDocument(tenant, input);
    expect(doc).toMatchObject({ delivery_destination_id: destination.id, recipient_name: 'Recipient', delivery_address: 'Seoul 101' });
    await patch(destination.id, { recipient_name: 'Changed', address_line1: 'Busan', active: false });
    expect(await getDocument(tenant, doc.id)).toMatchObject({ recipient_name: 'Recipient', delivery_address: 'Seoul 101' });
    await expect(createDocument(tenant, input)).rejects.toMatchObject({ code: 'REFERENCE_NOT_FOUND' });
    await expect(updateDocument(tenant, doc.id, 1, input)).rejects.toMatchObject({ code: 'REFERENCE_NOT_FOUND' });
    await withTenant(foreignTenant, client => client.query("INSERT INTO delivery_destinations (id,tenant_id,recipient_name,name,address_line1) VALUES ($1,$2,'Foreign','Office','Elsewhere')", [item, foreignTenant]));
    await expect(createDocument(tenant, { ...input, delivery_destination_id: item })).rejects.toMatchObject({ code: 'REFERENCE_NOT_FOUND' });
    await expect(withTenant(tenant, client => client.query('UPDATE inventory_documents SET delivery_destination_id=$2 WHERE id=$1', [doc.id, item]))).rejects.toMatchObject({ code: '23503' });
    const legacy = await createDocument(tenant, { ...input, delivery_destination_id: null, recipient_name: ' Direct ', delivery_address: ' Text ' });
    expect(legacy).toMatchObject({ delivery_destination_id: null, recipient_name: 'Direct', delivery_address: 'Text' });
  });
});
