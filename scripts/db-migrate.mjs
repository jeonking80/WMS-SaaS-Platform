import { fileURLToPath } from 'node:url';
import { runner } from 'node-pg-migrate';

export async function migrate(databaseUrl, options = {}) {
  if (!databaseUrl) throw new Error('MIGRATION_DATABASE_URL is required.');
  return runner({
    databaseUrl,
    dir: fileURLToPath(new URL('../db/migrations', import.meta.url)),
    direction: 'up',
    migrationsTable: 'pgmigrations',
    checkOrder: true,
    singleTransaction: true,
    ...options,
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const applied = await migrate(process.env.MIGRATION_DATABASE_URL);
    console.log(`Applied ${applied.length} migration(s).`);
  } catch (error) {
    // Do not print driver messages: these can contain connection secrets.
    console.error(`Migration failed (${error.code ?? error.name}). Check MIGRATION_DATABASE_URL and DB availability.`);
    process.exitCode = 1;
  }
}
