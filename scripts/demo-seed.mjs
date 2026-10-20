/** Explicitly opted-in, synthetic-only P7 fixture. Does not alter development seeds. */
import { hashPassword } from 'better-auth/crypto';
import pg from 'pg';
import { roles, tenant, fixturePlan } from './demo-fixture.mjs';

const url = new URL(process.env.MIGRATION_DATABASE_URL ?? '');
if (process.env.WMS_DEMO_SEED !== 'synthetic-only' || !process.env.DEMO_DATABASE_NAME ||
    decodeURIComponent(url.pathname.slice(1)) !== process.env.DEMO_DATABASE_NAME ||
    !/(?:^|[_-])demo(?:$|[_-])/.test(process.env.DEMO_DATABASE_NAME)) {
  throw new Error('Explicit WMS_DEMO_SEED=synthetic-only and a matching, demo-named DEMO_DATABASE_NAME are required.');
}
const passwords = roles.map(role => process.env[`DEMO_${role.toUpperCase()}_PASSWORD`]);
if (passwords.some(password => !password || password.length < 16 || password.length > 128 || password === process.env.DEMO_PASSWORD) || new Set(passwords).size !== 3) {
  throw new Error('Three distinct DEMO_VIEWER_PASSWORD/DEMO_WORKER_PASSWORD/DEMO_ADMIN_PASSWORD values (16–128 characters), separate from DEMO_PASSWORD, are required.');
}
const client = new pg.Client({ connectionString: url.href });
async function assertFixture() {
  for (const [table, count] of [['items',3],['warehouses',1],['locations',2],['inventory_documents',6],['inventory_document_lines',6],['stock_ledger',6],['stock_balances',4],['audit_logs',5],['memberships',3]]) {
    const result = await client.query(`SELECT count(*)::int n FROM ${table} WHERE tenant_id=$1`, [tenant]);
    if (result.rows[0].n !== count) throw new Error('Fixture changed; refusing to overwrite demo activity.');
  }
  const mismatch = await client.query(`WITH ledger AS (SELECT location_id,item_id,sum(quantity_delta) quantity FROM stock_ledger WHERE tenant_id=$1 GROUP BY location_id,item_id)
    SELECT 1 FROM ledger l FULL JOIN (SELECT * FROM stock_balances WHERE tenant_id=$1) b USING(location_id,item_id)
    WHERE COALESCE(l.quantity,0)<>COALESCE(b.quantity,0) LIMIT 1`, [tenant]);
  if (mismatch.rowCount) throw new Error('Demo ledger/balance mismatch.');
  const invalidDocuments = await client.query(`
    WITH expected AS (
      SELECT d.id document_id,l.item_id,v.location_id,v.delta
      FROM inventory_documents d JOIN inventory_document_lines l ON l.document_id=d.id AND l.tenant_id=d.tenant_id
      CROSS JOIN LATERAL (VALUES(d.source_location_id,-l.quantity::bigint),(d.destination_location_id,l.quantity::bigint)) v(location_id,delta)
      WHERE d.tenant_id=$1 AND d.status='POSTED' AND v.location_id IS NOT NULL
    ), actual AS (SELECT document_id,item_id,location_id,quantity_delta delta FROM stock_ledger WHERE tenant_id=$1)
    SELECT 1 FROM expected e FULL JOIN actual a USING(document_id,item_id,location_id)
    WHERE e.delta IS DISTINCT FROM a.delta LIMIT 1`, [tenant]);
  if (invalidDocuments.rowCount) throw new Error('Demo posted document/ledger mismatch.');
  for (const role of roles) {
    const result = await client.query('SELECT m.role,m.tenant_id FROM "user" u JOIN memberships m ON m.user_id=u.id WHERE u.id=$1 AND u.email=$2', [`p7-demo-${role}`,`${role}@wms-demo.example.test`]);
    if (result.rowCount !== 1 || result.rows[0].role !== role || result.rows[0].tenant_id !== tenant) throw new Error('Demo identity ownership mismatch.');
    const credentials = await client.query('SELECT 1 FROM account WHERE "userId"=$1 AND "accountId"=$1 AND "providerId"=\'credential\' AND length(password)>0', [`p7-demo-${role}`]);
    if (credentials.rowCount !== 1) throw new Error('Demo credential account missing or ambiguous.');
  }
}
try {
  await client.connect();
  await client.query('BEGIN');
  await client.query("SELECT pg_advisory_xact_lock(hashtext('wms-p7-synthetic-demo'))");
  await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenant]);
  const existing = await client.query('SELECT name FROM tenants WHERE id=$1', [tenant]);
  if (existing.rowCount) {
    if (existing.rows[0].name !== 'WMS 합성 시연 고객사') throw new Error('Demo tenant ownership mismatch.');
    await assertFixture();
  } else {
    const hashes = await Promise.all(passwords.map(password => hashPassword(password)));
    for (const statement of fixturePlan(hashes)) await client.query(statement.text, statement.values);
    await assertFixture();
  }
  await client.query('COMMIT');
  console.log('P7 synthetic demo fixture verified; existing credentials and activity are never reset.');
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  console.error(`Demo seed failed (${error.code ?? error.name}); transaction rolled back. Check dedicated DB, fixture ownership, and migrations.`);
  process.exitCode = 1;
} finally { await client.end(); }
