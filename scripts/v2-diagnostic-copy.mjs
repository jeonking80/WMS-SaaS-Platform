// Operational wrapper only. No database URL is passed to the simulator.
import {readFile,writeFile,mkdir,open,stat,chmod} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {pipeline} from 'node:stream/promises';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import pg from 'pg';
import {context} from './backup-lib.mjs';
import {migrate} from './db-migrate.mjs';

const sha=value=>createHash('sha256').update(value).digest('hex');
const fail=code=>{throw Object.assign(new Error(code),{code});};
const envName=value=>typeof value==='string'&&/^[A-Z][A-Z0-9_]*$/.test(value);
export function validateDiagnosticPlan(value){
 if(!value||!/^([a-f0-9]{8}-)([a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value.source_run_id??''))fail('DIAGNOSTIC_RUN_REQUIRED');
 if(!/^wms_diagnostic_[a-z0-9_]{1,45}$/.test(value.clone_database??''))fail('FRESH_DIAGNOSTIC_DATABASE_REQUIRED');
 if(value.frozen_database!==undefined&&(!/^wms_diagnostic_[a-z0-9_]{1,45}$/.test(value.frozen_database)||value.frozen_database===value.clone_database))fail('FRESH_FROZEN_DATABASE_REQUIRED');
 const plan={...value,source_migration_env:value.source_migration_env??'MIGRATION_DATABASE_URL',source_admin_env:value.source_admin_env??'BOOTSTRAP_DATABASE_URL',source_app_env:value.source_app_env??'DATABASE_URL'};
 if(![plan.source_migration_env,plan.source_admin_env,plan.source_app_env].every(envName))fail('DATABASE_ENV_SELECTOR_REQUIRED');
 for(const key of ['output_directory','source_report_file'])if(typeof plan[key]!=='string'||!plan[key])fail('DIAGNOSTIC_PATH_REQUIRED');
 return plan;
}
function binding(environment,name){const value=environment[name];if(!value)fail('DATABASE_BINDING_MISSING');const url=new URL(value);if(!['postgres:','postgresql:'].includes(url.protocol))fail('DATABASE_BINDING_INVALID');return url;}
function databaseBinding(url,name){const copy=new URL(url);copy.pathname='/'+name;return copy;}
function sameDatabase(a,b){return a.hostname===b.hostname&&a.port===b.port&&decodeURIComponent(a.pathname)===decodeURIComponent(b.pathname);}
function safeCode(error){return /^[A-Z0-9_]{1,100}$/.test(error?.code??'')?error.code:'DIAGNOSTIC_COPY_FAILED';}
async function privateWrite(path,value){const handle=await open(path,'wx',0o600);try{await handle.writeFile(typeof value==='string'?value:JSON.stringify(value,null,2)+'\n');await handle.sync();}finally{await handle.close();}}
async function transaction(client){await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await client.query("SET LOCAL TIME ZONE 'UTC'");await client.query("SET LOCAL DateStyle='ISO, YMD'");await client.query("SET LOCAL bytea_output='hex'");await client.query('SET LOCAL extra_float_digits=3');await client.query('SET LOCAL row_security=off');}

export async function fingerprintDatabase(client){
 const outside=await client.query("SELECT n.nspname FROM pg_namespace n WHERE n.nspname !~ '^pg_' AND n.nspname NOT IN ('public','information_schema') AND EXISTS(SELECT 1 FROM pg_class c WHERE c.relnamespace=n.oid AND c.relkind IN ('r','p'))");if(outside.rowCount)fail('UNREVIEWED_APPLICATION_SCHEMA');
 const relations=(await client.query(`SELECT c.relname AS name,c.relrowsecurity AS rls,c.relforcerowsecurity AS force_rls FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p') ORDER BY c.relname`)).rows;
 const tables=[];
 for(const relation of relations){const name='public.'+pg.escapeIdentifier(relation.name),row=(await client.query(`SELECT count(*)::text AS rows,encode(sha256(convert_to(COALESCE(string_agg(h,E'\\n' ORDER BY h),''),'UTF8')),'hex') AS row_sha256 FROM (SELECT encode(sha256(convert_to(to_jsonb(t)::text,'UTF8')),'hex') AS h FROM ${name} t) hashed_rows`)).rows[0];tables.push({...relation,...row});}
 const sequences=[];for(const row of(await client.query("SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='S' ORDER BY c.relname")).rows){const state=(await client.query('SELECT last_value::text,is_called FROM public.'+pg.escapeIdentifier(row.name))).rows[0];sequences.push({name:row.name,...state});}
 const warehouse_boundaries=(await client.query(`SELECT tenant_id,warehouse_id,version,(state->>'ledger_count') AS ledger_count FROM v2_workflow_state ORDER BY tenant_id,warehouse_id`)).rows;
 const ledger_boundaries=(await client.query(`SELECT l.tenant_id,l.warehouse_id,count(*)::text AS rows,min(l.created_at)::text AS first_at,max(l.created_at)::text AS last_at,max((r.response->>'version')::bigint)::text AS last_request_version FROM v2_workflow_ledger l JOIN v2_workflow_requests r ON r.tenant_id=l.tenant_id AND r.request_id=l.request_id GROUP BY l.tenant_id,l.warehouse_id ORDER BY l.tenant_id,l.warehouse_id`)).rows;
 const integration_boundaries=(await client.query(`SELECT tenant_id,warehouse_id,status,count(*)::text AS rows,max(sequence)::text AS max_sequence FROM v2_integration_events GROUP BY tenant_id,warehouse_id,status ORDER BY tenant_id,warehouse_id,status`)).rows;
 const migrations=(await client.query('SELECT name FROM pgmigrations ORDER BY id')).rows.map(row=>row.name);
 return {tables,sequences,warehouse_boundaries,ledger_boundaries,integration_boundaries,migrations,hash_definition:'Each row: SHA256(UTF8(to_jsonb(row)::text)); table: SHA256(sorted row hashes joined by LF), UTC/ISO/hex settings. Counts preserve duplicate multiplicity.'};
}
export function compareFingerprints(expected,actual,{after_migration=false}={}){
 const differences=[],byTable=new Map(actual.tables.map(row=>[row.name,row]));
 for(const table of expected.tables){if(after_migration&&table.name==='pgmigrations')continue;const found=byTable.get(table.name);if(!found||found.rows!==table.rows||found.row_sha256!==table.row_sha256||found.rls!==table.rls||found.force_rls!==table.force_rls)differences.push({kind:'table',name:table.name});}
 for(const table of actual.tables)if(!expected.tables.some(row=>row.name===table.name)&&!(after_migration&&table.name==='rateLimit'&&table.rows==='0'))differences.push({kind:'unexpected_table',name:table.name});
 for(const key of ['warehouse_boundaries','ledger_boundaries','integration_boundaries'])if(JSON.stringify(expected[key])!==JSON.stringify(actual[key]))differences.push({kind:key});
 const sequences=rows=>rows.filter(row=>!after_migration||row.name!=='pgmigrations_id_seq');if(JSON.stringify(sequences(expected.sequences))!==JSON.stringify(sequences(actual.sequences)))differences.push({kind:'sequences'});
 if(!after_migration&&JSON.stringify(expected.migrations)!==JSON.stringify(actual.migrations))differences.push({kind:'migrations'});
 return {passed:differences.length===0,differences};
}
async function dockerCommand(container,args,{file,input}={}){
 if(!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(container))fail('INVALID_CONTAINER');
 const handle=file?await open(file,'wx',0o600):null;
 try{const child=spawn('docker',['exec',...(input?['-i']:[]),container,...args],{stdio:[input?'pipe':'ignore',handle?handle.fd:'ignore','pipe']});child.stderr.resume();const done=new Promise((resolvePromise,reject)=>{child.on('error',()=>reject(Object.assign(new Error('POSTGRES_TOOL_FAILED'),{code:'POSTGRES_TOOL_FAILED'})));child.on('close',code=>code===0?resolvePromise():reject(Object.assign(new Error('POSTGRES_TOOL_FAILED'),{code:'POSTGRES_TOOL_FAILED'})));});if(input)await Promise.all([pipeline(createReadStream(input),child.stdin),done]);else await done;await handle?.sync();}finally{await handle?.close();}
}
async function archiveHash(path){const hash=createHash('sha256');for await(const chunk of createReadStream(path))hash.update(chunk);return hash.digest('hex');}

export async function executeDiagnosticCopy(configuration,environment=process.env){
 const plan=validateDiagnosticPlan(configuration),output=resolve(plan.output_directory);await mkdir(output,{recursive:false,mode:0o700});
 const report={run_id:plan.source_run_id,operation:'isolated_diagnostic_copy',status:'preparing',created_at:new Date().toISOString(),source_mutations_authorized:false,source_new_migrations_applied:false,clone_new_migrations_applied:false,source_credentials_recorded:false};let ctx,admin,clone,sourceBefore,sourceAfter;
 const reportPath=join(output,'report.json');
 try{
  if(plan.source_stopped!==true||!Number.isFinite(Date.parse(plan.source_stopped_at)))fail('SOURCE_STOP_CONFIRMATION_REQUIRED');
  const original=await readFile(resolve(plan.source_report_file));if(!/^[a-f0-9]{64}$/.test(plan.source_report_sha256??'')||sha(original)!==plan.source_report_sha256)fail('FAILED_RUN_REPORT_HASH_MISMATCH');
  const sourceReport=JSON.parse(original);if(sourceReport.run_id!==plan.source_run_id||sourceReport.verdict!=='failed')fail('FAILED_RUN_REPORT_REQUIRED');
  report.source_report_sha256=sha(original);
  const migration=binding(environment,plan.source_migration_env),app=binding(environment,plan.source_app_env),owner=binding(environment,plan.source_admin_env);
  if(!sameDatabase(owner,migration)||!sameDatabase(owner,app)||decodeURIComponent(migration.username)!=='wms_migrator'||decodeURIComponent(app.username)!=='wms_app')fail('SOURCE_BINDINGS_SCOPE_MISMATCH');
  const sourceName=decodeURIComponent(owner.pathname.slice(1));if(plan.clone_database===sourceName||plan.frozen_database===sourceName)fail('FRESH_DIAGNOSTIC_DATABASE_REQUIRED');report.source_database_sha256=sha(sourceName);report.clone_database_sha256=sha(plan.clone_database);
  ctx=await context(owner.href);
  const other=(await ctx.client.query('SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()')).rows[0].count;if(other!==0)fail('SOURCE_DATABASE_STILL_CONNECTED');
  await transaction(ctx.client);sourceBefore=await fingerprintDatabase(ctx.client);report.source_before=sourceBefore;if(plan.expected_source_migration_count!==sourceBefore.migrations.length)fail('SOURCE_MIGRATION_COUNT_CHANGED');
  const snapshot=(await ctx.client.query('SELECT pg_export_snapshot() AS snapshot')).rows[0].snapshot;
  const archive=join(output,'source.dump');await dockerCommand(ctx.container,['pg_dump','-U','postgres','-d',sourceName,'--format=custom','--snapshot='+snapshot],{file:archive});report.archive_sha256=await archiveHash(archive);report.archive_bytes=(await stat(archive)).size;await chmod(archive,0o400);report.archive_read_only=true;
  admin=new pg.Client({connectionString:databaseBinding(owner,'postgres').href,connectionTimeoutMillis:5000});await admin.connect();
  if(plan.frozen_database){
   await admin.query('CREATE DATABASE '+pg.escapeIdentifier(plan.frozen_database)+' TEMPLATE template0');report.frozen_created=true;report.frozen_database_sha256=sha(plan.frozen_database);
   await admin.query('REVOKE CONNECT ON DATABASE '+pg.escapeIdentifier(plan.frozen_database)+' FROM PUBLIC,wms_migrator,wms_app');
   await dockerCommand(ctx.container,['pg_restore','-U','postgres','-d',plan.frozen_database,'--exit-on-error','--single-transaction'],{input:archive});
   const frozen=new pg.Client({connectionString:databaseBinding(owner,plan.frozen_database).href,connectionTimeoutMillis:5000});
   try{await frozen.connect();await transaction(frozen);report.frozen_restored=await fingerprintDatabase(frozen);await frozen.query('COMMIT');report.frozen_copy_comparison=compareFingerprints(sourceBefore,report.frozen_restored);if(!report.frozen_copy_comparison.passed)fail('FROZEN_CONTENT_MISMATCH');}finally{await frozen.end().catch(()=>{});}
   await admin.query('ALTER DATABASE '+pg.escapeIdentifier(plan.frozen_database)+' ALLOW_CONNECTIONS false');report.frozen_connections_disabled=true;report.frozen_new_migrations_applied=false;
  }
  // CREATE is the existence guard. No DROP, CLEAN, TRUNCATE or source migration.
  await admin.query('CREATE DATABASE '+pg.escapeIdentifier(plan.clone_database)+' TEMPLATE template0');report.clone_created=true;
  await admin.query('REVOKE CONNECT ON DATABASE '+pg.escapeIdentifier(plan.clone_database)+' FROM PUBLIC');await admin.query('GRANT CONNECT ON DATABASE '+pg.escapeIdentifier(plan.clone_database)+' TO wms_migrator,wms_app');
  await dockerCommand(ctx.container,['pg_restore','-U','postgres','-d',plan.clone_database,'--exit-on-error','--single-transaction'],{input:archive});
  const cloneOwner=databaseBinding(owner,plan.clone_database);clone=new pg.Client({connectionString:cloneOwner.href,connectionTimeoutMillis:5000});await clone.connect();await transaction(clone);const restored=await fingerprintDatabase(clone);await clone.query('COMMIT');report.restored_before_migration=restored;report.copy_comparison=compareFingerprints(sourceBefore,restored);if(!report.copy_comparison.passed)fail('RESTORED_CONTENT_MISMATCH');
  await ctx.client.query('COMMIT');
  const cloneMigration=databaseBinding(migration,plan.clone_database),cloneApp=databaseBinding(app,plan.clone_database);
  if(plan.apply_migrations===true){const files=(await import('node:fs/promises')).readdir;const actualFiles=(await files(new URL('../db/migrations/',import.meta.url))).filter(name=>name.endsWith('.sql')).sort();if(plan.expected_migration_count!==19||actualFiles.length!==19)fail('MIGRATION_SET_REVIEW_REQUIRED');await migrate(cloneMigration.href,{log:()=>{}});report.clone_new_migrations_applied=true;await transaction(clone);const upgraded=await fingerprintDatabase(clone);await clone.query('COMMIT');report.clone_after_migration=upgraded;report.post_migration_content_comparison=compareFingerprints(sourceBefore,upgraded,{after_migration:true});if(upgraded.migrations.length!==19||!report.post_migration_content_comparison.passed)fail('MIGRATED_CONTENT_MISMATCH');}
  await privateWrite(join(output,'clone-bindings.env'),['DIAG_DATABASE_URL='+cloneApp.href,'DIAG_MIGRATION_DATABASE_URL='+cloneMigration.href,'DIAG_BOOTSTRAP_DATABASE_URL='+cloneOwner.href,''].join('\n'));
  await transaction(ctx.client);sourceAfter=await fingerprintDatabase(ctx.client);await ctx.client.query('COMMIT');report.source_after=sourceAfter;report.source_unchanged=compareFingerprints(sourceBefore,sourceAfter);if(!report.source_unchanged.passed)fail('SOURCE_CONTENT_CHANGED');
  report.status='copied_and_verified';report.completed_at=new Date().toISOString();await privateWrite(reportPath,report);return {status:report.status,run_id:plan.source_run_id,report:reportPath,clone_database_sha256:report.clone_database_sha256,source_unchanged:true,migrations_applied_to_clone_only:report.clone_new_migrations_applied};
 }catch(error){report.status='failed';report.failure_code=safeCode(error);report.completed_at=new Date().toISOString();await privateWrite(reportPath,report);throw Object.assign(new Error(report.failure_code),{code:report.failure_code,report:reportPath});}
 finally{await clone?.query('ROLLBACK').catch(()=>{});await ctx?.client.query('ROLLBACK').catch(()=>{});await clone?.end().catch(()=>{});await admin?.end().catch(()=>{});await ctx?.client.end().catch(()=>{});}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{const configuration=JSON.parse(await readFile(resolve(process.argv[2]??''),'utf8')),plan=validateDiagnosticPlan(configuration);if(process.argv[3]!=='--execute')console.log(JSON.stringify({status:'prepared_not_executed',run_id:plan.source_run_id,output_directory:resolve(plan.output_directory),database_connections:0,requires:'Root confirms source shutdown and exact failed report hash, then explicitly authorizes --execute.'}));else console.log(JSON.stringify(await executeDiagnosticCopy(plan)));}
 catch(error){console.error(JSON.stringify({status:'failed',code:safeCode(error),...(error.report?{report:error.report}:{})}));process.exitCode=1;}
}
