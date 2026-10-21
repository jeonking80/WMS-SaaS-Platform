import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/db-migrate.mjs';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) {
  throw new Error('TEST_DATABASE_URL is required for PostgreSQL integration tests.');
}
const databaseName = decodeURIComponent(new URL(databaseUrl).pathname.slice(1));
if (!databaseName.endsWith('_test')) {
  throw new Error('Integration tests require a dedicated database whose name ends in _test.');
}

const schema = `test_${randomUUID().replaceAll('-', '')}`;
const client = new pg.Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5000 });
const migrationOptions = {
  schema,
  migrationsSchema: schema,
  createSchema: true,
  createMigrationsSchema: true,
  log: () => {},
};
let connected = false;

beforeAll(async () => {
  await client.connect();
  connected = true;
}, 15_000);

afterAll(async () => {
  try {
    if (connected) await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  } finally {
    await client.end();
  }
});

describe('PostgreSQL migration foundation', () => {
  it('applies an empty schema once and preserves tenant data on rerun', async () => {
    const first = await migrate(databaseUrl, migrationOptions);
    expect(first).toHaveLength(21);
    const inserted = await client.query(
      `INSERT INTO "${schema}".tenants (name) VALUES ($1) RETURNING id, active, created_at`,
      ['테스트 고객사'],
    );
    expect(inserted.rows[0].id).toMatch(/^[a-f0-9-]{36}$/);
    expect(inserted.rows[0].active).toBe(true);
    expect(inserted.rows[0].created_at).toBeInstanceOf(Date);

    const second = await migrate(databaseUrl, migrationOptions);
    expect(second).toHaveLength(0);
    const tenants = await client.query(`SELECT id, name FROM "${schema}".tenants`);
    expect(tenants.rows).toEqual([{ id: inserted.rows[0].id, name: '테스트 고객사' }]);
    const history = await client.query(`SELECT count(*)::int AS count FROM "${schema}".pgmigrations`);
    expect(history.rows[0].count).toBe(21);

    await expect(client.query(`INSERT INTO "${schema}".tenants (name) VALUES ('   ')`))
      .rejects.toMatchObject({ code: '23514' });
    await expect(client.query(`INSERT INTO "${schema}".tenants (name) VALUES (NULL)`))
      .rejects.toMatchObject({ code: '23502' });
  }, 30_000);
});
