import pg from 'pg';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is required.');
  process.exitCode = 1;
} else {
  const client = new pg.Client({ connectionString, connectionTimeoutMillis: 5000 });
  try {
    await client.connect();
    const role = await client.query(`SELECT current_user AS name, r.rolsuper, r.rolbypassrls,
      EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
              WHERE n.nspname='public' AND c.relowner=r.oid AND c.relkind IN ('r','p')) AS owns_tables
      FROM pg_roles r WHERE r.rolname=current_user`);
    if (role.rows[0].name !== 'wms_app' || role.rows[0].rolsuper || role.rows[0].rolbypassrls || role.rows[0].owns_tables) {
      throw new Error('Application role must be nonowner, nonsuperuser without BYPASSRLS.');
    }
    const result = await client.query('SELECT current_database() AS database, current_setting(\'server_version\') AS version');
    console.log(`PostgreSQL ${result.rows[0].version}: ${result.rows[0].database} connection OK.`);
    console.log('Restricted wms_app role verified (nonowner, nonsuperuser, no BYPASSRLS).');
  } catch (error) {
    console.error(`DB connection failed (${error.code ?? error.name}). Check DATABASE_URL and DB availability.`);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}
