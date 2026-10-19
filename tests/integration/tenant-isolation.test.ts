import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { migrate } from '../../scripts/db-migrate.mjs';

const state = vi.hoisted(() => ({ pool: undefined as pg.Pool | undefined }));
vi.mock('../../src/server/db/pool', () => ({ getPool: () => state.pool }));
import { withTenant } from '../../src/server/db/tenant';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl || !decodeURIComponent(new URL(databaseUrl).pathname).endsWith('_test')) {
  throw new Error('A dedicated TEST_DATABASE_URL ending in _test is required.');
}
const schema = `tenant_${randomUUID().replaceAll('-', '')}`;
const appRole = `app_${randomUUID().replaceAll('-', '')}`;
const appPassword = randomBytes(32).toString('hex');
const owner = new pg.Pool({ connectionString: databaseUrl });
const appUrl = new URL(databaseUrl);
appUrl.username = appRole;
appUrl.password = appPassword;
let roleCreated = false;
const tenantA = randomUUID();
const tenantB = randomUUID();
let itemA: string;
let itemB: string;

beforeAll(async () => {
  await owner.query(`CREATE ROLE ${pg.escapeIdentifier(appRole)} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD ${pg.escapeLiteral(appPassword)}`);
  roleCreated = true;
  await migrate(databaseUrl, { schema, migrationsSchema: schema, createSchema: true, createMigrationsSchema: true, log: () => {} });
  await owner.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${appRole}"`);
  await owner.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON "${schema}".items TO "${appRole}"`);
  await owner.query(`INSERT INTO "${schema}".tenants (id, name) VALUES ($1, 'A'), ($2, 'B')`, [tenantA, tenantB]);
  state.pool = new pg.Pool({ connectionString: appUrl.toString(), max: 1, options: `-c search_path=${schema}` });
  itemA = await withTenant(tenantA, async client => (await client.query('INSERT INTO items (tenant_id, name, code) VALUES ($1, $2, $3) RETURNING id', [tenantA, 'A item', 'SHARED'])).rows[0].id);
  itemB = await withTenant(tenantB, async client => (await client.query('INSERT INTO items (tenant_id, name, code) VALUES ($1, $2, $3) RETURNING id', [tenantB, 'B item', 'SHARED'])).rows[0].id);
});
afterAll(async () => {
  await state.pool?.end();
  try { await owner.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
  finally {
    try { if (roleCreated) await owner.query(`DROP ROLE "${appRole}"`); }
    finally { await owner.end(); }
  }
});

describe('Nonowner application role tenant isolation', () => {
  it('is a nonowner, nonsuperuser without BYPASSRLS and cannot disable policies', async () => {
    const result = await state.pool!.query(`SELECT current_user, r.rolsuper, r.rolbypassrls,
      pg_get_userbyid(c.relowner) AS owner, c.relrowsecurity, c.relforcerowsecurity
      FROM pg_roles r JOIN pg_class c ON c.relname = 'items'
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE r.rolname = current_user AND n.nspname = $1`, [schema]);
    expect(result.rows[0]).toMatchObject({ current_user: appRole, rolsuper: false, rolbypassrls: false, relrowsecurity: true, relforcerowsecurity: true });
    expect(result.rows[0].owner).not.toBe(appRole);
    await expect(state.pool!.query('ALTER TABLE items DISABLE ROW LEVEL SECURITY')).rejects.toMatchObject({ code: '42501' });
    await expect(state.pool!.query('TRUNCATE items')).rejects.toMatchObject({ code: '42501' });
    await expect(state.pool!.query('SET ROLE postgres')).rejects.toMatchObject({ code: '42501' });
    await expect(state.pool!.query(`CREATE TABLE public."forbidden_${schema}" (id int)`)).rejects.toMatchObject({ code: '42501' });
  });

  it('returns no rows and refuses writes without a tenant context', async () => {
    expect((await state.pool!.query('SELECT * FROM items')).rowCount).toBe(0);
    expect((await state.pool!.query("UPDATE items SET name = 'Missing context'")).rowCount).toBe(0);
    expect((await state.pool!.query('DELETE FROM items')).rowCount).toBe(0);
    await expect(state.pool!.query("INSERT INTO items (tenant_id, name, code) VALUES ($1, 'Missing', 'MISSING')", [tenantA])).rejects.toMatchObject({ code: '42501' });
  });

  it('isolates A/B reads, updates, deletes and INSERT/UPDATE tenant spoofing', async () => {
    await withTenant(tenantA, async client => {
      expect((await client.query('SELECT id FROM items')).rows).toEqual([{ id: itemA }]);
      expect((await client.query('UPDATE items SET name = $1 WHERE id = $2', ['forbidden', itemB])).rowCount).toBe(0);
      expect((await client.query('DELETE FROM items WHERE id = $1', [itemB])).rowCount).toBe(0);
    });
    await expect(withTenant(tenantA, client => client.query("INSERT INTO items (tenant_id,name,code) VALUES ($1,'Spoof','SPOOF')", [tenantB]))).rejects.toMatchObject({ code: '42501' });
    await expect(withTenant(tenantA, client => client.query('UPDATE items SET tenant_id = $1 WHERE id = $2', [tenantB, itemA]))).rejects.toMatchObject({ code: '42501' });
    expect(await withTenant(tenantB, async client => (await client.query('SELECT id FROM items')).rows)).toEqual([{ id: itemB }]);
  });

  it('reuses the same physical connection without tenant leakage after commit or rollback', async () => {
    const pid = (await state.pool!.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    for (const tenant of [tenantA, tenantB, tenantA]) {
      await withTenant(tenant, async client => {
        expect((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid).toBe(pid);
        expect((await client.query('SELECT DISTINCT tenant_id FROM items')).rows).toEqual([{ tenant_id: tenant }]);
      });
      expect((await state.pool!.query('SELECT * FROM items')).rowCount).toBe(0);
    }
    await expect(withTenant(tenantA, async client => {
      await client.query("INSERT INTO items (tenant_id,name,code) VALUES ($1,'Rollback','ROLLBACK')", [tenantA]);
      throw new Error('rollback probe');
    })).rejects.toThrow('rollback probe');
    expect((await state.pool!.query('SELECT * FROM items')).rowCount).toBe(0);
    expect(await withTenant(tenantA, async client => (await client.query("SELECT * FROM items WHERE code='ROLLBACK'")).rowCount)).toBe(0);
  });

  it('enforces real tenant references and company-scoped code uniqueness', async () => {
    await expect(withTenant(tenantA, client => client.query("INSERT INTO items (tenant_id,name,code) VALUES ($1,'Duplicate','SHARED')", [tenantA]))).rejects.toMatchObject({ code: '23505' });
    const missing = randomUUID();
    await expect(withTenant(missing, client => client.query("INSERT INTO items (tenant_id,name,code) VALUES ($1,'Missing','FK')", [missing]))).rejects.toMatchObject({ code: '23503' });
  });
});
