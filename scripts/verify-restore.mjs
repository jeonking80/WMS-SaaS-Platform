/** Local disaster-recovery drill. Only creates/removes uniquely named databases owned by this run. */
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { unlink, readdir, writeFile } from 'node:fs/promises';
import pg from 'pg';
import { hashPassword, verifyPassword } from 'better-auth/crypto';
import { migrate } from './db-migrate.mjs';
import { context, backup, restore, safeFailure } from './backup-lib.mjs';
import { v2Tables, v2Views, seedV2RestoreFixture, reconcileV2Restore } from './restore-v2-fixture.mjs';

const token = randomUUID().replaceAll('-', '').slice(0, 16);
const source = `wms_restore_source_${token}`;
const target = `wms_restore_drill_${token}`;
const file = `backups/drill-${token}.dump`;
const owned = [];
let ctx, sourceClient, targetClient, app;
const tables = ['tenants','user','session','account','verification','rateLimit','memberships','items','warehouses','locations','inventory_documents','inventory_document_lines','stock_balances','stock_ledger','idempotency_requests','audit_logs','delivery_destinations','pgmigrations',...v2Tables];
const nonRlsTables = new Set(['tenants','user','session','account','verification','rateLimit','memberships','pgmigrations']);
const rlsTables = tables.filter(table => !nonRlsTables.has(table)).sort();
const migrationFiles = (await readdir(new URL('../db/migrations/', import.meta.url))).filter(file => /^\d+_.+\.sql$/.test(file));
async function fingerprint(client) {
  const actualTables = (await client.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows.map(row => row.tablename);
  assert.deepEqual(actualTables, [...tables].sort(), 'Every public application table must be fingerprinted.');
  const views = (await client.query("SELECT relname,reloptions FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='v' ORDER BY relname")).rows;
  assert.deepEqual(views.map(row=>row.relname),v2Views);
  for(const view of views)assert(view.reloptions?.includes('security_invoker=true'),'Compatibility view must retain invoker security.');
  const counts = {}, hash = createHash('sha256');
  for (const table of tables) {
    const result = await client.query(`SELECT row_to_json(t)::text AS value FROM ${pg.escapeIdentifier(table)} t ORDER BY row_to_json(t)::text`);
    counts[table] = result.rowCount;
    hash.update(JSON.stringify([table, result.rows]));
  }
  const sequences = {};
  for (const { sequencename } of (await client.query("SELECT sequencename FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename")).rows) {
    sequences[sequencename] = (await client.query(`SELECT last_value::text,is_called FROM public.${pg.escapeIdentifier(sequencename)}`)).rows[0];
  }
  const logicalState=(await client.query('SELECT tenant_id,warehouse_id,version,state,updated_at FROM v2_workflow_state ORDER BY tenant_id,warehouse_id')).rows;
  hash.update(JSON.stringify([sequences,logicalState,views]));
  return { counts, sequences, logical_state_rows:logicalState.length, sha256: hash.digest('hex') };
}
async function verifyNormalizedState(client, {tenant,warehouse,state}) {
  const scope=[tenant,warehouse];
  const logical=(await client.query('SELECT version,state FROM v2_workflow_state WHERE tenant_id=$1 AND warehouse_id=$2',scope)).rows;
  assert.deepEqual(logical,[{version:1,state}],'Reconstructed state must preserve every object, primitive, empty array and metadata field.');
  const metadata=Object.fromEntries(Object.entries(state).map(([key,value])=>[key,Array.isArray(value)?[]:value]));
  assert.deepEqual((await client.query('SELECT version,state,storage_format FROM v2_workflow_state_header WHERE tenant_id=$1 AND warehouse_id=$2',scope)).rows,[{version:1,state:metadata,storage_format:2}]);
  const bodies=(await client.query('SELECT kind,position,body,changed_version FROM v2_workflow_object_state WHERE tenant_id=$1 AND warehouse_id=$2 ORDER BY kind COLLATE "C",position',scope)).rows;
  const expected=Object.entries(state).filter(([,value])=>Array.isArray(value)).sort(([a],[b])=>a<b?-1:a>b?1:0).flatMap(([kind,values])=>values.map((body,position)=>({kind,position,body,changed_version:1})));
  assert.deepEqual(bodies,expected,'Normalized body rows must preserve array ordering and changed versions.');
  return {storage_format:2,header_rows:logical.length,body_rows:bodies.length,logical_state_identical:true};
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
  await sourceClient.query('GRANT SELECT,INSERT,UPDATE,DELETE ON public."user",session,account,verification,"rateLimit" TO wms_app');
  await sourceClient.query('GRANT SELECT,INSERT,UPDATE,DELETE ON items,warehouses,locations,inventory_documents,inventory_document_lines TO wms_app');
  await sourceClient.query('GRANT SELECT,INSERT,UPDATE ON stock_balances TO wms_app; GRANT SELECT,INSERT ON stock_ledger,audit_logs,idempotency_requests TO wms_app; GRANT SELECT ON tenants,memberships TO wms_app');
  await sourceClient.query('GRANT SELECT,INSERT,UPDATE ON delivery_destinations TO wms_app');
  const mutable = ['v2_workflow_state','v2_workflow_state_header','v2_workflow_stock','v2_workflow_objects','v2_identity_links','v2_machine_keys','business_partners','master_barcodes','master_csv_previews','v2_integration_limits','v2_integration_entities','v2_integration_events'];
  const appendOnly = ['v2_workflow_requests','v2_workflow_performances','v2_workflow_receivings','v2_workflow_ledger','v2_identity_audit','master_csv_applies','master_csv_applied_rows','v2_cutovers','api_request_metrics','v2_opening_imports'];
  for (const [names, permissions] of [[mutable,'SELECT,INSERT,UPDATE'],[appendOnly,'SELECT,INSERT'],[['v2_warehouse_grants','v2_machine_warehouses','v2_workflow_object_state'],'SELECT,INSERT,UPDATE,DELETE']]) {
    for (const name of names) await sourceClient.query(`GRANT ${permissions} ON ${pg.escapeIdentifier(name)} TO wms_app`);
  }
  await sourceClient.query('GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO wms_app');
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
  const destination = randomUUID();
  await sourceClient.query("INSERT INTO delivery_destinations(id,tenant_id,recipient_name,name,postal_code,address_line1,address_line2) VALUES($1,$2,'Restore recipient','Restore destination','12345','Restore address','Suite 7')",[destination,tenant]);
  for (const [kind,quantity] of [['INBOUND',100],['OUTBOUND',-30]]) {
    const document = randomUUID();
    await sourceClient.query(`INSERT INTO inventory_documents(id,tenant_id,kind,status,warehouse_id,source_location_id,destination_location_id,posted_at,recipient_name,delivery_address,delivery_destination_id) VALUES($1,$2,$3,'POSTED',$4,$5,$6,CURRENT_TIMESTAMP,$7,$8,$9)`,[document,tenant,kind,warehouse,quantity<0?location:null,quantity>0?location:null,kind==='OUTBOUND'?'Restore recipient':null,kind==='OUTBOUND'?'Restore address Suite 7':null,kind==='OUTBOUND'?destination:null]);
    await sourceClient.query('INSERT INTO inventory_document_lines(tenant_id,document_id,item_id,quantity) VALUES($1,$2,$3,$4)',[tenant,document,item,Math.abs(quantity)]);
    await sourceClient.query('INSERT INTO stock_ledger(tenant_id,document_id,warehouse_id,location_id,item_id,quantity_delta) VALUES($1,$2,$3,$4,$5,$6)',[tenant,document,warehouse,location,item,quantity]);
    await sourceClient.query('INSERT INTO audit_logs(tenant_id,document_id,actor_id,action) VALUES($1,$2,$3,$4)',[tenant,document,user,`POST_${kind}`]);
    await sourceClient.query('INSERT INTO idempotency_requests(tenant_id,key,request_hash,response) VALUES($1,$2,$3,$4::jsonb)',[tenant,`restore-${document}`,createHash('sha256').update(JSON.stringify({document,kind,quantity})).digest('hex'),JSON.stringify({document:{id:document,status:'POSTED',kind},status:200})]);
  }
  await sourceClient.query('INSERT INTO stock_balances(tenant_id,warehouse_id,location_id,item_id,quantity) VALUES($1,$2,$3,$4,70)',[tenant,warehouse,location,item]);
  // Advance beyond MAX(document_no): restore must preserve sequence state, including gaps.
  await sourceClient.query("SELECT nextval(pg_get_serial_sequence('inventory_documents','document_no'))");
  const v2 = await seedV2RestoreFixture(sourceClient,{tenant,foreign,warehouse,location,item,destination,user});
  assert.deepEqual(await reconcileV2Restore(sourceClient),{ledger_mismatches:0,state_mismatches:0});
  const limiterFixture={id:randomUUID(),key:createHash('sha256').update('synthetic-restore-limiter').digest('hex'),count:2,lastRequest:Date.now()};
  await sourceClient.query('INSERT INTO "rateLimit"(id,key,count,"lastRequest") VALUES($1,$2,$3,$4)',Object.values(limiterFixture));
  const normalizedFixture={tenant,warehouse,state:v2.state};
  const normalizedState=await verifyNormalizedState(sourceClient,normalizedFixture);
  const before = await fingerprint(sourceClient);
  assert.equal(migrationFiles.length,20,'Restore drill requires all v2 migrations.');
  assert.equal(before.counts.pgmigrations,migrationFiles.length);
  for(const table of v2Tables)assert(before.counts[table]>0,'Every v2 table must have synthetic data.');
  assert.equal(before.counts.delivery_destinations,1);
  for (const table of ['user','account','session','verification','rateLimit','memberships']) assert.equal(before.counts[table],1);
  for (const table of ['audit_logs','idempotency_requests']) assert.equal(before.counts[table],2);
  const sourceCtx = { ...ctx, database: source };
  const archive = await backup(sourceCtx,file);
  const checksumTarget = `wms_restore_checksum_${token}`;
  await assert.rejects(restore(sourceCtx,file,checksumTarget,{expectedSha256:'0'.repeat(64)}));
  assert.equal((await ctx.client.query('SELECT 1 FROM pg_database WHERE datname=$1',[checksumTarget])).rowCount,0,'Checksum refusal must precede target creation.');
  await restore(sourceCtx,file,target,{expectedSha256:archive.archive_sha256,onCreated:name=>owned.push(name)});
  // Explicitly exercise overwrite refusal without touching any target data.
  await assert.rejects(restore(sourceCtx,file,target), { code: '42P04' });
  await assert.rejects(restore(sourceCtx,file,source));
  await assert.rejects(backup(sourceCtx,file), { code: 'EEXIST' });
  targetClient = await connect(ctx.url,target);
  assert.deepEqual(await fingerprint(targetClient),before);
  assert.deepEqual(await verifyNormalizedState(targetClient,normalizedFixture),normalizedState);
  assert.deepEqual((await targetClient.query('SELECT id,key,count,"lastRequest"::float8 AS "lastRequest" FROM "rateLimit"')).rows,[limiterFixture]);
  const security = await targetClient.query("SELECT relname FROM pg_class WHERE relnamespace='public'::regnamespace AND relrowsecurity AND relforcerowsecurity ORDER BY relname");
  assert.deepEqual(security.rows.map(row => row.relname),rlsTables);
  const v2Reconciliation=await reconcileV2Restore(targetClient);
  assert.deepEqual(v2Reconciliation,{ledger_mismatches:0,state_mismatches:0});
  const reconciliation = await targetClient.query(`SELECT COUNT(*)::int AS mismatches FROM stock_balances b FULL JOIN (SELECT tenant_id,warehouse_id,location_id,item_id,SUM(quantity_delta) quantity FROM stock_ledger GROUP BY 1,2,3,4) l USING(tenant_id,warehouse_id,location_id,item_id) WHERE COALESCE(b.quantity,0)<>COALESCE(l.quantity,0)`);
  assert.equal(reconciliation.rows[0].mismatches,0);
  app = await connect(process.env.DATABASE_URL,target);
  const role = (await app.query(`SELECT current_user name,rolsuper,rolbypassrls,EXISTS(SELECT 1 FROM pg_class WHERE relnamespace='public'::regnamespace AND relowner=pg_roles.oid AND relkind IN ('r','p')) owns_tables FROM pg_roles WHERE rolname=current_user`)).rows[0];
  const restoredCredential = await app.query('SELECT password FROM account WHERE "userId"=$1',[user]);
  assert(await verifyPassword({hash:restoredCredential.rows[0].password,password:credential}));
  assert.equal((await app.query('SELECT role FROM memberships WHERE user_id=$1',[user])).rows[0].role,'admin');
  assert.equal((await app.query('SELECT idle_lock_minutes FROM tenants WHERE id=$1',[tenant])).rows[0].idle_lock_minutes,7);
  assert.equal((await app.query('SELECT token FROM session WHERE "userId"=$1',[user])).rows[0].token,sessionToken);
  assert.deepEqual(role,{name:'wms_app',rolsuper:false,rolbypassrls:false,owns_tables:false});
  assert.equal((await app.query('SELECT * FROM delivery_destinations')).rowCount,0);
  assert.equal((await app.query('SELECT * FROM stock_balances')).rowCount,0);
  for(const table of [...rlsTables,...v2Views])assert.equal((await app.query(`SELECT * FROM ${pg.escapeIdentifier(table)}`)).rowCount,0,'Missing tenant context must expose no protected rows.');
  await app.query("SELECT set_config('app.tenant_id',$1,false)",[tenant]);
  assert.equal((await app.query('SELECT * FROM delivery_destinations')).rowCount,1);
  const restoredOutbound = (await app.query("SELECT d.document_no::text,d.recipient_name,d.delivery_address,d.delivery_destination_id,a.address_line2 FROM inventory_documents d JOIN delivery_destinations a ON a.id=d.delivery_destination_id WHERE d.kind='OUTBOUND'")).rows[0];
  assert.deepEqual(restoredOutbound,{document_no:'2',recipient_name:'Restore recipient',delivery_address:'Restore address Suite 7',delivery_destination_id:destination,address_line2:'Suite 7'});
  assert.equal((await app.query('SELECT quantity FROM stock_balances')).rows[0].quantity,'70');
  for(const table of v2Tables)assert((await app.query(`SELECT * FROM ${pg.escapeIdentifier(table)}`)).rowCount>0,'Restored application role must read each synthetic v2 table under its tenant.');
  await app.query("SELECT set_config('app.user_id',$1,false),set_config('app.environment','test',false)",[user]);
  assert.deepEqual(await verifyNormalizedState(app,normalizedFixture),normalizedState);
  for(const relation of ['v2_workflow_state','v2_workflow_state_header','v2_workflow_object_state']) {
    for(const privilege of ['SELECT','INSERT','UPDATE','DELETE'])assert.equal((await app.query('SELECT has_table_privilege(current_user,$1,$2) allowed',[relation,privilege])).rows[0].allowed,true,'Restored normalized-storage grants must support compatibility writes.');
  }
  // A rolled-back compatibility write proves triggers and body grants survive the archive.
  await app.query('BEGIN');
  try {
    const changed={...v2.state,version:2,tasks:[...v2.state.tasks,{id:randomUUID(),reason:'Restore trigger probe'}]};
    await app.query('UPDATE v2_workflow_state SET version=2,state=$3::jsonb WHERE tenant_id=$1 AND warehouse_id=$2',[tenant,warehouse,JSON.stringify(changed)]);
    assert.deepEqual((await app.query('SELECT version,state FROM v2_workflow_state WHERE tenant_id=$1 AND warehouse_id=$2',[tenant,warehouse])).rows,[{version:2,state:changed}]);
    assert.equal((await app.query('SELECT count(*)::int count FROM v2_workflow_object_state WHERE changed_version=2')).rows[0].count,normalizedState.body_rows+1);
  } finally { await app.query('ROLLBACK'); }
  assert.deepEqual(await fingerprint(targetClient),before);
  assert.deepEqual((await app.query('SELECT s::text,r::text,p::text,q::text,b::text FROM v2_workflow_stock')).rows,[{s:'50',r:'10',p:'5',q:'12',b:'3'}]);
  assert.deepEqual((await app.query('SELECT response FROM v2_workflow_requests WHERE request_id=$1',[v2.request])).rows[0].response,v2.response);
  assert.deepEqual((await app.query('SELECT status,revision,attempts FROM v2_integration_events ORDER BY sequence')).rows,[{status:'applied',revision:1,attempts:1},{status:'retry_wait',revision:2,attempts:1}]);
  assert.equal((await app.query('SELECT rotated_from FROM v2_machine_keys WHERE id=$1',[v2.key])).rows[0].rotated_from,v2.previousKey);
  assert.equal((await app.query("SELECT count(*)::int count FROM v2_machine_keys WHERE revoked_at IS NOT NULL")).rows[0].count,1);
  const openingImports=(await app.query('SELECT id,request_id,phase,parent_id,payload,actor_id FROM v2_opening_imports ORDER BY id')).rows;
  assert.deepEqual(openingImports,[...v2.openingImports].sort((a,b)=>a.id.localeCompare(b.id)));
  for(const record of openingImports.filter(row=>row.phase==='request'))assert.equal(createHash('sha256').update(record.payload.csv).digest('hex'),record.payload.source_hash);
  await assert.rejects(targetClient.query('INSERT INTO v2_opening_imports(id,tenant_id,warehouse_id,request_id,phase,parent_id,payload,actor_id) VALUES($1,$2,$3,$4,\'approve\',$5,\'{}\',$6)',[randomUUID(),tenant,v2.foreignWarehouse,randomUUID(),randomUUID(),user]),{code:'23503'});
  await assert.rejects(app.query('INSERT INTO v2_warehouse_grants VALUES($1,$2,$3)',[tenant,user,v2.foreignWarehouse]),{code:'23503'});
  const immutableStatements=['UPDATE v2_workflow_ledger SET delta=1','UPDATE v2_workflow_requests SET response=\'{}\'::jsonb','UPDATE v2_workflow_performances SET reason=\'changed\'','UPDATE v2_workflow_receivings SET receiving_id=gen_random_uuid()','UPDATE v2_identity_audit SET action=\'changed\'','UPDATE v2_cutovers SET snapshot_hash=repeat(\'0\',64)','UPDATE master_barcodes SET quantity=9 WHERE unit=\'BOX\'','UPDATE v2_integration_events SET revision=99','UPDATE api_request_metrics SET status=201'];
  immutableStatements.push('UPDATE v2_opening_imports SET payload=\'{}\'::jsonb','DELETE FROM v2_opening_imports');
  for(const statement of immutableStatements)await assert.rejects(app.query(statement),error=>['42501','23514'].includes(error.code));
  // Immutable triggers also survive the archive, independently of restrictive app grants.
  for(const statement of immutableStatements)await assert.rejects(targetClient.query(statement),error=>['42501','23514'].includes(error.code));
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
  for(const table of [...rlsTables,...v2Views])assert.equal((await app.query(`SELECT * FROM ${pg.escapeIdentifier(table)} WHERE tenant_id=$1`,[tenant])).rowCount,0,'Foreign context must expose none of the source tenant rows.');
  assert.equal((await app.query('UPDATE v2_workflow_object_state SET body=body WHERE tenant_id=$1 RETURNING *',[tenant])).rowCount,0);
  await assert.rejects(app.query("INSERT INTO v2_workflow_object_state(tenant_id,warehouse_id,kind,object_key,position,body,changed_version) VALUES($1,$2,'tasks','foreign-probe',999,'{}',1)",[tenant,warehouse]),{code:'42501'});
  await assert.rejects(app.query("INSERT INTO items(tenant_id,code,name) VALUES($1,'CROSS-TENANT','Forbidden')",[tenant]), {code:'42501'});
  assert.deepEqual(await fingerprint(sourceClient),before);
  const maxNumber = BigInt((await targetClient.query('SELECT MAX(document_no)::text AS value FROM inventory_documents')).rows[0].value);
  // Cut-over warehouses retain legacy history but reject new legacy documents.
  // Check the restored sequence directly without bypassing this guard.
  const nextDocument = (await targetClient.query("SELECT nextval(pg_get_serial_sequence('inventory_documents','document_no'))::text document_no")).rows[0];
  assert(BigInt(nextDocument.document_no)>maxNumber);
  assert.equal(nextDocument.document_no,'4');
  await assert.rejects(targetClient.query("INSERT INTO inventory_documents(tenant_id,kind,warehouse_id,destination_location_id) VALUES($1,'INBOUND',$2,$3)",[tenant,warehouse,location]),{code:'23514'});
  const nextEvent=(await targetClient.query("SELECT nextval('v2_integration_events_sequence_seq')::text value")).rows[0].value;
  assert.equal(nextEvent,'4');
  const verifiedAt=new Date().toISOString();
  const evidence={tenant_id:tenant,completed_at:archive.completed_at,archive_sha256:archive.archive_sha256,restore_verified_at:verifiedAt};
  const report={result:'PASS',verified_at:verifiedAt,verification_scope:'synthetic_local_same_cluster',provider_recovery:'NOT_EXECUTED',
    migrations:migrationFiles.length,tables_checked:tables.length,v2_tables_checked:v2Tables.length,compatibility_views_checked:v2Views.length,normalized_state:normalizedState,
    sequence_states:before.sequences,next_restored_document_no:nextDocument.document_no,next_restored_event_sequence:nextEvent,
    archive_bytes:archive.bytes,archive_sha256:archive.archive_sha256,completed_at:archive.completed_at,restore_verified_at:verifiedAt,
    fixture:{synthetic_only:true,tenants:2,users:1,documents:2,idle_lock_minutes:7,legacy_balance:70,v2_stock:{S:50,R:10,P:5,Q:12,B:3,H:70},workflow_ledger_entries:6,workflow_requests:1,request_metrics:2,pending_approvals:1,integration_events:{applied:1,retry_wait:1},rotated_keys:2,opening_imports:{originals:2,approved:1,rejected:1,original_csv_hash_verified:true}},
    row_counts:before.counts,source_sha256:before.sha256,restored_identical:true,source_unchanged:true,
    forced_rls_tables:security.rowCount,reconciliation_mismatches:0,v2_reconciliation:v2Reconciliation,
    application_role:'authenticated wms_app; nonowner/nonsuperuser/no BYPASSRLS',
    tenants:{[tenant]:evidence,[foreign]:{...evidence,tenant_id:foreign}},
    checks:['all physical public tables fingerprinted; every v2 table has synthetic rows; invoker compatibility view and reconstructed logical state fingerprinted','normalized header metadata, ordered object bodies and compatibility write triggers preserved','all sequence states preserved including document and event gaps',
      'legacy and v2 stock/ledger and aggregate state reconcile independently','workflow request response, pending approval and retry event preserved',
      'restored credentials, membership, idle policy, explicit warehouse grant, rotated key and consumed link preserved',
      'all FORCE RLS tables hide rows without context and hide source-tenant rows in foreign context','tenant composite FK rejects foreign warehouse grant',
      'append-only permissions and immutable triggers survive restore','source unchanged; existing/source targets and archive overwrite refused','archive checksum mismatch refused before target creation','shared authentication rate-limit state preserved'],
    limitations:['Same local PostgreSQL cluster; existing cluster roles and passwords were reused.','Synthetic SQL fixtures prove preservation, not new workflow execution.','No remote-provider restore, PITR, offsite archive recovery, HTTP login, RPO or RTO verification was executed.']};
  await writeFile(new URL('../docs/restore-verification-schema20.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
} catch(error) { const line=error.stack?.match(/verify-restore\.mjs:(\d+):\d+/)?.[1]; if(line)console.error(`Restore verification check failed at script line ${line}.`); if (/^v2-fixture-statement-\d+$/.test(error.restoreStage ?? '')) console.error(`Synthetic restore fixture failed at ${error.restoreStage}.`); safeFailure('Restore verification',error); }
finally {
  await Promise.all([app?.end(),sourceClient?.end(),targetClient?.end()]);
  if(ctx) {
    for(const name of owned.reverse()) await ctx.client.query(`DROP DATABASE ${pg.escapeIdentifier(name)}`).catch(()=>{console.error('Drill cleanup failed; remove only this run’s isolated databases after investigation.');process.exitCode=1;});
    await ctx.client.end();
  }
  await unlink(file).catch(()=>{});
}
