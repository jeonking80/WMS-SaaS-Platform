import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/db-migrate.mjs';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl || !decodeURIComponent(new URL(databaseUrl).pathname).endsWith('_test')) {
  throw new Error('A dedicated TEST_DATABASE_URL ending in _test is required.');
}
const schema = `p3_${randomUUID().replaceAll('-', '')}`;
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
const tables = ['stock_balances', 'stock_ledger', 'idempotency_requests', 'audit_logs'];

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
  await owner.query(`REVOKE ALL ON "${schema}".stock_balances, "${schema}".stock_ledger, "${schema}".idempotency_requests, "${schema}".audit_logs FROM "${role}"`);
  await owner.query(`GRANT SELECT, INSERT, UPDATE ON "${schema}".stock_balances TO "${role}"`);
  await owner.query(`GRANT SELECT, INSERT ON "${schema}".stock_ledger, "${schema}".idempotency_requests, "${schema}".audit_logs TO "${role}"`);
  await owner.query(`INSERT INTO "${schema}"."user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES ('p3-actor','Actor','p3@example.test',true,now(),now())`);
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

describe('P3 inventory schema and nonowner grants', () => {
  it('forces tenant isolation and permits only append access to event records', async () => {
    const flags = await owner.query(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND relname=ANY($2)`, [schema, tables]);
    expect(flags.rows).toHaveLength(4);
    for (const row of flags.rows) expect(row).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    for (let i = 0; i < 2; i++) {
      await tenantQuery(tenants[i], 'INSERT INTO stock_balances (tenant_id,warehouse_id,location_id,item_id,quantity) VALUES ($1,$2,$3,$4,100)', [tenants[i], warehouses[i], locations[i], items[i]]);
      await tenantQuery(tenants[i], 'INSERT INTO stock_ledger (tenant_id,document_id,warehouse_id,location_id,item_id,quantity_delta) VALUES ($1,$2,$3,$4,$5,100)', [tenants[i], documents[i], warehouses[i], locations[i], items[i]]);
      await tenantQuery(tenants[i], `INSERT INTO idempotency_requests (tenant_id,key,request_hash,response) VALUES ($1,'key','hash','{}')`, [tenants[i]]);
      await tenantQuery(tenants[i], `INSERT INTO audit_logs (tenant_id,document_id,actor_id,action) VALUES ($1,$2,'p3-actor','POSTED')`, [tenants[i], documents[i]]);
    }
    for (const table of tables) {
      expect((await app!.query(`SELECT * FROM ${table}`)).rowCount).toBe(0);
      expect((await tenantQuery(tenants[0], `SELECT DISTINCT tenant_id FROM ${table}`)).rows).toEqual([{ tenant_id: tenants[0] }]);
      await expect(tenantQuery(tenants[0], `DELETE FROM ${table}`)).rejects.toMatchObject({ code: '42501' });
      if (table !== 'stock_balances') await expect(tenantQuery(tenants[0], `UPDATE ${table} SET tenant_id=tenant_id`)).rejects.toMatchObject({ code: '42501' });
    }
    await expect(tenantQuery(tenants[0], `INSERT INTO idempotency_requests (tenant_id,key,request_hash,response) VALUES ($1,'spoof','hash','{}')`, [tenants[1]])).rejects.toMatchObject({ code: '42501' });
  });

  it('enforces balance bounds, immutable ledger uniqueness and composite references', async () => {
    for (const quantity of ['-1', '9007199254740992']) {
      await expect(tenantQuery(tenants[0], 'UPDATE stock_balances SET quantity=$1', [quantity])).rejects.toMatchObject({ code: '23514' });
    }
    await tenantQuery(tenants[0], 'UPDATE stock_balances SET quantity=9007199254740991');
    await expect(tenantQuery(tenants[0], 'INSERT INTO stock_balances (tenant_id,warehouse_id,location_id,item_id) VALUES ($1,$2,$3,$4)', [tenants[0], warehouses[0], locations[0], items[0]])).rejects.toMatchObject({ code: '23505' });
    for (const [warehouse, location, item] of [[warehouses[1], locations[1], items[0]], [warehouses[0], locations[2], items[0]], [warehouses[0], locations[3], items[1]]]) {
      await expect(tenantQuery(tenants[0], 'INSERT INTO stock_balances (tenant_id,warehouse_id,location_id,item_id) VALUES ($1,$2,$3,$4)', [tenants[0], warehouse, location, item])).rejects.toMatchObject({ code: '23503' });
    }
    const ledger = 'INSERT INTO stock_ledger (tenant_id,document_id,warehouse_id,location_id,item_id,quantity_delta) VALUES ($1,$2,$3,$4,$5,$6)';
    await expect(tenantQuery(tenants[0], ledger, [tenants[0], documents[0], warehouses[0], locations[0], items[0], 100])).rejects.toMatchObject({ code: '23505' });
    await expect(tenantQuery(tenants[0], ledger, [tenants[0], documents[0], warehouses[0], locations[3], items[0], 0])).rejects.toMatchObject({ code: '23514' });
    await expect(tenantQuery(tenants[0], ledger, [tenants[0], documents[1], warehouses[0], locations[3], items[0], 1])).rejects.toMatchObject({ code: '23503' });
    await tenantQuery(tenants[0], ledger, [tenants[0], documents[0], warehouses[0], locations[3], items[0], 1000000000]);
    await expect(tenantQuery(tenants[0], `INSERT INTO idempotency_requests (tenant_id,key,request_hash,response) VALUES ($1,'key','other','{}')`, [tenants[0]])).rejects.toMatchObject({ code: '23505' });
    await expect(tenantQuery(tenants[0], `INSERT INTO idempotency_requests (tenant_id,key,request_hash,response) VALUES ($1,'incomplete','hash',NULL)`, [tenants[0]])).rejects.toMatchObject({ code: '23502' });
    await tenantQuery(tenants[0], `UPDATE inventory_documents SET status='POSTED',posted_at=now() WHERE id=$1`, [documents[0]]);
    expect((await tenantQuery(tenants[0], 'SELECT posted_at FROM inventory_documents WHERE id=$1', [documents[0]])).rows[0].posted_at).toBeInstanceOf(Date);
  });
});
