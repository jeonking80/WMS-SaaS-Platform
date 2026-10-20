/** T12 local HTTP recovery drill. Creates/removes only this run's isolated databases. */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { cp, mkdtemp, open, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { context, backup, restore } from './backup-lib.mjs';
import { migrate } from './db-migrate.mjs';
import { provisionCompany } from './provision-company.mjs';
import { reconcileV2Restore } from './restore-v2-fixture.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const run=randomUUID(),suffix=run.replaceAll('-','').slice(0,16);
const source=`wms_restore_http_source_${suffix}`,target=`wms_restore_http_replay_${suffix}`;
const owned=[];
const port=Number(process.env.WMS_RECOVERY_PORT??3301),origin=`http://127.0.0.1:${port}`;
const cookieJar=new Map();
let ctx,directory,runtime,child,sourceAdmin,targetAdmin,stage='preflight';
const secret=randomBytes(48).toString('hex');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function canonical(value){if(value?.toJSON)return canonical(value.toJSON());if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';if(value&&typeof value==='object')return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';return JSON.stringify(value);}
const hash=value=>createHash('sha256').update(canonical(value)).digest('hex');
function progress(value){stage=value;console.error(JSON.stringify({event:'recovery_drill_stage',stage}));}
function binding(original,database){const url=new URL(original);url.pathname=`/${database}`;return url.href;}
async function connectAdmin(database){const client=new pg.Client({connectionString:binding(ctx.url,database),connectionTimeoutMillis:5000});await client.connect();return client;}
async function privateFile(file,value){const handle=await open(file,'wx',0o600);try{await handle.writeFile(JSON.stringify(value,null,2)+'\n');await handle.sync();}finally{await handle.close();}}
async function assertPortAvailable(){const server=createServer();await new Promise((resolvePromise,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',()=>server.close(error=>error?reject(error):resolvePromise()));});}
async function stopServer(){if(!child)return;const running=child;child=undefined;if(running.exitCode!==null||running.signalCode!==null||!running.pid)return;const exited=new Promise(resolvePromise=>running.once('exit',resolvePromise));running.kill('SIGTERM');let timer;await Promise.race([exited,new Promise(resolvePromise=>{timer=setTimeout(()=>{running.kill('SIGKILL');resolvePromise();},12000);})]);clearTimeout(timer);if(running.exitCode===null)await exited;}
async function startServer(database,appUrl){
  await assertPortAvailable();
  // Run an independent immutable build copy without administrative .env bindings.
  const inherited=Object.fromEntries(['PATH','NODE_EXTRA_CA_CERTS','SSL_CERT_FILE','SSL_CERT_DIR','TZ','LANG','LC_ALL'].filter(key=>process.env[key]).map(key=>[key,process.env[key]]));
  child=spawn(process.execPath,[join(runtime,'server.js')],{
    cwd:runtime,env:{...inherited,NODE_ENV:'production',PORT:String(port),HOSTNAME:'127.0.0.1',NEXT_TELEMETRY_DISABLED:'1',DATABASE_URL:binding(appUrl,database),BETTER_AUTH_URL:origin,BETTER_AUTH_SECRET:secret,WMS_ENVIRONMENT:'test'},stdio:['ignore','pipe','pipe'],
  });
  child.stdout.resume();child.stderr.resume();let spawnFailure=false;child.once('error',()=>{spawnFailure=true;});
  const deadline=Date.now()+45000;
  while(Date.now()<deadline){if(spawnFailure||child.exitCode!==null||child.signalCode!==null)throw Object.assign(new Error('Dedicated HTTP server failed to start'),{code:'DRILL_SERVER_START'});try{const response=await fetch(`${origin}/api/ready`,{signal:AbortSignal.timeout(1000)});if(response.ok){await response.body?.cancel();return;}}catch{}await pause(250);}
  throw Object.assign(new Error('Dedicated server readiness timed out'),{code:'DRILL_SERVER_READINESS'});
}
async function http(path,{method='GET',body,key,expected=200,discard=false,idempotencyKey}={}){
  const headers={origin,...(body?{'content-type':'application/json'}:{}),...(idempotencyKey?{'idempotency-key':idempotencyKey}:{}),...(key?{authorization:`Bearer ${key}`}:{cookie:[...cookieJar].map(([name,value])=>`${name}=${value}`).join('; ')})};
  const response=await fetch(`${origin}${path}`,{method,headers,...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(20000)});
  for(const cookie of response.headers.getSetCookie()){const pair=cookie.split(';')[0],equals=pair.indexOf('=');cookieJar.set(pair.slice(0,equals),pair.slice(equals+1));}
  if(response.status!==expected){let code='HTTP_FAILURE';try{const value=await response.json();if(/^[A-Z0-9_]+$/.test(value.error??''))code=value.error;}catch{}throw Object.assign(new Error('Recovery drill API request failed'),{code:`${code}_${response.status}`});}
  if(discard){await response.body?.cancel();return;}
  return response.json();
}
async function grantApplication(client,database){
  await client.query(`GRANT CONNECT ON DATABASE ${pg.escapeIdentifier(database)} TO wms_app,wms_migrator`);
  await client.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC,wms_app; GRANT USAGE ON SCHEMA public TO wms_app');
  const groups=[
    ['SELECT',['tenants','memberships']],
    ['SELECT,INSERT,UPDATE,DELETE',['user','session','account','verification','items','warehouses','locations','inventory_documents','inventory_document_lines']],
    ['SELECT,INSERT,UPDATE',['delivery_destinations','stock_balances','v2_workflow_state','v2_workflow_stock','v2_workflow_objects','v2_identity_links','v2_machine_keys','business_partners','master_barcodes','master_csv_previews','v2_integration_limits','v2_integration_entities','v2_integration_events']],
    ['SELECT,INSERT',['stock_ledger','idempotency_requests','audit_logs','v2_workflow_requests','v2_workflow_performances','v2_workflow_receivings','v2_workflow_ledger','v2_identity_audit','master_csv_applies','master_csv_applied_rows','v2_cutovers','api_request_metrics','v2_opening_imports']],
    ['SELECT,INSERT,UPDATE,DELETE',['v2_warehouse_grants','v2_machine_warehouses']],
  ];
  for(const[permissions,tables]of groups)for(const table of tables)await client.query(`GRANT ${permissions} ON ${pg.escapeIdentifier(table)} TO wms_app`);
  await client.query('GRANT UPDATE(idle_lock_minutes) ON tenants TO wms_app');
  await client.query('GRANT INSERT(user_id,tenant_id,role,status),UPDATE(role,status,updated_at) ON memberships TO wms_app');
  await client.query('GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO wms_app');
}
async function fingerprint(client){
  const tables=(await client.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows.map(row=>row.tablename);
  const rowsHash=createHash('sha256'),counts={};
  for(const table of tables){const result=await client.query(`SELECT row_to_json(t)::text value FROM ${pg.escapeIdentifier(table)} t ORDER BY row_to_json(t)::text`);counts[table]=result.rowCount;rowsHash.update(JSON.stringify([table,result.rows]));}
  const sequences={};for(const row of(await client.query("SELECT sequencename FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename")).rows)sequences[row.sequencename]=(await client.query(`SELECT last_value::text,is_called FROM ${pg.escapeIdentifier(row.sequencename)}`)).rows[0];
  const policies=(await client.query("SELECT tablename,policyname,permissive,roles,cmd,qual,with_check FROM pg_policies WHERE schemaname='public' ORDER BY tablename,policyname")).rows;
  const security=(await client.query("SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r' ORDER BY relname")).rows;
  return {counts,rows_sha256:rowsHash.digest('hex'),sequences,policies_sha256:hash(policies),security_sha256:hash(security)};
}
async function checkpoint(client,tenant,warehouse,requestId,eventId){
  const state=(await client.query('SELECT state FROM v2_workflow_state WHERE tenant_id=$1 AND warehouse_id=$2',[tenant,warehouse])).rows[0].state;
  const stored=(await client.query('SELECT response FROM v2_workflow_requests WHERE tenant_id=$1 AND request_id=$2',[tenant,requestId])).rows[0].response;
  const event=(await client.query('SELECT id,sequence::text,event_id,status,request_hash FROM v2_integration_events WHERE tenant_id=$1 AND event_id=$2',[tenant,eventId])).rows[0];
  return {state,stored,event};
}
async function legacyEvidence(client,tenant,warehouse){
  const evidence={};
  for(const table of ['inventory_documents','stock_balances','stock_ledger'])evidence[table]=(await client.query(`SELECT to_jsonb(t) row FROM ${pg.escapeIdentifier(table)} t WHERE tenant_id=$1 AND warehouse_id=$2 ORDER BY to_jsonb(t)::text`,[tenant,warehouse])).rows;
  for(const table of ['inventory_document_lines','audit_logs'])evidence[table]=(await client.query(`SELECT to_jsonb(t) row FROM ${pg.escapeIdentifier(table)} t JOIN inventory_documents d ON(d.tenant_id,d.id)=(t.tenant_id,t.document_id) WHERE d.tenant_id=$1 AND d.warehouse_id=$2 ORDER BY to_jsonb(t)::text`,[tenant,warehouse])).rows;
  return evidence;
}
function totals(snapshot){return snapshot.stock.reduce((sum,row)=>{for(const key of ['S','R','P','Q','B','A','H'])sum[key]+=Number(row[key]);return sum;},{S:0,R:0,P:0,Q:0,B:0,A:0,H:0});}
try{
  assert(Number.isInteger(port)&&port>=3300&&port<=3399,'Dedicated recovery port must be in the 3300-3399 range.');
  directory=await mkdtemp(join(tmpdir(),'wms-http-recovery-'));
  runtime=join(directory,'runtime');
  await cp(resolve(process.env.WMS_RECOVERY_RUNTIME??join(root,'.next/standalone')),runtime,{recursive:true,dereference:true,filter:path=>!path.split('/').some(part=>part.startsWith('.env')||part==='.git')});
  const buildId=(await readFile(join(runtime,'.next/BUILD_ID'),'utf8')).trim();assert(buildId,'A previously built standalone application is required.');
  assert((await readdir(runtime)).every(name=>!name.startsWith('.env')));
  ctx=await context();
  const migrationUrl=new URL(process.env.MIGRATION_DATABASE_URL??''),appUrl=new URL(process.env.DATABASE_URL??'');
  for(const[url,role]of [[migrationUrl,'wms_migrator'],[appUrl,'wms_app']]){assert.equal(url.hostname,ctx.url.hostname);assert.equal(url.port,ctx.url.port);assert.equal(decodeURIComponent(url.username),role);assert(url.password);}
  const roleFlags=(await ctx.client.query("SELECT rolname,rolsuper,rolbypassrls FROM pg_roles WHERE rolname IN ('wms_app','wms_migrator')")).rows;assert.equal(roleFlags.length,2);assert(roleFlags.every(role=>!role.rolsuper&&!role.rolbypassrls));
  progress('source.create_and_migrate');
  await ctx.client.query(`CREATE DATABASE ${pg.escapeIdentifier(source)} OWNER wms_migrator TEMPLATE template0`);owned.push(source);
  await migrate(binding(migrationUrl,source),{log:()=>{}});
  sourceAdmin=await connectAdmin(source);await grantApplication(sourceAdmin,source);
  const invitationFile=join(directory,'initial-invitation.json'),adminPassword=randomBytes(24).toString('base64url'),email=`recovery-${suffix}@example.invalid`;
  const provisioned=await provisionCompany({databaseUrl:binding(migrationUrl,source),name:'HTTP recovery synthetic company',adminName:'HTTP recovery administrator',adminEmail:email,warehouseCode:'RECOVERY',warehouseName:'HTTP recovery warehouse',operator:'local-http-recovery-drill',reason:'T12 isolated actual API recovery verification',requestId:randomUUID(),origin,output:invitationFile,isTest:true});
  const tenant=provisioned.tenant_id,warehouse=provisioned.warehouse_id,invitation=JSON.parse(await readFile(invitationFile,'utf8'));
  progress('source.http_setup');await startServer(source,appUrl);
  await http('/api/v2/identity/accept',{method:'POST',body:{token:new URL(invitation.invitation_url).searchParams.get('token'),password:adminPassword}});
  await http('/api/auth/sign-in/email',{method:'POST',body:{email,password:adminPassword}});
  const me=await http('/api/me');assert.equal(me.tenant.id,tenant);assert.equal(me.role,'admin');
  const serverRoles=(await ctx.client.query('SELECT DISTINCT usename FROM pg_stat_activity WHERE datname=$1 AND pid<>$2',[source,sourceAdmin.processID])).rows.map(row=>row.usename);assert.deepEqual(serverRoles,['wms_app']);
  const master=async(kind,body,atWarehouse=warehouse)=>(await http(`/api/v2/masters/${kind}?warehouse_id=${atWarehouse}`,{method:'POST',body,expected:201})).row;
  const partner=await master('partners',{code:'RECOVERY',name:'Synthetic supplier and customer',supplier:true,customer:true});
  const destination=await master('destinations',{recipient_name:'Synthetic recipient',name:'Synthetic destination',address_line1:'Synthetic recovery address',partner_id:partner.id,external_code:'recovery-destination'});
  const item=await master('items',{code:'RECOVERY-EA',name:'Synthetic recovery item'});
  const receiving=await master('locations',{code:'RECEIVING',name:'Receiving',kind:'RECEIVING'}),storage=await master('locations',{code:'STORAGE',name:'Storage',kind:'STORAGE'});
  const workerInvite=await http('/api/v2/identity/users',{method:'POST',body:{name:'Synthetic recovery worker',email:`recovery-worker-${suffix}@example.invalid`,role:'worker',warehouseIds:[warehouse]},expected:201});
  await http('/api/v2/identity/accept',{method:'POST',body:{token:new URL(workerInvite.link,origin).searchParams.get('token'),password:randomBytes(24).toString('base64url')}});
  const physical=new Set(['receipt.receive','receipt.inspect','receipt.putaway']);
  const command=async(name,payload,requestId=randomUUID())=>http('/api/v2/workflow',{method:'POST',body:{warehouse_id:warehouse,command:name,request_id:requestId,payload:physical.has(name)?{...payload,manual_entry_reason:'Synthetic local recovery drill: selected item and location verified',lines:payload.lines.map(line=>({...line,input_mode:'search'}))}:payload}});
  let result=await command('receipt.create',{supplier_id:partner.id,expected_at:new Date(Date.now()+86400000).toISOString(),lines:[{item_id:item.id,quantity:100}]});
  const receipt=result.snapshot.receipts.find(row=>row.id===result.result.id);
  result=await command('receipt.receive',{receipt_id:receipt.id,receiving_id:randomUUID(),lines:[{line_id:receipt.lines[0].id,quantity:100,location_id:receiving.id}]});
  const lot=result.snapshot.receipts.find(row=>row.id===receipt.id).lots[0];
  await command('receipt.inspect',{receipt_id:receipt.id,lines:[{lot_id:lot.id,quantity:100,outcome:'normal'}]});
  await command('receipt.putaway',{receipt_id:receipt.id,lines:[{lot_id:lot.id,quantity:100,location_id:storage.id}]});
  progress('source.legacy_http_cutover');
  const legacyWarehouse=(await http('/api/warehouses',{method:'POST',body:{code:'LEGACY',name:'Synthetic legacy cutover rehearsal'},expected:201})).warehouse;
  const legacyStorage=await master('locations',{code:'LEGACY-STORAGE',name:'Legacy storage',kind:'STORAGE'},legacyWarehouse.id);
  const legacyReceiving=await master('locations',{code:'LEGACY-RECEIVING',name:'Legacy receiving',kind:'RECEIVING'},legacyWarehouse.id);
  const legacyHold=await master('locations',{code:'LEGACY-HOLD',name:'Legacy hold',kind:'HOLD'},legacyWarehouse.id);
  const legacyDocument=(await http('/api/documents',{method:'POST',expected:201,body:{kind:'INBOUND',warehouse_id:legacyWarehouse.id,source_location_id:null,destination_location_id:legacyStorage.id,note:'Synthetic T12 original legacy inbound',lines:[{item_id:item.id,quantity:60}]}})).document;
  const postedLegacy=await http(`/api/documents/${legacyDocument.id}/post`,{method:'POST',body:{version:legacyDocument.version},idempotencyKey:randomUUID()});
  assert.equal(postedLegacy.document.status,'POSTED');
  assert.match(legacyDocument.document_number,/^WMS-\d+$/);assert(legacyDocument.document_no);
  const originalLegacyEvidence=await legacyEvidence(sourceAdmin,tenant,legacyWarehouse.id);
  assert.equal(originalLegacyEvidence.stock_ledger.length,1);assert.equal(originalLegacyEvidence.stock_ledger[0].row.quantity_delta,60);
  const previewLegacy=await http(`/api/v2/operations/cutover?warehouse_id=${legacyWarehouse.id}`);assert.equal(previewLegacy.consistent,true);assert.equal(previewLegacy.summary.documents,1);
  const cutoverRequest={warehouse_id:legacyWarehouse.id,request_id:randomUUID(),snapshot_hash:previewLegacy.snapshot_hash,confirmed:true,rows:[{item_id:item.id,source_location_id:legacyStorage.id,location_id:legacyStorage.id,bucket:'S',quantity:40},{item_id:item.id,source_location_id:legacyStorage.id,location_id:legacyReceiving.id,bucket:'Q',quantity:10},{item_id:item.id,source_location_id:legacyStorage.id,location_id:legacyHold.id,bucket:'B',quantity:10}]};
  assert.equal((await http('/api/v2/operations/cutover',{method:'POST',body:cutoverRequest})).replayed,false);
  assert.deepEqual(await legacyEvidence(sourceAdmin,tenant,legacyWarehouse.id),originalLegacyEvidence);
  const legacyOrder=await http('/api/v2/workflow',{method:'POST',body:{warehouse_id:legacyWarehouse.id,request_id:randomUUID(),command:'order.create',payload:{delivery:{partner_id:partner.id,delivery_destination_id:destination.id},due_at:new Date(Date.now()+86400000).toISOString(),lines:[{item_id:item.id,quantity:12}]}}});
  const legacyReserveRequest={warehouse_id:legacyWarehouse.id,request_id:randomUUID(),command:'order.reserve',payload:{order_id:legacyOrder.result.id,partial:false}};
  const legacyWorked=await http('/api/v2/workflow',{method:'POST',body:legacyReserveRequest});assert.deepEqual(totals(legacyWorked.snapshot),{S:40,R:12,P:0,Q:10,B:10,A:28,H:60});
  assert.equal(legacyWorked.snapshot.ledger.filter(row=>row.command==='MIGRATION_OPENING').length,3);
  const sourceSystem=`recovery-${suffix}`;
  const key=(await http('/api/v2/identity/keys',{method:'POST',expected:201,body:{name:'Synthetic external recovery source',sourceSystem,environment:'test',kind:'integration',scopes:['integration:event','integration:read','integration:process'],warehouseIds:[warehouse]}})).token;
  const event=(eventType,externalId,payload)=>({schema_version:'2.0',event_id:randomUUID(),source_system:sourceSystem,external_entity_id:externalId,revision:1,event_type:eventType,occurred_at:new Date().toISOString(),correlation_id:run,run_id:run,warehouse_id:warehouse,payload});
  const orderEvent=event('order.create','recovery-order',{delivery:{partner_id:partner.id,delivery_destination_id:destination.id},due_at:new Date(Date.now()+86400000).toISOString(),lines:[{item_id:item.id,quantity:40}]});
  await http('/api/v2/integration/events',{method:'POST',key,body:orderEvent,expected:202});
  const processed=await http('/api/v2/integration/process',{method:'POST',key,body:{warehouse_id:warehouse,limit:25}});assert.equal(processed.events.length,1);assert.equal(processed.events[0].status,'applied');
  const orderId=processed.events[0].result.id;
  await command('task.assign',{object_type:'order',object_id:orderId,assignee_id:workerInvite.userId,reason:'Synthetic recovery task handover'});
  await command('order.reserve',{order_id:orderId,partial:false});
  const additional=await command('receipt.create',{supplier_id:partner.id,expected_at:new Date(Date.now()+86400000).toISOString(),lines:[{item_id:item.id,quantity:30}]});
  const additionalReceipt=additional.snapshot.receipts.find(row=>row.id===additional.result.id);
  const lostRequest={warehouse_id:warehouse,command:'receipt.receive',request_id:randomUUID(),payload:{receipt_id:additionalReceipt.id,receiving_id:randomUUID(),manual_entry_reason:'Synthetic local recovery drill: selected item and receiving location verified',lines:[{line_id:additionalReceipt.lines[0].id,quantity:30,location_id:receiving.id,input_mode:'search'}]}};
  const pending=event('receipt.create','recovery-pending-receipt',{supplier_id:partner.id,expected_at:new Date(Date.now()+86400000).toISOString(),lines:[{item_id:item.id,quantity:25}]});
  const journalFile=join(directory,'unconfirmed-journal.json');await privateFile(journalFile,{run_id:run,tenant_id:tenant,warehouse_id:warehouse,workflow:{status:'result_unconfirmed',request:lostRequest},external:{status:'result_unconfirmed',event:pending}});
  progress('source.discard_committed_responses');
  await http('/api/v2/workflow',{method:'POST',body:lostRequest,discard:true});
  await http('/api/v2/integration/events',{method:'POST',key,body:pending,expected:202,discard:true});
  await stopServer();
  const saved=await checkpoint(sourceAdmin,tenant,warehouse,lostRequest.request_id,pending.event_id);assert.equal(saved.event.status,'accepted');assert.equal(saved.state.orders.find(row=>row.id===orderId).reservations.reduce((sum,row)=>sum+row.quantity,0),40);
  assert.equal(saved.state.tasks.find(row=>row.object_id===orderId).assignee_id,workerInvite.userId);
  const before=await fingerprint(sourceAdmin);assert.equal(before.counts.pgmigrations,18);assert.equal(Object.keys(before.counts).length,40);
  assert.deepEqual(await reconcileV2Restore(sourceAdmin),{ledger_mismatches:0,state_mismatches:0});
  progress('archive.dump_restore');
  const archiveFile=join(directory,'http-recovery.dump'),archive=await backup({...ctx,database:source},archiveFile);
  await restore({...ctx,database:source},archiveFile,target,{expectedSha256:archive.archive_sha256,onCreated:name=>owned.push(name)});
  targetAdmin=await connectAdmin(target);assert.deepEqual(await fingerprint(targetAdmin),before);
  progress('restored.same_cookie_same_request');await startServer(target,appUrl);
  const restoredMe=await http('/api/me');assert.equal(restoredMe.user.id,me.user.id);assert.equal(restoredMe.tenant.id,tenant);
  assert.deepEqual(await legacyEvidence(targetAdmin,tenant,legacyWarehouse.id),originalLegacyEvidence);
  const restoredLegacy=(await http(`/api/documents/${legacyDocument.id}`)).document;assert.equal(restoredLegacy.id,legacyDocument.id);assert.equal(restoredLegacy.document_no,legacyDocument.document_no);assert.equal(restoredLegacy.document_number,legacyDocument.document_number);assert.equal(restoredLegacy.status,'POSTED');
  const restoredCutover=await http('/api/v2/operations/cutover',{method:'POST',body:cutoverRequest});assert.equal(restoredCutover.replayed,true);
  const restoredReservation=await http('/api/v2/workflow',{method:'POST',body:legacyReserveRequest});assert.equal(restoredReservation.replayed,true);assert.deepEqual(restoredReservation.result,legacyWorked.result);assert.deepEqual(totals(restoredReservation.snapshot),{S:40,R:12,P:0,Q:10,B:10,A:28,H:60});
  assert.deepEqual(restoredReservation.snapshot.ledger,legacyWorked.snapshot.ledger);
  const journal=JSON.parse(await readFile(journalFile,'utf8'));
  const replay=await http('/api/v2/workflow',{method:'POST',body:journal.workflow.request});assert.equal(replay.replayed,true);
  const recoveredResponse={result:replay.result,version:replay.snapshot.version};assert.deepEqual(recoveredResponse,saved.stored);
  assert.deepEqual(totals(replay.snapshot),{S:100,R:40,P:0,Q:30,B:0,A:60,H:130});
  const secondReplay=await http('/api/v2/workflow',{method:'POST',body:journal.workflow.request});assert.equal(secondReplay.replayed,true);assert.deepEqual(secondReplay.result,replay.result);
  const afterReplay=await checkpoint(targetAdmin,tenant,warehouse,lostRequest.request_id,pending.event_id);assert.deepEqual(afterReplay.state,saved.state);
  progress('restored.external_event_resume');
  const eventReplay=await http('/api/v2/integration/events',{method:'POST',key,body:journal.external.event,expected:202});assert.equal(eventReplay.replayed,true);assert.equal(eventReplay.event.id,saved.event.id);assert.equal(eventReplay.event.sequence,saved.event.sequence);
  const resumed=await http('/api/v2/integration/process',{method:'POST',key,body:{warehouse_id:warehouse,limit:25}});assert.equal(resumed.events.length,1);assert.equal(resumed.events[0].id,saved.event.id);assert.equal(resumed.events[0].status,'applied');assert.equal(resumed.events[0].attempts,1);
  const appliedReplay=await http('/api/v2/integration/events',{method:'POST',key,body:journal.external.event,expected:202});assert.equal(appliedReplay.replayed,true);assert.deepEqual(appliedReplay.event,resumed.events[0]);
  assert.deepEqual((await http('/api/v2/integration/process',{method:'POST',key,body:{warehouse_id:warehouse,limit:25}})).events,[]);
  const final=(await http(`/api/v2/workflow?warehouse_id=${warehouse}`)).snapshot;assert.deepEqual(totals(final),{S:100,R:40,P:0,Q:30,B:0,A:60,H:130});assert.deepEqual(final.orders,replay.snapshot.orders);assert.deepEqual(final.tasks,replay.snapshot.tasks);assert.equal(final.receipts.length,replay.snapshot.receipts.length+1);
  await stopServer();
  const effects=(await targetAdmin.query(`SELECT
    (SELECT count(*)::int FROM v2_workflow_requests WHERE tenant_id=$1 AND request_id=$2) workflow_requests,
    (SELECT count(*)::int FROM v2_workflow_ledger WHERE tenant_id=$1 AND request_id=$2 AND bucket='Q') receiving_effects,
    (SELECT COALESCE(sum(delta),0)::int FROM v2_workflow_ledger WHERE tenant_id=$1 AND request_id=$2 AND bucket='Q') received_quantity,
    (SELECT count(*)::int FROM v2_integration_events WHERE tenant_id=$1 AND event_id=$3) external_events,
    (SELECT count(*)::int FROM v2_workflow_requests WHERE tenant_id=$1 AND request_id=$4) external_workflow_effects,
    (SELECT count(*)::int FROM v2_workflow_objects WHERE tenant_id=$1 AND kind='receipt' AND external_id=$5) external_objects`,[tenant,lostRequest.request_id,pending.event_id,saved.event.id,`${sourceSystem}:${pending.external_entity_id}`])).rows[0];
  assert.deepEqual(effects,{workflow_requests:1,receiving_effects:1,received_quantity:30,external_events:1,external_workflow_effects:1,external_objects:1});
  const reconciliation=await reconcileV2Restore(targetAdmin);assert.deepEqual(reconciliation,{ledger_mismatches:0,state_mismatches:0});assert.deepEqual(await fingerprint(sourceAdmin),before);
  const verifiedAt=new Date().toISOString();
  const report={result:'PASS',scenario:'T12',verified_at:verifiedAt,verification_scope:'actual_http_synthetic_local_same_cluster',build_id:buildId,migrations:18,tables_checked:Object.keys(before.counts).length,
    fault:'client_discarded_committed_response_body',unconfirmed_remaining:0,source_unchanged:true,restored_identical_before_resume:true,same_session_cookie_restored:true,resumed_from_durable_journal:true,
    workflow:{comparison:'persisted committed result and version; replay marker is expected to change',command:lostRequest.command,request_id:lostRequest.request_id,original_response_sha256:hash(saved.stored),recovered_response_sha256:hash(recoveredResponse),identical:true,replays:2,effects:effects.receiving_effects,received_quantity:30,bucket:'Q'},
    external:{event_id:pending.event_id,receipt_id:saved.event.id,sequence:saved.event.sequence,accepted_before_dump:true,replayed_same_receipt:true,applied_after_restore:true,processing_attempts:1,event_rows:effects.external_events,workflow_effects:effects.external_workflow_effects,objects:effects.external_objects},
    work_preserved:{reservations:40,tasks:final.tasks.length,assignee_unchanged:true,orders_unchanged:true},final_inventory:totals(final),reconciliation,
    legacy_cutover:{actual_http_rehearsal:true,warehouse_id:legacyWarehouse.id,document_id:legacyDocument.id,document_number:legacyDocument.document_number,original_ledger_ids:originalLegacyEvidence.stock_ledger.map(row=>row.row.id),legacy_records_unchanged:true,opening_ledger_entries:3,opening_ledger_ids:legacyWorked.snapshot.ledger.filter(row=>row.command==='MIGRATION_OPENING').map(row=>row.id),opening:{S:40,Q:10,B:10,H:60},reservation:12,cutover_replay_preserved:true,reservation_replay_preserved:true,restored_inventory:totals(restoredReservation.snapshot)},
    row_counts_before_resume:before.counts,source_sha256:before.rows_sha256,archive_sha256:archive.archive_sha256,completed_at:archive.completed_at,restore_verified_at:verifiedAt,
    tenants:{[tenant]:{tenant_id:tenant,completed_at:archive.completed_at,archive_sha256:archive.archive_sha256,restore_verified_at:verifiedAt}},
    server_database_access:'wms_app only; isolated runtime cwd without administrative .env files',provider_recovery:'NOT_EXECUTED',
    limitations:['Same local PostgreSQL cluster and existing cluster roles; no remote-provider restore or PITR.','Response loss is a deliberate client discard after committed HTTP response headers, not a network outage.','No RPO/RTO target, physical warehouse, or real-device acceptance is claimed.']};
  await writeFile(join(root,'docs/v2-recovery-replay-latest.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
}catch(error){console.error(JSON.stringify({result:'FAIL',stage,error_code:/^[A-Z0-9_]+$/i.test(String(error.code??error.name))?error.code??error.name:'DRILL_FAILED',check_line:error.stack?.match(/v2-recovery-replay\.mjs:(\d+):\d+/)?.[1]??null}));process.exitCode=1;}
finally{
  await stopServer().catch(()=>{console.error('Dedicated recovery server cleanup failed.');process.exitCode=1;});
  await Promise.allSettled([sourceAdmin?.end(),targetAdmin?.end()]);
  if(ctx){for(const database of owned.reverse())await ctx.client.query(`DROP DATABASE ${pg.escapeIdentifier(database)}`).catch(()=>{console.error('This run isolated database cleanup failed.');process.exitCode=1;});await ctx.client.end();}
  if(directory)await rm(directory,{recursive:true,force:true}).catch(()=>{console.error('Private recovery fixture cleanup failed.');process.exitCode=1;});
}
