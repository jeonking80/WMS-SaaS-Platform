import pg from 'pg';

if (process.env.NODE_ENV === 'production') {
  throw new Error('The development seed cannot run in production.');
}
if (!process.env.MIGRATION_DATABASE_URL) {
  throw new Error('MIGRATION_DATABASE_URL is required.');
}

const client = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
try {
  await client.connect();
  // Fixed synthetic identities make reruns safe without changing existing names.
  await client.query(`
    INSERT INTO tenants (id, name) VALUES
      ('00000000-0000-4000-8000-000000000001', '데모 고객사 A'),
      ('00000000-0000-4000-8000-000000000002', '데모 고객사 B')
    ON CONFLICT (id) DO NOTHING
  `);
  console.log('Development tenant seed complete. No accounts or inventory created.');
} catch (error) {
  console.error(`Development seed failed (${error.code ?? error.name}). Check migrations and DB availability.`);
  process.exitCode = 1;
} finally {
  await client.end();
}
