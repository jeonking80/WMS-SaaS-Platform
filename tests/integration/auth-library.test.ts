import { randomBytes } from 'node:crypto';
import { betterAuth } from 'better-auth';
import { getMigrations } from 'better-auth/db/migration';
import { admin } from 'better-auth/plugins/admin';
import pg from 'pg';
import { expect, it } from 'vitest';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) {
  throw new Error('TEST_DATABASE_URL is required for authentication library integration tests.');
}
const databaseName = decodeURIComponent(new URL(databaseUrl).pathname.slice(1));
if (!databaseName.endsWith('_test')) {
  throw new Error('Integration tests require a dedicated database whose name ends in _test.');
}

// P0 library compatibility only: this does not implement or validate the app's
// Next.js auth routes, tenant authorization, or production security settings.
it('validates Better Auth library compatibility in an isolated PostgreSQL schema', async () => {
  const schema = `auth_probe_${randomBytes(16).toString('hex')}`;
  const control = new pg.Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 5000 });
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 5000,
    options: `-c search_path=${schema}`,
  });
  let schemaCreated = false;

  try {
    await control.query(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    const config = {
      database: pool,
      secret: randomBytes(48).toString('hex'),
      baseURL: 'http://localhost:3000',
      emailAndPassword: { enabled: true, disableSignUp: true },
      plugins: [admin()],
      telemetry: { enabled: false },
    };
    const migration = await getMigrations(config);
    await migration.runMigrations();

    const auth = betterAuth(config);
    const password = randomBytes(32).toString('hex');
    const email = 'probe@example.invalid';
    const { user } = await auth.api.createUser({
      body: { name: 'Probe', email, password, role: 'admin' },
    });
    expect(Boolean(user.id)).toBe(true);

    const request = (path: string, body?: Record<string, unknown>, cookie?: string) =>
      new Request(`http://localhost:3000/api/auth${path}`, {
        method: body ? 'POST' : 'GET',
        headers: {
          ...(body ? { 'content-type': 'application/json', origin: 'http://localhost:3000' } : {}),
          ...(cookie ? { cookie } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });

    const login = await auth.handler(request('/sign-in/email', { email, password }));
    expect(login.status).toBe(200);
    const cookies = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    // Assert booleans rather than secret-bearing headers or response objects.
    expect(cookies.length > 0).toBe(true);

    const sessionResponse = await auth.handler(request('/get-session', undefined, cookies));
    expect(sessionResponse.status).toBe(200);
    const session = await sessionResponse.json();
    expect(session.user.id === user.id).toBe(true);
    expect(Boolean(session.session.id)).toBe(true);

    const signup = await auth.handler(request('/sign-up/email', {
      email: 'other@example.invalid', password, name: 'Other',
    }));
    expect(signup.status).toBe(400);

    const remoteCreate = await auth.handler(request('/admin/create-user', {
      email: 'other@example.invalid', password, name: 'Other',
    }));
    expect(remoteCreate.status).toBe(401);

    const logout = await auth.handler(request('/sign-out', {}, cookies));
    expect(logout.status).toBe(200);
    const afterLogout = await auth.handler(request('/get-session', undefined, cookies));
    expect((await afterLogout.json()) === null).toBe(true);

    const tables = await control.query(
      'SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name',
      [schema],
    );
    expect(tables.rows.map(row => row.table_name)).toEqual(['account', 'session', 'user', 'verification']);
  } finally {
    try {
      await pool.end();
    } finally {
      try {
        if (schemaCreated) {
          await control.query(`DROP SCHEMA "${schema}" CASCADE`);
          const remaining = await control.query(
            'SELECT schema_name FROM information_schema.schemata WHERE schema_name = $1',
            [schema],
          );
          expect(remaining.rowCount).toBe(0);
        }
      } finally {
        await control.end();
      }
    }
  }
});
