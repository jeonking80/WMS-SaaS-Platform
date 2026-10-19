import pg from 'pg';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is required.');
  process.exitCode = 1;
} else {
  const client = new pg.Client({ connectionString, connectionTimeoutMillis: 5000 });
  try {
    await client.connect();
    const result = await client.query('SELECT current_database() AS database, current_setting(\'server_version\') AS version');
    console.log(`PostgreSQL ${result.rows[0].version}: ${result.rows[0].database} connection OK.`);
  } catch (error) {
    console.error(`DB connection failed (${error.code ?? error.name}). Check DATABASE_URL and DB availability.`);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}
