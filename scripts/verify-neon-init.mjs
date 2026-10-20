/** Real PostgreSQL 17 test as a database owner with CREATEROLE, without superuser. */
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import pg from 'pg';
import { renderNeonInit } from './generate-neon-sql.mjs';
import { migrate } from './db-migrate.mjs';

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
  const sql = await renderNeonInit();
  assert.equal(sql, await readFile(new URL('../deploy/neon-init.sql',import.meta.url),'utf8'));
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
  assert.deepEqual(result.at(-1).rows[0], {database_name:'wms_demo',migrations_applied:'7',tables_created:'16',forced_rls_tables:'9'});
  assert.equal((await migrate(ownerUrl.href,{log:()=>{}})).length,0);
  await assert.rejects(owner.query(sql), {code:'P0001'});
  await owner.query('ROLLBACK');
  await owner.query('ALTER ROLE wms_app LOGIN PASSWORD ' + pg.escapeLiteral(password));
  const appUrl = new URL(ownerUrl); appUrl.username='wms_app';
  const app = await connect(appUrl.href);
  const role = (await app.query("SELECT rolsuper,rolbypassrls,rolcreaterole,rolcreatedb FROM pg_roles WHERE rolname=current_user")).rows[0];
  assert.deepEqual(role,{rolsuper:false,rolbypassrls:false,rolcreaterole:false,rolcreatedb:false});
  assert.equal((await app.query('SELECT * FROM items')).rowCount,0);
  await assert.rejects(app.query('SELECT * FROM pgmigrations'),{code:'42501'});
  await assert.rejects(app.query('CREATE TABLE public.forbidden(id int)'),{code:'42501'});
  await assert.rejects(app.query('UPDATE stock_ledger SET quantity_delta=1'),{code:'42501'});
  await assert.rejects(app.query("UPDATE audit_logs SET action='CHANGED'"),{code:'42501'});
  await assert.rejects(app.query("UPDATE idempotency_requests SET response='{}'::jsonb"),{code:'42501'});
  await assert.rejects(app.query('DELETE FROM stock_balances'),{code:'42501'});
  console.log('PASS: limited-owner initialization; 7 tracked migrations; 16 tables; 9 FORCE RLS tables; migration rerun=0; overwrite refused; authenticated restricted app permissions.');
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
