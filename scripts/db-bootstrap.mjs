import pg from 'pg';

// Run once with a database administrator, then migrate, then rerun with --grant.
// Passwords are read only from bindings and never logged or saved to files.
const required = ['BOOTSTRAP_DATABASE_URL', 'MIGRATION_DATABASE_URL', 'DATABASE_URL'];
for (const name of required) {
  if (!process.env[name]) throw new Error(`${name} is required.`);
}
const adminUrl = new URL(process.env.BOOTSTRAP_DATABASE_URL);
const migratorUrl = new URL(process.env.MIGRATION_DATABASE_URL);
const appUrl = new URL(process.env.DATABASE_URL);
for (const [url, expected] of [[migratorUrl, 'wms_migrator'], [appUrl, 'wms_app']]) {
  if (decodeURIComponent(url.username) !== expected || !url.password) {
    throw new Error(`A password-bearing ${expected} binding is required.`);
  }
  if (url.hostname !== adminUrl.hostname || url.port !== adminUrl.port || url.pathname !== adminUrl.pathname) {
    throw new Error('Bootstrap, migration and application bindings must target the same database.');
  }
}
const client = new pg.Client({ connectionString: process.env.BOOTSTRAP_DATABASE_URL });
const quote = pg.escapeIdentifier;
try {
  await client.connect();
  await client.query('BEGIN');
  for (const [url, role] of [[migratorUrl, 'wms_migrator'], [appUrl, 'wms_app']]) {
    const exists = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
    if (!exists.rowCount) await client.query(`CREATE ROLE ${quote(role)}`);
    await client.query(`ALTER ROLE ${quote(role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD ${pg.escapeLiteral(decodeURIComponent(url.password))}`);
    const memberships = await client.query(`SELECT parent.rolname FROM pg_auth_members m
      JOIN pg_roles parent ON parent.oid = m.roleid JOIN pg_roles member ON member.oid = m.member
      WHERE member.rolname = $1`, [role]);
    for (const membership of memberships.rows) {
      await client.query(`REVOKE ${quote(membership.rolname)} FROM ${quote(role)}`);
    }
  }
  const db = decodeURIComponent(adminUrl.pathname.slice(1));
  await client.query(`GRANT CONNECT ON DATABASE ${quote(db)} TO wms_migrator, wms_app`);
  await client.query('ALTER SCHEMA public OWNER TO wms_migrator');
  await client.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
  await client.query('REVOKE CREATE ON SCHEMA public FROM wms_app');
  await client.query('GRANT USAGE ON SCHEMA public TO wms_app');
  // Restrict ownership changes to this application's known tables, preserving other data.
  const tables = ['pgmigrations', 'tenants', 'user', 'session', 'account', 'verification', 'memberships', 'items', 'warehouses', 'locations', 'inventory_documents', 'inventory_document_lines', 'stock_balances', 'stock_ledger', 'idempotency_requests', 'audit_logs', 'delivery_destinations'];
  for (const table of tables) {
    const exists = await client.query('SELECT to_regclass($1) AS relation', [`public.${quote(table)}`]);
    if (exists.rows[0].relation) {
      await client.query(`ALTER TABLE public.${quote(table)} OWNER TO wms_migrator`);
      await client.query(`REVOKE ALL ON TABLE public.${quote(table)} FROM wms_app, PUBLIC`);
    }
  }
  if (process.argv.includes('--grant')) {
    await client.query('GRANT SELECT, INSERT, UPDATE ON public.delivery_destinations TO wms_app');
    await client.query('GRANT SELECT, INSERT, UPDATE, DELETE ON public."user", public.session, public.account, public.verification, public.items, public.warehouses, public.locations, public.inventory_documents, public.inventory_document_lines TO wms_app');
    await client.query('GRANT SELECT, INSERT, UPDATE ON public.stock_balances TO wms_app');
    await client.query('GRANT SELECT, INSERT ON public.stock_ledger, public.idempotency_requests, public.audit_logs TO wms_app');
    await client.query('GRANT SELECT ON public.tenants, public.memberships TO wms_app');
  }
  await client.query('COMMIT');
  console.log(process.argv.includes('--grant') ? 'Database roles and application grants configured.' : 'Database roles configured. Run migrations, then db:bootstrap -- --grant.');
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  console.error(`Database bootstrap failed (${error.code ?? error.name}). Check bindings and administrator privileges.`);
  process.exitCode = 1;
} finally {
  await client.end();
}
