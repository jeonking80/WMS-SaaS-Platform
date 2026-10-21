import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, expect, it } from 'vitest';
import { migrate } from '../../scripts/db-migrate.mjs';
import { documentNumberSql } from '../../src/server/document-number';
const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl || !decodeURIComponent(new URL(databaseUrl).pathname).endsWith('_test')) throw new Error('Dedicated TEST_DATABASE_URL required.');
const schema = `numbers_${randomUUID().replaceAll('-', '')}`;
const owner = new pg.Pool({connectionString:databaseUrl});
const options = {schema,migrationsSchema:schema,createSchema:true,createMigrationsSchema:true,log:()=>{}};
afterAll(async () => {
  try { await owner.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await owner.end(); }
});
it('backfills existing documents, never resets on rerun, and never truncates large numbers', async () => {
  await migrate(databaseUrl,{...options,count:9});
  const client = await owner.connect();
  let tenant = '', warehouse = '', location = '', existing = '';
  try {
    await client.query(`SET search_path TO "${schema}"`);
    tenant = (await client.query("INSERT INTO tenants(name) VALUES ('A') RETURNING id")).rows[0].id;
    await client.query("SELECT set_config('app.tenant_id',$1,false)",[tenant]);
    warehouse = (await client.query("INSERT INTO warehouses(tenant_id,code,name) VALUES ($1,'W','W') RETURNING id",[tenant])).rows[0].id;
    location = (await client.query("INSERT INTO locations(tenant_id,warehouse_id,code,name) VALUES ($1,$2,'L','L') RETURNING id",[tenant,warehouse])).rows[0].id;
    existing = (await client.query("INSERT INTO inventory_documents(tenant_id,kind,warehouse_id,destination_location_id) VALUES ($1,'INBOUND',$2,$3) RETURNING id",[tenant,warehouse,location])).rows[0].id;
  } finally { client.release(); }
  expect(await migrate(databaseUrl,options)).toHaveLength(12);
  const check = await owner.connect();
  try {
    await check.query(`SET search_path TO "${schema}"`);
    await check.query("SELECT set_config('app.tenant_id',$1,false)",[tenant]);
    const number = (await check.query('SELECT document_no FROM inventory_documents WHERE id=$1',[existing])).rows[0].document_no;
    expect(BigInt(number)).toBeGreaterThan(0n);
    await check.query("SELECT setval('inventory_documents_document_no_seq',1000000)");
    const created = (await check.query(`INSERT INTO inventory_documents(tenant_id,kind,warehouse_id,destination_location_id) VALUES ($1,'INBOUND',$2,$3) RETURNING id,document_no,${documentNumberSql('inventory_documents')} AS document_number`,[tenant,warehouse,location])).rows[0];
    expect(created.document_number).toBe('WMS-1000001');
    expect(await migrate(databaseUrl,options)).toHaveLength(0);
    const after = (await check.query("INSERT INTO inventory_documents(tenant_id,kind,warehouse_id,destination_location_id) VALUES ($1,'INBOUND',$2,$3) RETURNING document_no",[tenant,warehouse,location])).rows[0];
    expect(BigInt(after.document_no)).toBeGreaterThan(BigInt(created.document_no));
    expect((await check.query('SELECT document_no FROM inventory_documents WHERE id=$1',[existing])).rows[0].document_no).toBe(number);
    await expect(check.query('UPDATE inventory_documents SET document_no=DEFAULT WHERE id=$1',[existing])).rejects.toMatchObject({code:'23514'});
  } finally { check.release(); }
},30000);
