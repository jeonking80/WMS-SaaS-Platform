/** Local disaster-recovery drill. Only creates/removes uniquely named databases owned by this run. */
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import pg from 'pg';
import { hashPassword, verifyPassword } from 'better-auth/crypto';
import { migrate } from './db-migrate.mjs';
import { context, backup, restore, safeFailure } from './backup-lib.mjs';

const token = randomUUID().replaceAll('-', '').slice(0, 16);
const source = `wms_restore_source_${token}`;
const target = `wms_restore_drill_${token}`;
const file = `backups/drill-${token}.dump`;
const owned = [];
let ctx, sourceClient, targetClient, app;
const tables = ['tenants','user','session','account','verification','memberships','items','warehouses','locations','inventory_documents','inventory_document_lines','stock_balances','stock_ledger','idempotency_requests','audit_logs','pgmigrations'];
async function fingerprint(client) {
  const counts = {}, hash = createHash('sha256');
  for (const table of tables) {
    const result = await client.query(`SELECT row_to_json(t)::text AS value FROM ${pg.escapeIdentifier(table)} t ORDER BY row_to_json(t)::text`);
    counts[table] = result.rowCount;
    hash.update(JSON.stringify([table, result.rows]));
  }
  return { counts, sha256: hash.digest('hex') };
}
async function connect(url, database) {
  const binding = new URL(url); binding.pathname = `/${database}`;
  const client = new pg.Client({ connectionString: binding.href }); await client.connect(); return client;
}
try {
  ctx = await context();
  assert(process.env.DATABASE_URL, 'DATABASE_URL required for actual application-role authentication.');
  const appBinding = new URL(process.env.DATABASE_URL);
  assert.equal(appBinding.hostname,ctx.url.hostname,'Application and administrator must use the same host.');
  assert.equal(appBinding.port,ctx.url.port,'Application and administrator must use the same port.');
  assert.equal(decodeURIComponent(appBinding.username),'wms_app');
  await ctx.client.query(`CREATE DATABASE ${pg.escapeIdentifier(source)} TEMPLATE template0`); owned.push(source);
  const sourceUrl = new URL(ctx.url); sourceUrl.pathname = `/${source}`;
  await migrate(sourceUrl.href, { log: () => {} });
  sourceClient = await connect(ctx.url, source);
  await sourceClient.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC; GRANT USAGE ON SCHEMA public TO wms_app');
  await sourceClient.query('GRANT SELECT,INSERT,UPDATE,DELETE ON public."user",session,account,verification TO wms_app');
  await sourceClient.query('GRANT SELECT,INSERT,UPDATE,DELETE ON items,warehouses,locations,inventory_documents,inventory_document_lines TO wms_app');
  await sourceClient.query('GRANT SELECT,INSERT,UPDATE ON stock_balances TO wms_app; GRANT SELECT,INSERT ON stock_ledger,audit_logs,idempotency_requests TO wms_app; GRANT SELECT ON tenants,memberships TO wms_app');
  const tenant = randomUUID(), foreign = randomUUID(), warehouse = randomUUID(), location = randomUUID(), item = randomUUID();
  await sourceClient.query('INSERT INTO tenants(id,name) VALUES($1,\'Restore synthetic A\'),($2,\'Restore synthetic B\')', [tenant,foreign]);
  const user = `restore-${token}`, credential = randomUUID()+randomUUID(), sessionToken = randomUUID()+randomUUID();
  await sourceClient.query(`INSERT INTO "user"(id,name,email) VALUES($1,'Restore synthetic user',$2)`,[user,`${user}@example.test`]);
  await sourceClient.query(`INSERT INTO account(id,"accountId","providerId","userId",password) VALUES($1,$2,'credential',$2,$3)`,[randomUUID(),user,await hashPassword(credential)]);
  // Expired session and verification records exercise recovery without creating a usable login session.
  await sourceClient.query(`INSERT INTO session(id,"expiresAt",token,"userId") VALUES($1,CURRENT_TIMESTAMP - interval '1 day',$2,$3)`,[randomUUID(),sessionToken,user]);
  await sourceClient.query(`INSERT INTO verification(id,identifier,value,"expiresAt") VALUES($1,$2,$3,CURRENT_TIMESTAMP - interval '1 day')`,[randomUUID(),`${user}@example.test`,randomUUID()]);
  await sourceClient.query("INSERT INTO memberships(user_id,tenant_id,role) VALUES($1,$2,'admin')",[user,tenant]);
  await sourceClient.query("INSERT INTO warehouses(id,tenant_id,code,name) VALUES($1,$2,'RESTORE','Restore warehouse')",[warehouse,tenant]);
  await sourceClient.query("INSERT INTO locations(id,tenant_id,warehouse_id,code,name) VALUES($1,$2,$3,'RESTORE','Restore location')",[location,tenant,warehouse]);
  await sourceClient.query("INSERT INTO items(id,tenant_id,code,name) VALUES($1,$2,'RESTORE','Restore item')",[item,tenant]);
  for (const [kind,quantity] of [['INBOUND',100],['OUTBOUND',-30]]) {
    const document = randomUUID();
    await sourceClient.query(`INSERT INTO inventory_documents(id,tenant_id,kind,status,warehouse_id,source_location_id,destination_location_id,posted_at) VALUES($1,$2,$3,'POSTED',$4,$5,$6,CURRENT_TIMESTAMP)`,[document,tenant,kind,warehouse,quantity<0?location:null,quantity>0?location:null]);
    await sourceClient.query('INSERT INTO inventory_document_lines(tenant_id,document_id,item_id,quantity) VALUES($1,$2,$3,$4)',[tenant,document,item,Math.abs(quantity)]);
    await sourceClient.query('INSERT INTO stock_ledger(tenant_id,document_id,warehouse_id,location_id,item_id,quantity_delta) VALUES($1,$2,$3,$4,$5,$6)',[tenant,document,warehouse,location,item,quantity]);
    await sourceClient.query('INSERT INTO audit_logs(tenant_id,document_id,actor_id,action) VALUES($1,$2,$3,$4)',[tenant,document,user,`POST_${kind}`]);
    await sourceClient.query('INSERT INTO idempotency_requests(tenant_id,key,request_hash,response) VALUES($1,$2,$3,$4::jsonb)',[tenant,`restore-${document}`,createHash('sha256').update(JSON.stringify({document,kind,quantity})).digest('hex'),JSON.stringify({document:{id:document,status:'POSTED',kind},status:200})]);
  }
  await sourceClient.query('INSERT INTO stock_balances(tenant_id,warehouse_id,location_id,item_id,quantity) VALUES($1,$2,$3,$4,70)',[tenant,warehouse,location,item]);
  const before = await fingerprint(sourceClient);
  for (const table of ['user','account','session','verification','memberships']) assert.equal(before.counts[table],1);
  for (const table of ['audit_logs','idempotency_requests']) assert.equal(before.counts[table],2);
  const sourceCtx = { ...ctx, database: source };
  const archive = await backup(sourceCtx,file);
  await restore(sourceCtx,file,target); owned.push(target);
  // Explicitly exercise overwrite refusal without touching any target data.
  await assert.rejects(restore(sourceCtx,file,target), { code: '42P04' });
  await assert.rejects(restore(sourceCtx,file,source));
  await assert.rejects(backup(sourceCtx,file), { code: 'EEXIST' });
  targetClient = await connect(ctx.url,target);
  assert.deepEqual(await fingerprint(targetClient),before);
  const security = await targetClient.query("SELECT relname FROM pg_class WHERE relnamespace='public'::regnamespace AND relrowsecurity AND relforcerowsecurity ORDER BY relname");
  assert.deepEqual(security.rows.map(row => row.relname),['audit_logs','idempotency_requests','inventory_document_lines','inventory_documents','items','locations','stock_balances','stock_ledger','warehouses']);
  const reconciliation = await targetClient.query(`SELECT COUNT(*)::int AS mismatches FROM stock_balances b FULL JOIN (SELECT tenant_id,warehouse_id,location_id,item_id,SUM(quantity_delta) quantity FROM stock_ledger GROUP BY 1,2,3,4) l USING(tenant_id,warehouse_id,location_id,item_id) WHERE COALESCE(b.quantity,0)<>COALESCE(l.quantity,0)`);
  assert.equal(reconciliation.rows[0].mismatches,0);
  app = await connect(process.env.DATABASE_URL,target);
  const role = (await app.query(`SELECT current_user name,rolsuper,rolbypassrls,EXISTS(SELECT 1 FROM pg_class WHERE relnamespace='public'::regnamespace AND relowner=pg_roles.oid AND relkind IN ('r','p')) owns_tables FROM pg_roles WHERE rolname=current_user`)).rows[0];
  const restoredCredential = await app.query('SELECT password FROM account WHERE "userId"=$1',[user]);
  assert(await verifyPassword({hash:restoredCredential.rows[0].password,password:credential}));
  assert.equal((await app.query('SELECT role FROM memberships WHERE user_id=$1',[user])).rows[0].role,'admin');
  assert.equal((await app.query('SELECT token FROM session WHERE "userId"=$1',[user])).rows[0].token,sessionToken);
  assert.deepEqual(role,{name:'wms_app',rolsuper:false,rolbypassrls:false,owns_tables:false});
  assert.equal((await app.query('SELECT * FROM stock_balances')).rowCount,0);
  await app.query("SELECT set_config('app.tenant_id',$1,false)",[tenant]);
  assert.equal((await app.query('SELECT quantity FROM stock_balances')).rows[0].quantity,'70');
  assert.equal((await app.query('SELECT * FROM stock_ledger')).rowCount,2);
  await assert.rejects(app.query('UPDATE stock_ledger SET quantity_delta=1'), {code:'42501'});
  assert.equal((await app.query('SELECT * FROM audit_logs')).rowCount,2);
  assert.equal((await app.query('SELECT * FROM idempotency_requests')).rowCount,2);
  await assert.rejects(app.query("UPDATE audit_logs SET action='CHANGED'"), {code:'42501'});
  await assert.rejects(app.query("UPDATE idempotency_requests SET response='{}'::jsonb"), {code:'42501'});
  await assert.rejects(app.query('DELETE FROM stock_balances'), {code:'42501'});
  await assert.rejects(app.query('CREATE TABLE public.forbidden_restore(id int)'), {code:'42501'});
  await app.query("SELECT set_config('app.tenant_id',$1,false)",[foreign]);
  assert.equal((await app.query('SELECT * FROM stock_balances')).rowCount,0);
  assert.equal((await app.query('UPDATE stock_balances SET quantity=0 RETURNING *')).rowCount,0);
  assert.equal((await app.query('SELECT * FROM audit_logs')).rowCount,0);
  assert.equal((await app.query('SELECT * FROM idempotency_requests')).rowCount,0);
  await assert.rejects(app.query("INSERT INTO items(tenant_id,code,name) VALUES($1,'CROSS-TENANT','Forbidden')",[tenant]), {code:'42501'});
  assert.deepEqual(await fingerprint(sourceClient),before);
  console.log(JSON.stringify({result:'PASS',archive_bytes:archive.bytes,fixture:{tenants:2,users:1,accounts:1,expired_sessions:1,expired_verifications:1,memberships:1,documents:2,ledger_entries:2,audit_entries:2,idempotency_responses:2,balance:70},row_counts:before.counts,source_sha256:before.sha256,restored_identical:true,source_unchanged:true,forced_rls_tables:security.rowCount,reconciliation_mismatches:0,application_role:'authenticated wms_app; nonowner/nonsuperuser/no BYPASSRLS',checks:['restored credential hash verifies; expired session and membership preserved','tenant isolation and cross-tenant write refusal','ledger/audit/idempotency updates denied','balance delete denied','schema create denied','existing target refused','source target refused','archive overwrite refused']},null,2));
} catch(error) { safeFailure('Restore verification',error); }
finally {
  await Promise.all([app?.end(),sourceClient?.end(),targetClient?.end()]);
  if(ctx) {
    for(const name of owned.reverse()) await ctx.client.query(`DROP DATABASE ${pg.escapeIdentifier(name)}`).catch(()=>{console.error('Drill cleanup failed; remove only this run’s isolated databases after investigation.');process.exitCode=1;});
    await ctx.client.end();
  }
  await unlink(file).catch(()=>{});
}
