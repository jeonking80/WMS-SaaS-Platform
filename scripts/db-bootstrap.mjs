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
  const tables = ['pgmigrations', 'tenants', 'user', 'session', 'account', 'verification', 'rateLimit', 'memberships', 'items', 'warehouses', 'locations', 'inventory_documents', 'inventory_document_lines', 'stock_balances', 'stock_ledger', 'idempotency_requests', 'audit_logs', 'delivery_destinations'];
  const v2Mutable = ['v2_workflow_state','v2_workflow_state_header','v2_workflow_stock','v2_workflow_objects','v2_identity_links','v2_machine_keys','business_partners','master_barcodes','master_csv_previews','v2_integration_limits','v2_integration_entities','v2_integration_events'];
  const v2AppendOnly = ['v2_workflow_requests','v2_workflow_performances','v2_workflow_receivings','v2_workflow_ledger','v2_identity_audit','master_csv_applies','master_csv_applied_rows','v2_cutovers','api_request_metrics','v2_opening_imports'];
  const v2Grants = ['v2_warehouse_grants','v2_machine_warehouses','v2_workflow_object_state'];
  tables.push(...v2Mutable,...v2AppendOnly,...v2Grants);
  for (const table of tables) {
    const exists = await client.query('SELECT to_regclass($1) AS relation', [`public.${quote(table)}`]);
    if (exists.rows[0].relation) {
      await client.query(`ALTER TABLE public.${quote(table)} OWNER TO wms_migrator`);
      await client.query(`REVOKE ALL ON TABLE public.${quote(table)} FROM wms_app, PUBLIC`);
    }
  }
  if (process.argv.includes('--grant')) {
    for(const signature of ['master_workflow_in_use(uuid,text,uuid)','master_workflow_in_use_scoped(uuid,text,uuid)','master_active_guard()','master_barcode_immutable()']) {
      await client.query(`ALTER FUNCTION public.${signature} OWNER TO wms_migrator`);
    }
    await client.query('GRANT SELECT,INSERT,UPDATE,DELETE ON public."rateLimit" TO wms_app');
    await client.query('REVOKE ALL ON FUNCTION public.master_workflow_in_use(uuid,text,uuid),public.master_workflow_in_use_scoped(uuid,text,uuid),public.master_active_guard(),public.master_barcode_immutable() FROM PUBLIC');
    await client.query('GRANT EXECUTE ON FUNCTION public.master_workflow_in_use(uuid,text,uuid) TO wms_app');
    await client.query('GRANT SELECT, INSERT, UPDATE ON public.delivery_destinations TO wms_app');
    await client.query('GRANT SELECT, INSERT, UPDATE, DELETE ON public."user", public.session, public.account, public.verification, public.items, public.warehouses, public.locations, public.inventory_documents, public.inventory_document_lines TO wms_app');
    await client.query('GRANT SELECT, INSERT, UPDATE ON public.stock_balances TO wms_app');
    await client.query('GRANT SELECT, INSERT ON public.stock_ledger, public.idempotency_requests, public.audit_logs TO wms_app');
    await client.query('GRANT SELECT ON public.tenants, public.memberships TO wms_app');
    await client.query('GRANT UPDATE(idle_lock_minutes) ON public.tenants TO wms_app');
    await client.query('GRANT INSERT(user_id,tenant_id,role,status),UPDATE(role,status,updated_at) ON public.memberships TO wms_app');
    for(const [names,permissions] of [[v2Mutable,'SELECT,INSERT,UPDATE'],[v2AppendOnly,'SELECT,INSERT'],[v2Grants,'SELECT,INSERT,UPDATE,DELETE']]) {
      for(const table of names) await client.query(`GRANT ${permissions} ON public.${quote(table)} TO wms_app`);
    }
    await client.query('GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO wms_app');
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
