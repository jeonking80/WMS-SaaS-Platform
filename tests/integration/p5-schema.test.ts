import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/db-migrate.mjs';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl || !decodeURIComponent(new URL(databaseUrl).pathname).endsWith('_test')) {
  throw new Error('A dedicated TEST_DATABASE_URL ending in _test is required.');
}
const schema = `p5_${randomUUID().replaceAll('-', '')}`;
const owner = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
const tenants = [randomUUID(), randomUUID()];
const warehouses = [randomUUID(), randomUUID()];
const locations = [randomUUID(), randomUUID()];
const originals = [randomUUID(), randomUUID()];

async function insertDocument(tenantIndex: number, status: string, reversalOf: string | null = null, id = randomUUID()) {
  return owner.query(`INSERT INTO inventory_documents
    (id,tenant_id,kind,status,warehouse_id,destination_location_id,reversal_of_id)
    VALUES ($1,$2,'INBOUND',$3,$4,$5,$6) RETURNING *`,
  [id, tenants[tenantIndex], status, warehouses[tenantIndex], locations[tenantIndex], reversalOf]);
}

beforeAll(async () => {
  await migrate(databaseUrl, { schema, migrationsSchema: schema, createSchema: true, createMigrationsSchema: true, log: () => {} });
  for (let i = 0; i < 2; i++) {
    await owner.query("INSERT INTO tenants (id,name) VALUES ($1,'Tenant')", [tenants[i]]);
    await owner.query("INSERT INTO warehouses (id,tenant_id,code,name) VALUES ($1,$2,'MAIN','Main')", [warehouses[i], tenants[i]]);
    await owner.query("INSERT INTO locations (id,tenant_id,warehouse_id,code,name) VALUES ($1,$2,$3,'A','A')", [locations[i], tenants[i], warehouses[i]]);
    await insertDocument(i, 'POSTED', null, originals[i]);
  }
});

afterAll(async () => {
  try { await owner.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
  finally { await owner.end(); }
});

describe('P5 reversal schema', () => {
  it('preserves ordinary document states and nullable reversal metadata', async () => {
    for (const status of ['DRAFT', 'CANCELLED', 'POSTED']) {
      const result = await insertDocument(0, status);
      expect(result.rows[0]).toMatchObject({ status, reversal_of_id: null, reversed_at: null });
    }
    await expect(insertDocument(0, 'UNKNOWN')).rejects.toMatchObject({ code: '23514' });
    const result = await owner.query(`UPDATE inventory_documents SET status='REVERSED', reversed_at=now()
      WHERE id=$1 RETURNING status,reversed_at`, [originals[0]]);
    expect(result.rows[0].status).toBe('REVERSED');
    expect(result.rows[0].reversed_at).toBeInstanceOf(Date);
  });

  it('requires a same-tenant original and allows at most one reversal per original', async () => {
    await expect(insertDocument(0, 'POSTED', originals[1])).rejects.toMatchObject({ code: '23503' });
    await expect(insertDocument(0, 'POSTED', randomUUID())).rejects.toMatchObject({ code: '23503' });
    const result = await insertDocument(0, 'POSTED', originals[0]);
    expect(result.rows[0].reversal_of_id).toBe(originals[0]);
    await expect(insertDocument(0, 'POSTED', originals[0])).rejects.toMatchObject({ code: '23505' });
    // The reference also prevents deleting an original that has a reversal.
    await expect(owner.query('DELETE FROM inventory_documents WHERE id=$1', [originals[0]])).rejects.toMatchObject({ code: '23503' });
  });

  it('rejects self references and nonposted reversal documents on insert and update', async () => {
    const self = randomUUID();
    await expect(insertDocument(0, 'POSTED', self, self)).rejects.toMatchObject({ code: '23514' });
    for (const status of ['DRAFT', 'CANCELLED', 'REVERSED']) {
      await expect(insertDocument(1, status, originals[1])).rejects.toMatchObject({ code: '23514' });
    }
    const result = await insertDocument(1, 'POSTED', originals[1]);
    for (const status of ['DRAFT', 'CANCELLED', 'REVERSED']) {
      await expect(owner.query('UPDATE inventory_documents SET status=$1 WHERE id=$2', [status, result.rows[0].id]))
        .rejects.toMatchObject({ code: '23514' });
    }
  });
});
