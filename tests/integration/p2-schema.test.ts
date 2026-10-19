import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/db-migrate.mjs';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl || !decodeURIComponent(new URL(databaseUrl).pathname).endsWith('_test')) {
  throw new Error('A dedicated TEST_DATABASE_URL ending in _test is required.');
}
const schema = `p2_${randomUUID().replaceAll('-', '')}`;
const role = `app_${randomUUID().replaceAll('-', '')}`;
const password = randomBytes(32).toString('hex');
const owner = new pg.Pool({ connectionString: databaseUrl });
const appUrl = new URL(databaseUrl);
appUrl.username = role;
appUrl.password = password;
let app: pg.Pool | undefined;
let roleCreated = false;
const tenants = [randomUUID(), randomUUID()];
const warehouses = [randomUUID(), randomUUID(), randomUUID()];
const locations = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
const items = [randomUUID(), randomUUID()];
const documents = [randomUUID(), randomUUID()];
const tables = ['warehouses', 'locations', 'inventory_documents', 'inventory_document_lines'];

async function tenantQuery(tenant: string, sql: string, values: unknown[] = []) {
  const client = await app!.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenant]);
    const result = await client.query(sql, values);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

beforeAll(async () => {
  await owner.query(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD ${pg.escapeLiteral(password)}`);
  roleCreated = true;
  await migrate(databaseUrl, { schema, migrationsSchema: schema, createSchema: true, createMigrationsSchema: true, log: () => {} });
  await owner.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${role}"`);
  await owner.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${schema}" TO "${role}"`);
  await owner.query(`INSERT INTO "${schema}".tenants (id,name) VALUES ($1,'A'),($2,'B')`, tenants);
  app = new pg.Pool({ connectionString: appUrl.toString(), max: 1, options: `-c search_path=${schema}` });
  for (let i = 0; i < 2; i++) {
    await tenantQuery(tenants[i], "INSERT INTO warehouses (id,tenant_id,code,name) VALUES ($1,$2,'MAIN','Main')", [warehouses[i], tenants[i]]);
    await tenantQuery(tenants[i], "INSERT INTO locations (id,tenant_id,warehouse_id,code,name) VALUES ($1,$2,$3,'A','A')", [locations[i], tenants[i], warehouses[i]]);
    await tenantQuery(tenants[i], "INSERT INTO items (id,tenant_id,code,name) VALUES ($1,$2,'ITEM','Item')", [items[i], tenants[i]]);
    await tenantQuery(tenants[i], "INSERT INTO inventory_documents (id,tenant_id,kind,warehouse_id,destination_location_id) VALUES ($1,$2,'INBOUND',$3,$4)", [documents[i], tenants[i], warehouses[i], locations[i]]);
    await tenantQuery(tenants[i], 'INSERT INTO inventory_document_lines (tenant_id,document_id,item_id,quantity) VALUES ($1,$2,$3,1)', [tenants[i], documents[i], items[i]]);
  }
  await tenantQuery(tenants[0], "INSERT INTO warehouses (id,tenant_id,code,name) VALUES ($1,$2,'SECOND','Second')", [warehouses[2], tenants[0]]);
  await tenantQuery(tenants[0], "INSERT INTO locations (id,tenant_id,warehouse_id,code,name) VALUES ($1,$2,$3,'A','A'),($4,$2,$5,'B','B')", [locations[2], tenants[0], warehouses[2], locations[3], warehouses[0]]);
}, 30_000);

