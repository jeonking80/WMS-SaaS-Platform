/** Real PostgreSQL 17 test as a database owner with CREATEROLE, without superuser. */
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import pg from 'pg';
import { renderNeonInit } from './generate-neon-sql.mjs';
import { migrate } from './db-migrate.mjs';
import { renderDeliveryUpgrade } from './generate-neon-delivery-upgrade.mjs';
import { renderDestinationsUpgrade } from './generate-neon-destinations-upgrade.mjs';

const container = 'wms-neon-init-' + randomUUID().slice(0,8);
const password = randomUUID() + randomUUID();
const clients = [];
let created = false;
function docker(args, env) {
  const result = spawnSync('docker', args, { encoding:'utf8', env:env ?? process.env });
  if (result.status !== 0) throw new Error('Docker test command failed.');
  return result.stdout.trim();
}
async function connect(url) {
  const client = new pg.Client({ connectionString:url, connectionTimeoutMillis:2000 });
  await client.connect(); clients.push(client); return client;
}
try {
  const upgradeMode = process.argv.includes('--upgrade');
  const destinationsMode = process.argv.includes('--destinations-upgrade');
  const legacyMode = upgradeMode || destinationsMode;
  const sql = await renderNeonInit(upgradeMode ? {through:7} : destinationsMode ? {through:8} : {});
  if (!legacyMode) assert.equal(sql, await readFile(new URL('../deploy/neon-init.sql',import.meta.url),'utf8'));
  docker(['run','-d','--name',container,'--tmpfs','/var/lib/postgresql/data',
    '-e','POSTGRES_PASSWORD','-p','127.0.0.1::5432','postgres:17.9-bookworm'],
    {...process.env,POSTGRES_PASSWORD:password});
  created = true;
  const port = docker(['port',container,'5432/tcp']).split(':').at(-1);
  const base = new URL('postgresql://postgres@127.0.0.1:' + port + '/postgres');
  base.password = password;
  let admin;
  for (let attempt=0; attempt<60; attempt++) {
    try { admin = await connect(base.href); break; }
    catch { await delay(500); }
  }
  if (!admin) throw new Error('Temporary database did not become ready.');
  await admin.query('CREATE ROLE neondb_owner LOGIN CREATEROLE PASSWORD ' + pg.escapeLiteral(password));
  await admin.query('CREATE DATABASE wms_demo OWNER neondb_owner');
  const ownerUrl = new URL(base); ownerUrl.username='neondb_owner'; ownerUrl.pathname='/wms_demo';
  const owner = await connect(ownerUrl.href);
  assert.equal((await owner.query("SELECT rolsuper FROM pg_roles WHERE rolname=current_user")).rows[0].rolsuper,false);
  const result = await owner.query(sql);
  assert.deepEqual(result.at(-1).rows[0], {database_name:'wms_demo',migrations_applied:upgradeMode?'7':destinationsMode?'8':'9',tables_created:legacyMode?'16':'17',forced_rls_tables:legacyMode?'9':'10'});
  if (legacyMode) {
    await owner.query(`BEGIN; SET LOCAL ROLE wms_migrator;
      SELECT set_config('app.tenant_id','70000000-0000-4000-8000-000000000001',true);
      INSERT INTO tenants(id,name) VALUES('70000000-0000-4000-8000-000000000001','Legacy test company');
      INSERT INTO warehouses(id,tenant_id,code,name) VALUES('70000000-0000-4000-8000-000000000002','70000000-0000-4000-8000-000000000001','LEGACY','Legacy warehouse');
      INSERT INTO locations(id,tenant_id,warehouse_id,code,name) VALUES('70000000-0000-4000-8000-000000000003','70000000-0000-4000-8000-000000000001','70000000-0000-4000-8000-000000000002','A','Legacy location');
      INSERT INTO inventory_documents(id,tenant_id,kind,status,warehouse_id,source_location_id,note,posted_at)
        VALUES('70000000-0000-4000-8000-000000000004','70000000-0000-4000-8000-000000000001','OUTBOUND','POSTED','70000000-0000-4000-8000-000000000002','70000000-0000-4000-8000-000000000003','Preserve existing outbound',CURRENT_TIMESTAMP);
      COMMIT;`);
    if (destinationsMode) await owner.query(`BEGIN; SET LOCAL ROLE wms_migrator;
      SELECT set_config('app.tenant_id','70000000-0000-4000-8000-000000000001',true);
      UPDATE inventory_documents SET recipient_name='기존 거래처',delivery_address='서울특별시 중구 세종대로 110'; COMMIT;`);
    // Read as migrator with the same transaction-local tenant as the legacy row.
    const legacy = await owner.query(`BEGIN; SET LOCAL ROLE wms_migrator; SELECT set_config('app.tenant_id','70000000-0000-4000-8000-000000000001',true);
      SELECT to_jsonb(d) AS row FROM inventory_documents d; COMMIT;`);
    const original = legacy.find(entry=>entry.rows[0]?.row).rows[0].row;
    if (upgradeMode) {
      const upgrade = await renderDeliveryUpgrade();
      assert.equal(upgrade,await readFile(new URL('../deploy/neon-outbound-delivery.sql',import.meta.url),'utf8'));
      const applied = await owner.query(upgrade);
      assert.deepEqual(applied.at(-1).rows[0],{delivery_ready:true,delivery_columns:'2'});
      await owner.query(upgrade);
    }
    const destinationsUpgrade = await renderDestinationsUpgrade();
    assert.equal(destinationsUpgrade,await readFile(new URL('../deploy/neon-delivery-destinations.sql',import.meta.url),'utf8'));
    const applied = await owner.query(destinationsUpgrade);
    assert.deepEqual(applied.at(-1).rows[0],{address_book_ready:true,tenant_isolation_ready:true});
    const after = await owner.query(`BEGIN; SET LOCAL ROLE wms_migrator; SELECT set_config('app.tenant_id','70000000-0000-4000-8000-000000000001',true);
      SELECT to_jsonb(d)-'delivery_destination_id'${upgradeMode ? "-'recipient_name'-'delivery_address'" : ''} AS row FROM inventory_documents d; COMMIT;`);
    assert.deepEqual(after.find(entry=>entry.rows[0]?.row).rows[0].row,original);
    await owner.query(destinationsUpgrade);
    assert.equal((await owner.query('SELECT count(*)::int count FROM pgmigrations')).rows[0].count,9);
    const saved = await owner.query(`BEGIN; SET LOCAL ROLE wms_migrator; SELECT set_config('app.tenant_id','70000000-0000-4000-8000-000000000001',true);
      SELECT recipient_name,address_line1 FROM delivery_destinations; COMMIT;`);
    assert.deepEqual(saved.find(entry=>entry.command==='SELECT' && entry.fields[0]?.name==='recipient_name').rows,
      destinationsMode ? [{recipient_name:'기존 거래처',address_line1:'서울특별시 중구 세종대로 110'}] : []);
  }
  assert.equal((await migrate(ownerUrl.href,{log:()=>{}})).length,0);
  await assert.rejects(owner.query(sql), {code:'P0001'});
  await owner.query('ROLLBACK');
  await owner.query('ALTER ROLE wms_app LOGIN PASSWORD ' + pg.escapeLiteral(password));
  const appUrl = new URL(ownerUrl); appUrl.username='wms_app';
  const app = await connect(appUrl.href);
  const role = (await app.query("SELECT rolsuper,rolbypassrls,rolcreaterole,rolcreatedb FROM pg_roles WHERE rolname=current_user")).rows[0];
  assert.deepEqual(role,{rolsuper:false,rolbypassrls:false,rolcreaterole:false,rolcreatedb:false});
  assert.equal((await app.query('SELECT * FROM items')).rowCount,0);
  assert.equal((await app.query('SELECT * FROM delivery_destinations')).rowCount,0);
  await assert.rejects(app.query('DELETE FROM delivery_destinations'),{code:'42501'});
  await assert.rejects(app.query('ALTER TABLE delivery_destinations DISABLE ROW LEVEL SECURITY'),{code:'42501'});
  await assert.rejects(app.query('SELECT * FROM pgmigrations'),{code:'42501'});
  await assert.rejects(app.query('CREATE TABLE public.forbidden(id int)'),{code:'42501'});
  await assert.rejects(app.query('UPDATE stock_ledger SET quantity_delta=1'),{code:'42501'});
  await assert.rejects(app.query("UPDATE audit_logs SET action='CHANGED'"),{code:'42501'});
  await assert.rejects(app.query("UPDATE idempotency_requests SET response='{}'::jsonb"),{code:'42501'});
  await assert.rejects(app.query('DELETE FROM stock_balances'),{code:'42501'});
  console.log('PASS: limited-owner initialization; 9 tracked migrations; 17 tables; 10 FORCE RLS tables; migration rerun=0; overwrite refused; authenticated restricted app permissions.' + (legacyMode ? ' Legacy outbound unchanged; additive upgrades and repeat verified.' : '') + (destinationsMode ? ' Existing address reuse verified.' : ''));
} catch (error) {
  console.error('Neon SQL verification failed (' + (error.code ?? error.name) + ').');
  process.exitCode=1;
} finally {
  await Promise.all(clients.map(client=>client.end()));
  if (created) {
    try { docker(['rm','-f',container]); }
    catch { console.error('Remove only this test container after investigating: ' + container); process.exitCode=1; }
  }
}
