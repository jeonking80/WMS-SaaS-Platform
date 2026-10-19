import { randomUUID } from 'node:crypto';
import { hashPassword } from 'better-auth/crypto';
import pg from 'pg';

if (process.env.NODE_ENV === 'production') {
  throw new Error('The development auth seed cannot run in production.');
}
if (!process.env.MIGRATION_DATABASE_URL) throw new Error('MIGRATION_DATABASE_URL is required.');
const password = process.env.DEMO_PASSWORD;
if (!password || password.length < 12 || password.length > 128) {
  throw new Error('DEMO_PASSWORD must contain between 12 and 128 characters.');
}

const client = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
try {
  await client.connect();
  await client.query('BEGIN');
  // Serializes reruns; no passwords or existing tenant assignments are reset.
  await client.query("SELECT pg_advisory_xact_lock(hashtext('wms-development-auth-seed'))");
  for (const [company, tenantId] of [
    ['a', '00000000-0000-4000-8000-000000000001'],
    ['b', '00000000-0000-4000-8000-000000000002'],
  ]) {
    for (const role of ['admin', 'worker', 'viewer']) {
      const email = `${role}.${company}@example.test`;
      const existing = await client.query('SELECT id FROM "user" WHERE email = $1', [email]);
      if (existing.rowCount) {
        const membership = await client.query(
          'SELECT tenant_id, role FROM memberships WHERE user_id = $1', [existing.rows[0].id],
        );
        if (membership.rows[0]?.tenant_id !== tenantId || membership.rows[0]?.role !== role) {
          throw new Error('Existing demo identity has an unexpected membership; refusing reassignment.');
        }
        continue;
      }
      const userId = randomUUID();
      const hashedPassword = await hashPassword(password);
      await client.query(
        'INSERT INTO "user" (id, name, email, "emailVerified") VALUES ($1, $2, $3, false)',
        [userId, `데모 ${company.toUpperCase()} ${role}`, email],
      );
      await client.query(
        'INSERT INTO account (id, "accountId", "providerId", "userId", password) VALUES ($1, $2, $3, $2, $4)',
        [randomUUID(), userId, 'credential', hashedPassword],
      );
      await client.query(
        'INSERT INTO memberships (user_id, tenant_id, role) VALUES ($1, $2, $3)',
        [userId, tenantId, role],
      );
    }
  }
  await client.query('COMMIT');
  console.log('Development auth seed complete (6 identities across tenants A and B). Existing passwords preserved.');
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  console.error(`Development auth seed failed (${error.code ?? error.name}). Check migrations, tenant seed, and existing memberships.`);
  process.exitCode = 1;
} finally {
  await client.end();
}