afterAll(async () => {
  await app?.end();
  try { await owner.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
  finally {
    try { if (roleCreated) await owner.query(`DROP ROLE "${role}"`); }
    finally { await owner.end(); }
  }
});

describe('P2 relational constraints and tenant isolation', () => {
  it('forces RLS for every new business table and isolates reads and mutations', async () => {
    const flags = await owner.query(`SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND relname=ANY($2)`, [schema, tables]);
    expect(flags.rows).toHaveLength(4);
    for (const row of flags.rows) expect(row).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
    for (const table of tables) {
      expect((await app!.query(`SELECT * FROM ${table}`)).rowCount).toBe(0);
      expect((await app!.query(`DELETE FROM ${table}`)).rowCount).toBe(0);
      expect((await tenantQuery(tenants[0], `SELECT DISTINCT tenant_id FROM ${table}`)).rows).toEqual([{ tenant_id: tenants[0] }]);
      expect((await tenantQuery(tenants[0], `UPDATE ${table} SET tenant_id=tenant_id WHERE tenant_id=$1`, [tenants[1]])).rowCount).toBe(0);
      expect((await tenantQuery(tenants[0], `DELETE FROM ${table} WHERE tenant_id=$1`, [tenants[1]])).rowCount).toBe(0);
      await expect(tenantQuery(tenants[0], `UPDATE ${table} SET tenant_id=$1`, [tenants[1]])).rejects.toMatchObject({ code: '42501' });
    }
    await expect(tenantQuery(tenants[0], "INSERT INTO warehouses (tenant_id,code,name) VALUES ($1,'SPOOF','Spoof')", [tenants[1]])).rejects.toMatchObject({ code: '42501' });
    expect((await app!.query('SELECT * FROM warehouses')).rowCount).toBe(0);
  });

  it('rejects cross-company and cross-warehouse references', async () => {
    await expect(tenantQuery(tenants[0], "INSERT INTO locations (tenant_id,warehouse_id,code,name) VALUES ($1,$2,'BAD','Bad')", [tenants[0], warehouses[1]])).rejects.toMatchObject({ code: '23503' });
    for (const location of [locations[1], locations[2]]) {
      await expect(tenantQuery(tenants[0], "INSERT INTO inventory_documents (tenant_id,kind,warehouse_id,destination_location_id) VALUES ($1,'INBOUND',$2,$3)", [tenants[0], warehouses[0], location])).rejects.toMatchObject({ code: '23503' });
    }
    for (const [document, item] of [[documents[1], items[0]], [documents[0], items[1]]]) {
      await expect(tenantQuery(tenants[0], 'INSERT INTO inventory_document_lines (tenant_id,document_id,item_id,quantity) VALUES ($1,$2,$3,1)', [tenants[0], document, item])).rejects.toMatchObject({ code: '23503' });
    }
  });

  it('enforces scoped codes, document shape, status, version and quantity bounds', async () => {
    await expect(tenantQuery(tenants[0], "INSERT INTO warehouses (tenant_id,code,name) VALUES ($1,'MAIN','Duplicate')", [tenants[0]])).rejects.toMatchObject({ code: '23505' });
    await expect(tenantQuery(tenants[0], "INSERT INTO locations (tenant_id,warehouse_id,code,name) VALUES ($1,$2,'A','Duplicate')", [tenants[0], warehouses[0]])).rejects.toMatchObject({ code: '23505' });
    for (const [kind, source, destination] of [['INBOUND', locations[0], locations[3]], ['OUTBOUND', null, locations[0]], ['TRANSFER', locations[0], locations[0]], ['TRANSFER', locations[0], null], ['UNKNOWN', null, locations[0]]]) {
      await expect(tenantQuery(tenants[0], 'INSERT INTO inventory_documents (tenant_id,warehouse_id,kind,source_location_id,destination_location_id) VALUES ($1,$2,$3,$4,$5)', [tenants[0], warehouses[0], kind, source, destination])).rejects.toMatchObject({ code: '23514' });
    }
    for (const [column, value] of [['version', 0], ['status', 'UNKNOWN']]) {
      await expect(tenantQuery(tenants[0], `UPDATE inventory_documents SET ${column}=$1 WHERE id=$2`, [value, documents[0]])).rejects.toMatchObject({ code: '23514' });
    }
    for (const quantity of [0, -1, 1000000001]) {
      await expect(tenantQuery(tenants[0], 'UPDATE inventory_document_lines SET quantity=$1 WHERE document_id=$2', [quantity, documents[0]])).rejects.toMatchObject({ code: '23514' });
    }
    await expect(tenantQuery(tenants[0], 'INSERT INTO inventory_document_lines (tenant_id,document_id,item_id,quantity) VALUES ($1,$2,$3,1)', [tenants[0], documents[0], items[0]])).rejects.toMatchObject({ code: '23505' });
    expect((await tenantQuery(tenants[0], 'SELECT version,status,note FROM inventory_documents WHERE id=$1', [documents[0]])).rows[0]).toEqual({ version: 1, status: 'DRAFT', note: '' });
    await tenantQuery(tenants[0], 'UPDATE inventory_document_lines SET quantity=1000000000 WHERE document_id=$1', [documents[0]]);
    await tenantQuery(tenants[0], "INSERT INTO inventory_documents (tenant_id,warehouse_id,kind,source_location_id,destination_location_id) VALUES ($1,$2,'TRANSFER',$3,$4),($1,$2,'OUTBOUND',$3,NULL)", [tenants[0], warehouses[0], locations[0], locations[3]]);
  });

  it('cascades document deletion only to its lines', async () => {
    await tenantQuery(tenants[0], 'DELETE FROM inventory_documents WHERE id=$1', [documents[0]]);
    expect((await tenantQuery(tenants[0], 'SELECT * FROM inventory_document_lines WHERE document_id=$1', [documents[0]])).rowCount).toBe(0);
    expect((await tenantQuery(tenants[1], 'SELECT * FROM inventory_document_lines WHERE document_id=$1', [documents[1]])).rowCount).toBe(1);
    expect((await tenantQuery(tenants[0], 'SELECT * FROM items WHERE id=$1', [items[0]])).rowCount).toBe(1);
  });
});
