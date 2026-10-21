/** Isolated v2 million-ledger read benchmark. This script never builds or touches the configured application DB. */
import { randomUUID, createHash } from 'node:crypto';
import { cpus, totalmem, platform, release, tmpdir } from 'node:os';
import { readFile, writeFile, mkdir, readdir, stat, cp, mkdtemp, rm } from 'node:fs/promises';
import { dirname, resolve, join, basename } from 'node:path';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { hashPassword } from 'better-auth/crypto';
import { chromium, request as playwrightRequest, expect } from '@playwright/test';
import { migrate } from './db-migrate.mjs';
import {INVENTORY_PAGE_SIZE,INVENTORY_DISPLAY_PROFILE,verifyInventoryPagePreservation} from './v2-inventory-page-proof.mjs';

const args = new Set(process.argv.slice(2));
const reportPath = resolve(process.env.V2_PERF_REPORT ?? 'docs/v2-performance-latest.json');
const source = new URL(process.env.TEST_DATABASE_URL ?? '');
const configuredApplication = new URL(process.env.DATABASE_URL ?? '');
if (!['127.0.0.1','localhost','[::1]'].includes(source.hostname) || !decodeURIComponent(source.pathname).endsWith('_test')) throw new Error('A loopback TEST_DATABASE_URL ending in _test is required.');
if (decodeURIComponent(configuredApplication.username) !== 'wms_app' || !configuredApplication.password) throw new Error('The configured restricted application credential is required.');
const port = Number(process.env.V2_PERF_PORT ?? 3201);
const samples = Number(process.env.V2_PERF_SAMPLES ?? 100);
const concurrency = Number(process.env.V2_PERF_CONCURRENCY ?? 5);
const ledgerPerTenant = Number(process.env.V2_PERF_LEDGER_PER_TENANT ?? 500_000);
if (!Number.isInteger(port) || port < 1024 || port > 65535 || !Number.isInteger(samples) || samples < 20 || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 20 || !Number.isInteger(ledgerPerTenant) || ledgerPerTenant < 2000 || ledgerPerTenant % 20 !== 0 || ledgerPerTenant > 500_000) throw new Error('Invalid benchmark configuration.');
const stockLocations = 16; const stockSlots = 100 * stockLocations;
const baselinePath = resolve(process.env.V2_PERF_BASELINE ?? 'docs/v2-performance-baseline.json');
const origin = `http://127.0.0.1:${port}`;
const password = process.env.DEMO_PASSWORD;
if (!password || password.length < 12 || password.length > 128) throw new Error('DEMO_PASSWORD of 12–128 characters is required.');
const owner = new pg.Client({ connectionString: source.href });
let databaseClient, appPool, server, browser, ownedRuntime;
const contexts = [];
let report;
let phase = 'initialization';
const progress = value => console.log(`[v2-performance] ${value}`);
const displayMs = value => value === null || value === undefined ? 'n/a' : String(Math.round(value));
function failure(code) { const error = new Error(code); error.code = code; throw error; }
function databaseUrl(name, application = false) {
  const url = new URL(source);
  url.pathname = `/${name}`;
  if (application) { url.username = 'wms_app'; url.password = configuredApplication.password; }
  return url.href;
}
function summarize(values, targetMs = 2000, splitCompany = true) {
  const successful = values.filter(value => value.ok).map(value => value.ms).sort((a,b) => a-b);
  const p95 = successful.length ? successful[Math.ceil(successful.length * .95) - 1] : null;
  const result = { count: values.length, successful: successful.length, errors: values.length - successful.length, p50_ms: successful.length ? successful[Math.ceil(successful.length * .5) - 1] : null, p95_ms: p95, max_ms: successful.at(-1) ?? null, target_ms: targetMs, target_met: successful.length === values.length && successful.length > 0 && p95 <= targetMs, samples: values };
  if (splitCompany) {
    result.per_company = Object.fromEntries(['A','B'].map(company => [company, summarize(values.filter(value=>value.company===company),targetMs,false)]));
    result.target_met &&= Object.values(result.per_company).every(company=>company.target_met);
  }
  return result;
}
async function writeReport() { await mkdir(dirname(reportPath), { recursive: true }); await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n'); }
async function parallelSamples(count, workers, operation) {
  const result = Array(count); let next = 0, stopped = false; const failures = new Map();
  await Promise.all(Array.from({length: workers}, async () => {
    while (!stopped) {
      const index = next++; if (index >= count) return; const value = await operation(index); result[index] = value;
      if (!value.ok) { const signature = `${value.status ?? 0}:${value.code}`; const repeated = (failures.get(signature) ?? 0)+1; failures.set(signature,repeated); if(repeated>=3)stopped=true; }
    }
  }));
  return result.filter(Boolean);
}
async function warmupSamples(operation) {
  const values=[];const failures=new Map();
  for(let index=0;index<4;index++) {
    const value=await operation(index);values.push(value);
    if(!value.ok){const signature=`${value.status??0}:${value.code}`;const repeated=(failures.get(signature)??0)+1;failures.set(signature,repeated);if(repeated>=3)return {values,failed:true};}
  }
  return {values,failed:false};
}
async function exportBaselineManifest() {
  if (!databaseClient) { databaseClient = new pg.Client({connectionString:databaseUrl(report.fixture.database)});await databaseClient.connect(); }
  const manifest={schema_version:'1.0',run_id:report.run_id,seed:report.fixture.seed,generated_at:report.started_at,source:'Expected quantities are calculated solely from the fixture generator. Only item/location reference identifiers and labels are read; no WMS stock quantity or ledger sum is used to create expectations.',generator:{ledger_per_tenant:report.fixture.ledger_per_tenant,item_index:'(g-1)%100',storage_location_index:'floor((g-1)/100)%16',delta:'S +1 for each g from 1 through ledger_per_tenant',request_rows:20},tenants:[]};
  for(const tenant of report.fixture.tenants) {
    const items=(await databaseClient.query('SELECT id,code,name FROM items WHERE tenant_id=$1 ORDER BY code',[tenant.id])).rows;
    const locations=(await databaseClient.query('SELECT id,code,name,kind,priority FROM locations WHERE tenant_id=$1 AND warehouse_id=$2 ORDER BY code',[tenant.id,tenant.warehouse_id])).rows;
    const storage=locations.filter(location=>location.kind==='STORAGE');
    if(items.length!==100||locations.length!==20||storage.length!==stockLocations)failure('BASELINE_CATALOG_MISMATCH');
    const base=Math.floor(report.fixture.ledger_per_tenant/stockSlots),remainder=report.fixture.ledger_per_tenant%stockSlots;
    const expected_positions=storage.flatMap((location,locationIndex)=>items.map((item,itemIndex)=>({item_id:item.id,location_id:location.id,S:base+(locationIndex*100+itemIndex<remainder?1:0),R:0,P:0,Q:0,B:0})));
    manifest.tenants.push({...tenant,items,locations,expected_positions,expected_totals:{S:report.fixture.ledger_per_tenant,R:0,P:0,Q:0,B:0,H:report.fixture.ledger_per_tenant,A:report.fixture.ledger_per_tenant},expected_item_totals:items.map(item=>({item_id:item.id,quantity:expected_positions.filter(position=>position.item_id===item.id).reduce((sum,position)=>sum+position.S,0)}))});
  }
  const serialized=JSON.stringify(manifest,null,2)+'\n';await mkdir(dirname(baselinePath),{recursive:true});await writeFile(baselinePath,serialized);report.baseline_manifest=baselinePath;report.baseline_manifest_sha256=createHash('sha256').update(serialized).digest('hex');
}

async function fixtureOwnership() {
  const name = report?.fixture?.database;
  if (!/^wms_v2_perf_[a-f0-9]{32}_test$/.test(name ?? '')) failure('INVALID_FIXTURE_DATABASE');
  const row = (await owner.query("SELECT shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=$1", [name])).rows[0];
  if (row?.marker !== `wms-v2-performance:${report.run_id}`) failure('FIXTURE_OWNERSHIP_MISMATCH');
}
async function grantApplicationAccess() {
  // Match db-bootstrap --grant inside this owned fixture, without changing role or table ownership.
  await fixtureOwnership();
  const mutable = ['v2_workflow_state','v2_workflow_state_header','v2_workflow_stock','v2_workflow_objects','v2_identity_links','v2_machine_keys','business_partners','master_barcodes','master_csv_previews','v2_integration_limits','v2_integration_entities','v2_integration_events'];
  const appendOnly = ['v2_workflow_requests','v2_workflow_performances','v2_workflow_receivings','v2_workflow_ledger','v2_identity_audit','master_csv_applies','master_csv_applied_rows','v2_cutovers','api_request_metrics','v2_opening_imports'];
  const grants = ['v2_warehouse_grants','v2_machine_warehouses','v2_workflow_object_state'];
  await databaseClient.query('GRANT USAGE ON SCHEMA public TO wms_app');
  await databaseClient.query('GRANT SELECT,INSERT,UPDATE ON delivery_destinations,stock_balances TO wms_app');
  await databaseClient.query('GRANT SELECT,INSERT,UPDATE,DELETE ON "user",session,account,verification,items,warehouses,locations,inventory_documents,inventory_document_lines TO wms_app');
  await databaseClient.query('GRANT SELECT,INSERT ON stock_ledger,idempotency_requests,audit_logs TO wms_app');
  await databaseClient.query('GRANT SELECT ON tenants,memberships TO wms_app');
  await databaseClient.query('GRANT UPDATE(idle_lock_minutes) ON tenants TO wms_app');
  await databaseClient.query('GRANT INSERT(user_id,tenant_id,role,status),UPDATE(role,status,updated_at) ON memberships TO wms_app');
  for (const [tables,permissions] of [[mutable,'SELECT,INSERT,UPDATE'],[appendOnly,'SELECT,INSERT'],[grants,'SELECT,INSERT,UPDATE,DELETE']]) {
    for (const table of tables) await databaseClient.query(`GRANT ${permissions} ON ${pg.escapeIdentifier(table)} TO wms_app`);
  }
  await databaseClient.query('GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO wms_app');
  report.fixture.application_grants = 'Normal db-bootstrap --grant permissions, applied only to this owned fixture; role and table ownership unchanged.';
}
async function verifyPreservedFixture() {
  const serialized=await readFile(baselinePath,'utf8');
  if(createHash('sha256').update(serialized).digest('hex')!==report.baseline_manifest_sha256)failure('BASELINE_MANIFEST_CHANGED');
  const baseline=JSON.parse(serialized);
  if(baseline.run_id!==report.run_id)failure('BASELINE_RUN_MISMATCH');
  const ledger=(await databaseClient.query(`SELECT tenant_id,count(*)::integer AS ledger_rows,sum(delta)::text AS physical_quantity,
    count(*) FILTER(WHERE command<>'READ_PERFORMANCE_FIXTURE' OR bucket<>'S' OR delta<>1)::integer AS unexpected_rows
    FROM v2_workflow_ledger GROUP BY tenant_id ORDER BY tenant_id`)).rows;
  if(ledger.length!==2||ledger.some(row=>row.ledger_rows!==report.fixture.ledger_per_tenant||Number(row.physical_quantity)!==report.fixture.ledger_per_tenant||row.unexpected_rows!==0))failure('PRESERVED_LEDGER_CHANGED');
  for(const tenant of baseline.tenants){
    const stocks=(await databaseClient.query('SELECT item_id,location_id,s,r,p,q,b FROM v2_workflow_stock WHERE tenant_id=$1 AND warehouse_id=$2',[tenant.id,tenant.warehouse_id])).rows;
    const expected=new Map(tenant.expected_positions.map(row=>[row.item_id+':'+row.location_id,row]));
    if(stocks.length!==expected.size||stocks.some(row=>{const wanted=expected.get(row.item_id+':'+row.location_id);return !wanted||['S','R','P','Q','B'].some(bucket=>Number(row[bucket.toLowerCase()])!==wanted[bucket]);}))failure('PRESERVED_STOCK_CHANGED');
    const state=(await databaseClient.query('SELECT version,state FROM v2_workflow_state WHERE tenant_id=$1 AND warehouse_id=$2',[tenant.id,tenant.warehouse_id])).rows[0];
    if(!state||state.version!==report.fixture.ledger_per_tenant/20||['receipts','orders','packages','shipments','returns','approvals','counts','tasks','shifts'].some(key=>state.state[key]?.length))failure('PRESERVED_WORKFLOW_CHANGED');
  }
  report.fixture.reverification={at:new Date().toISOString(),baseline_manifest_sha256:report.baseline_manifest_sha256,actual_counts:ledger,stock_matches_independent_manifest:true,physical_workflow_unchanged:true};
}
async function prepare() {
  const runId = randomUUID(); const name = `wms_v2_perf_${runId.replaceAll('-','')}_test`;
  report = { schema_version: '1.0', run_id: runId, started_at: new Date().toISOString(), phase: 'preparing', requirement_ids: ['INV-01','OPS-01','SIM-03'], proposal: 'WMS 현장 운영 고도화 기획서 v1.1 13장 조회 누적량', fixture: { database: name, seed: 'v2-million-ledger-2026-10-20-v2', tenants: [], ledger_per_tenant: ledgerPerTenant, total_ledger: ledgerPerTenant * 2, items_per_tenant: 100, locations_per_tenant: 20, balances_per_tenant: stockSlots, location_kinds: {STORAGE:16,RECEIVING:1,STAGING:1,SHIPPING:1,HOLD:1}, full_million_profile: ledgerPerTenant === 500_000, loading_method: 'Direct SQL in a disposable local test database, permitted only for accumulated-query performance. Not evidence that receiving/inspection business workflows passed.' }, method: { production_build: 'Prebuilt .next; benchmark does not build', client_location: 'same local container over loopback HTTP/TCP', concurrency, measured_samples_per_endpoint: samples, warmups_per_tenant_per_endpoint: 2, browser_samples: 20, browser_warmups_per_tenant: 1, statistic: 'nearest-rank p95 over successful samples; any unexpected error makes the metric fail', api_target_ms: 2000, browser_target_ms: 2000, database_target_ms: 2000, exclusions: ['database creation','fixture generation','ANALYZE','server startup','login','explicit warmups'], read_write_ratio: '100% reads during this benchmark; real shift writes must be measured separately under this accumulated history' }, machine: { platform: `${platform()} ${release()}`, cpu: cpus()[0]?.model, logical_cpus: cpus().length, ram_bytes: totalmem(), node: process.version }, db: {}, api: {}, browser: {}, not_executed: ['8-hour shift workload under accumulated history','5400-unique-event congestion profile','scan/confirmation p95 under normal shift','external event acceptance/application latency','deployed-environment and real-device measurements','RPO/RTO restore trial'] };
  phase = 'create restricted fixture role';
  await owner.query("SELECT pg_advisory_lock(hashtext('wms-v2-performance-role-bootstrap'))");
  try {
    const role = (await owner.query("SELECT rolsuper,rolbypassrls,rolcanlogin FROM pg_roles WHERE rolname='wms_app'")).rows[0];
    if (role && (role.rolsuper || role.rolbypassrls || !role.rolcanlogin)) failure('APPLICATION_ROLE_NOT_RESTRICTED');
    if (!role) {
      await owner.query(`CREATE ROLE wms_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD ${pg.escapeLiteral(decodeURIComponent(configuredApplication.password))}`);
      report.fixture.created_application_role = true;
    } else report.fixture.created_application_role = false;
  } finally { await owner.query("SELECT pg_advisory_unlock(hashtext('wms-v2-performance-role-bootstrap'))"); }
  phase = 'create isolated fixture database';
  await owner.query(`CREATE DATABASE ${pg.escapeIdentifier(name)}`);
  await owner.query(`COMMENT ON DATABASE ${pg.escapeIdentifier(name)} IS ${pg.escapeLiteral(`wms-v2-performance:${runId}`)}`);
  await fixtureOwnership();
  phase = 'migrate isolated fixture database';
  await migrate(databaseUrl(name), { log: () => {} });
  databaseClient = new pg.Client({ connectionString: databaseUrl(name) }); await databaseClient.connect();
  await grantApplicationAccess();
  const hashedPassword = await hashPassword(password);
  for (const company of ['A','B']) {
    phase = `seed company ${company}`; const start = performance.now();
    const tenant = { company, id: randomUUID(), user_id: randomUUID(), warehouse_id: randomUUID(), partner_id: randomUUID(), destination_id: randomUUID(), email: `v2-perf-${runId}-${company.toLowerCase()}@example.test` };
    await databaseClient.query('BEGIN');
    try {
      await databaseClient.query("SELECT set_config('app.tenant_id',$1,true)", [tenant.id]);
      await databaseClient.query("INSERT INTO tenants(id,name,is_test) VALUES($1,$2,true)", [tenant.id, `Performance company ${company}`]);
      await databaseClient.query('INSERT INTO "user"(id,name,email,"emailVerified") VALUES($1,$2,$3,true)', [tenant.user_id, `Performance operator ${company}`, tenant.email]);
      await databaseClient.query("INSERT INTO account(id,\"accountId\",\"providerId\",\"userId\",password) VALUES($1,$2,'credential',$2,$3)", [randomUUID(), tenant.user_id, hashedPassword]);
      await databaseClient.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'admin')", [tenant.id,tenant.user_id]);
      await databaseClient.query("INSERT INTO warehouses(id,tenant_id,code,name) VALUES($1,$2,'PERF','Performance warehouse')", [tenant.warehouse_id,tenant.id]);
      await databaseClient.query('INSERT INTO v2_warehouse_grants(tenant_id,user_id,warehouse_id) VALUES($1,$2,$3)', [tenant.id,tenant.user_id,tenant.warehouse_id]);
      await databaseClient.query("INSERT INTO business_partners(id,tenant_id,code,name,supplier,customer) VALUES($1,$2,'PERF-PARTNER','Performance counterparty',true,true)",[tenant.partner_id,tenant.id]);
      await databaseClient.query("INSERT INTO delivery_destinations(id,tenant_id,partner_id,recipient_name,name,address_line1) VALUES($1,$2,$3,'Performance recipient','Performance destination','Synthetic benchmark address')",[tenant.destination_id,tenant.id,tenant.partner_id]);
      await databaseClient.query('CREATE TEMP TABLE perf_items ON COMMIT DROP AS SELECT n,gen_random_uuid() id FROM generate_series(1,100) n');
      await databaseClient.query('CREATE TEMP TABLE perf_locations ON COMMIT DROP AS SELECT n,gen_random_uuid() id FROM generate_series(1,20) n');
      await databaseClient.query('CREATE TEMP TABLE perf_requests ON COMMIT DROP AS SELECT n,gen_random_uuid() id FROM generate_series(1,$1::integer) n', [ledgerPerTenant / 20]);
      await databaseClient.query("INSERT INTO items(id,tenant_id,code,name) SELECT id,$1,'SKU-'||lpad(n::text,3,'0'),'Performance item '||n FROM perf_items", [tenant.id]);
      await databaseClient.query("INSERT INTO locations(id,tenant_id,warehouse_id,code,name,kind,priority) SELECT id,$1,$2,'LOC-'||lpad(n::text,2,'0'),'Performance location '||n,CASE WHEN n<=16 THEN 'STORAGE' WHEN n=17 THEN 'RECEIVING' WHEN n=18 THEN 'STAGING' WHEN n=19 THEN 'SHIPPING' ELSE 'HOLD' END,n FROM perf_locations", [tenant.id,tenant.warehouse_id]);
      const initial = {version: ledgerPerTenant/20,stock:[],receipts:[],orders:[],packages:[],shipments:[],returns:[],approvals:[],counts:[],tasks:[],shifts:[],ledger:[],receiving_ids:[],holds:[],location_blocks:[],ledger_count:ledgerPerTenant};
      await databaseClient.query('INSERT INTO v2_workflow_state(tenant_id,warehouse_id,version,state) VALUES($1,$2,$3,$4::jsonb)', [tenant.id,tenant.warehouse_id,ledgerPerTenant/20,JSON.stringify(initial)]);
      await databaseClient.query('INSERT INTO v2_workflow_stock(tenant_id,warehouse_id,item_id,location_id,s) SELECT $1,$2,i.id,l.id,($3::integer/1600)+CASE WHEN (l.n-1)*100+i.n<=($3::integer%1600) THEN 1 ELSE 0 END FROM perf_items i CROSS JOIN perf_locations l WHERE l.n<=16', [tenant.id,tenant.warehouse_id,ledgerPerTenant]);
      await databaseClient.query(`UPDATE v2_workflow_state SET state=state||jsonb_build_object('stock',x.rows,'ledger_base',x.rows) FROM (SELECT jsonb_agg(jsonb_build_object('item_id',item_id,'location_id',location_id,'S',s,'R',r,'P',p,'Q',q,'B',b) ORDER BY item_id,location_id) rows FROM v2_workflow_stock WHERE tenant_id=$1 AND warehouse_id=$2) x WHERE tenant_id=$1 AND warehouse_id=$2`, [tenant.id,tenant.warehouse_id]);
      await databaseClient.query("INSERT INTO v2_workflow_requests(tenant_id,warehouse_id,request_id,request_hash,command,actor_id,response) SELECT $1,$2,id,repeat('0',64),'READ_PERFORMANCE_FIXTURE',$3,jsonb_build_object('result',jsonb_build_object('fixture',true),'version',n) FROM perf_requests", [tenant.id,tenant.warehouse_id,tenant.user_id]);
      await databaseClient.query(`INSERT INTO v2_workflow_ledger(id,tenant_id,warehouse_id,item_id,location_id,request_id,actor_id,command,bucket,delta,reason,created_at)
        SELECT gen_random_uuid(),$1,$2,i.id,l.id,r.id,$3,'READ_PERFORMANCE_FIXTURE','S',1,'Direct SQL accumulated-query fixture only',TIMESTAMPTZ '2026-10-01 00:00:00+00'+g*INTERVAL '1 millisecond'
        FROM generate_series(1,$4::integer) g JOIN perf_items i ON i.n=(g-1)%100+1 JOIN perf_locations l ON l.n=((g-1)/100)%16+1 JOIN perf_requests r ON r.n=(g-1)/20+1`, [tenant.id,tenant.warehouse_id,tenant.user_id,ledgerPerTenant]);
      tenant.first_item_id = (await databaseClient.query('SELECT id FROM perf_items ORDER BY n LIMIT 1')).rows[0].id;
      await databaseClient.query('COMMIT');
    } catch (error) { await databaseClient.query('ROLLBACK'); throw error; }
    report.fixture.tenants.push(tenant); progress(`company ${company}: ${ledgerPerTenant} ledger rows prepared in ${Math.round(performance.now()-start)} ms`);
    await writeReport();
  }
  phase = 'verify fixture and refresh statistics';
  report.fixture.actual_counts = (await databaseClient.query('SELECT tenant_id,count(*)::integer AS ledger_rows,sum(delta)::text AS physical_quantity FROM v2_workflow_ledger GROUP BY tenant_id ORDER BY tenant_id')).rows;
  if (report.fixture.actual_counts.length !== 2 || report.fixture.actual_counts.some(row => row.ledger_rows !== ledgerPerTenant || Number(row.physical_quantity) !== ledgerPerTenant)) failure('FIXTURE_COUNT_MISMATCH');
  for (const table of ['items','locations','memberships','v2_warehouse_grants','v2_workflow_state','v2_workflow_state_header','v2_workflow_stock','v2_workflow_requests','v2_workflow_ledger']) await databaseClient.query(`ANALYZE ${table}`);
  report.fixture.planner_statistics = 'ANALYZE after complete fixture seed';
  report.fixture.database_bytes = Number((await databaseClient.query('SELECT pg_database_size(current_database())::text AS bytes')).rows[0].bytes);
  report.machine.postgresql = (await databaseClient.query('SHOW server_version')).rows[0].server_version;
  report.machine.postgresql_settings = (await databaseClient.query("SELECT name,setting,unit FROM pg_settings WHERE name=ANY($1) ORDER BY name", [['shared_buffers','work_mem','effective_cache_size','max_connections','max_parallel_workers_per_gather']])).rows;
  for (const file of ['memory.max','cpu.max']) { try { report.machine[file] = (await readFile(`/sys/fs/cgroup/${file}`,'utf8')).trim(); } catch { report.machine[file] = 'unavailable'; } }
  report.source = {};
  for (const file of ['src/server/v2/workflow/index.ts','src/server/v2/workflow/engine.ts','db/migrations/1792368000010_v2-workflow.sql']) report.source[file] = createHash('sha256').update(await readFile(file)).digest('hex');
  await exportBaselineManifest();
  report.phase = 'prepared'; report.prepared_at = new Date().toISOString(); await writeReport();
}
const queryDefinitions = {
  latest_ledger_100: { sql: 'SELECT id,item_id,location_id,bucket,delta,request_id,actor_id,command,reason,original_id,created_at FROM v2_workflow_ledger WHERE tenant_id=$1 AND warehouse_id=$2 ORDER BY created_at DESC,id DESC LIMIT 100', expected: 100 },
  stock_rows: { sql: 'SELECT item_id,location_id,s,r,p,q,b FROM v2_workflow_stock WHERE tenant_id=$1 AND warehouse_id=$2', expected: stockSlots },
  reconcile_ledger: { sql: `WITH l AS(SELECT item_id,location_id,COALESCE(sum(delta) FILTER(WHERE bucket='S'),0) s,COALESCE(sum(delta) FILTER(WHERE bucket='R'),0) r,COALESCE(sum(delta) FILTER(WHERE bucket='P'),0) p,COALESCE(sum(delta) FILTER(WHERE bucket='Q'),0) q,COALESCE(sum(delta) FILTER(WHERE bucket='B'),0) b FROM v2_workflow_ledger WHERE tenant_id=$1 AND warehouse_id=$2 GROUP BY item_id,location_id) SELECT count(*)::int AS differences FROM(SELECT * FROM v2_workflow_stock WHERE tenant_id=$1 AND warehouse_id=$2) s FULL JOIN l USING(item_id,location_id) WHERE COALESCE(s.s,0)<>COALESCE(l.s,0) OR COALESCE(s.r,0)<>COALESCE(l.r,0) OR COALESCE(s.p,0)<>COALESCE(l.p,0) OR COALESCE(s.q,0)<>COALESCE(l.q,0) OR COALESCE(s.b,0)<>COALESCE(l.b,0)`, expected: 1, reconciliation: true },
};
async function querySample(definition, index, explain = false) {
  const tenant = report.fixture.tenants[index % 2]; const started = performance.now(); let client;
  try {
    client = await appPool.connect(); const poolWait = performance.now() - started;
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.tenant_id',$1,true),set_config('app.user_id',$2,true),set_config('app.environment','test',true)", [tenant.id,tenant.user_id]);
    const queryStart = performance.now(); const result = await client.query(`${explain ? 'EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ' : ''}${definition.sql}`, [tenant.id,tenant.warehouse_id]);
    const ms = performance.now() - queryStart;
    if (explain) return { ok: true, company: tenant.company, ms, plan: result.rows[0]['QUERY PLAN'] };
    if (result.rowCount !== definition.expected || definition.reconciliation && result.rows[0].differences !== 0) failure('QUERY_RESULT_MISMATCH');
    return { ok: true, company: tenant.company, ms, pool_wait_ms: poolWait, rows: result.rowCount };
  } catch (error) { return { ok: false, company: tenant.company, ms: performance.now()-started, code: String(error.code ?? error.name) }; }
  finally { if(client) { await client.query('ROLLBACK').catch(()=>{}); client.release(); } }
}
async function measureDatabase() {
  phase = 'apply any newly completed additive migrations to owned fixture';
  await migrate(databaseUrl(report.fixture.database), { log: () => {} });
  if (!databaseClient) { databaseClient = new pg.Client({ connectionString: databaseUrl(report.fixture.database) }); await databaseClient.connect(); }
  await verifyPreservedFixture();
  await grantApplicationAccess();
  report.migrations = (await databaseClient.query('SELECT name FROM pgmigrations ORDER BY id')).rows.map(row => row.name);
  report.measured_source = {};
  for (const file of Object.keys(report.source)) report.measured_source[file] = createHash('sha256').update(await readFile(file)).digest('hex');
  report.measurement_source = {};
  for (const file of ['scripts/v2-performance.mjs','scripts/v2-inventory-page-proof.mjs','src/app/dashboard/v2/inventory-ui.tsx','src/app/dashboard/v2/v2.css']) report.measurement_source[file] = createHash('sha256').update(await readFile(file)).digest('hex');
  report.method.concurrent_other_workloads = process.env.V2_PERF_COMPETING_WORKLOADS ?? 'Not declared; do not infer exclusive-host conditions.';
  report.method.read_write_ratio = '100% business/API GET reads; ordinary request telemetry and auth session maintenance can write their own rows. Physical inventory and business documents are unchanged.';
  report.measurement_started_at = new Date().toISOString();
  await exportBaselineManifest();
  phase = 'restricted-role database measurements';
  appPool = new pg.Pool({ connectionString: databaseUrl(report.fixture.database,true), max: concurrency, statement_timeout: 3000 });
  const flags = (await appPool.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];
  if (flags.rolsuper || flags.rolbypassrls) failure('APPLICATION_ROLE_NOT_RESTRICTED');
  report.method.database_role = { name: 'wms_app', ...flags, rls: 'FORCE RLS with tenant, authenticated user and explicit warehouse grant context' };
  for (const [name, definition] of Object.entries(queryDefinitions)) {
    const warmups=await warmupSamples(index=>querySample(definition,index));
    report.db[name] = summarize(warmups.failed?[]:await parallelSamples(samples,concurrency,index=>querySample(definition,index)));
    report.db[name].warmups = warmups.values;report.db[name].requested_measured_samples=samples;report.db[name].early_stopped=warmups.failed||report.db[name].count<samples;
    report.db[name].explain = await querySample(definition,0,true);
    progress(`DB ${name}: p95=${displayMs(report.db[name].p95_ms)} ms, errors=${report.db[name].errors}`); await writeReport();
  }
}
async function prepareRuntime() {
  phase='prepare independent prebuilt runtime';
  const candidate=report.runtime?.path;
  const requestedBuild=args.has('--prepare-runtime-only')?(await readFile('.next/BUILD_ID','utf8')).trim():null;
  const candidateOwned=typeof candidate==='string'&&dirname(candidate)===tmpdir()&&basename(candidate).startsWith('wms-v2-performance-')&&!report.runtime.cleaned&&(await readFile(join(candidate,'benchmark-run-id'),'utf8').catch(()=>null))===report.run_id;
  if(candidateOwned&&(!requestedBuild||report.runtime.build_id===requestedBuild)) {
    ownedRuntime=candidate;report.build_id=report.runtime.build_id;return;
  }
  if(candidateOwned)await rm(candidate,{recursive:true,force:true});
  report.build_id=(await readFile('.next/BUILD_ID','utf8')).trim();
  const built=await stat('.next/BUILD_ID');let latestSource=0;
  for(const entry of await readdir('src',{recursive:true,withFileTypes:true}))if(entry.isFile())latestSource=Math.max(latestSource,(await stat(join(entry.parentPath,entry.name))).mtimeMs);
  report.build_timestamps={build_id_written_at:built.mtime.toISOString(),latest_source_modified_at:new Date(latestSource).toISOString(),source_changed_after_build:latestSource>built.mtimeMs,scope:'Measurements apply to this prebuilt BUILD_ID; later source changes require a new run.'};
  report.build_artifact_sha256={};
  for(const file of ['.next/BUILD_ID','.next/build-manifest.json','.next/server/app/api/v2/workflow/route.js','.next/server/app/dashboard/v2/page.js']) {
    try{report.build_artifact_sha256[file]=createHash('sha256').update(await readFile(file)).digest('hex');}catch{report.build_artifact_sha256[file]='unavailable';}
  }
  if(await stat('.next/standalone/server.js').then(()=>true).catch(()=>false)) {
    ownedRuntime=await mkdtemp(join(tmpdir(),'wms-v2-performance-'));
    await cp('.next/standalone',ownedRuntime,{recursive:true});await mkdir(join(ownedRuntime,'.next'),{recursive:true});
    await cp('.next/static',join(ownedRuntime,'.next/static'),{recursive:true});
    if(await stat('public').then(()=>true).catch(()=>false))await cp('public',join(ownedRuntime,'public'),{recursive:true});
    await writeFile(join(ownedRuntime,'benchmark-run-id'),report.run_id);
    report.runtime={kind:'independent standalone copy',path:ownedRuntime,build_id:report.build_id,prepared_at:new Date().toISOString()};
  } else {
    if(args.has('--prepare-runtime-only'))failure('STANDALONE_BUILD_REQUIRED');
    report.runtime={kind:'shared prebuilt .next; concurrent builds prohibited',build_id:report.build_id};
  }
  await writeReport();
}
async function startServer() {
  await prepareRuntime();phase='start owned isolated API server';
  try{await fetch(`${origin}/api/health`);failure('BENCHMARK_PORT_OCCUPIED');}catch(error){if(error.code==='BENCHMARK_PORT_OCCUPIED')throw error;}
  const serverEnvironment={PATH:process.env.PATH,NODE_ENV:'production',DATABASE_URL:databaseUrl(report.fixture.database,true),BETTER_AUTH_SECRET:process.env.BETTER_AUTH_SECRET,BETTER_AUTH_URL:origin,WMS_ENVIRONMENT:'test',WMS_TIMING_DIAGNOSTICS:'0',PORT:String(port),HOSTNAME:'127.0.0.1'};
  server=ownedRuntime?spawn(process.execPath,[join(ownedRuntime,'server.js')],{cwd:ownedRuntime,env:serverEnvironment,stdio:['ignore','ignore','ignore']}):spawn(process.execPath,['node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','--port',String(port)],{cwd:process.cwd(),env:serverEnvironment,stdio:['ignore','ignore','ignore']});
  let ready=false;
  for(let index=0;index<120;index++){if(server.exitCode!==null)failure('BENCHMARK_SERVER_EXITED');try{if((await fetch(`${origin}/api/ready`)).ok){ready=true;break;}}catch{}await delay(500);}
  if(!ready)failure('BENCHMARK_SERVER_NOT_READY');
  for(const tenant of report.fixture.tenants){
    const context=await playwrightRequest.newContext({baseURL:origin});contexts.push(context);
    const login=await context.post('/api/auth/sign-in/email',{headers:{origin},data:{email:tenant.email,password}});
    if(!login.ok())failure(`FIXTURE_LOGIN_HTTP_${login.status()}`);
    const me=await(await context.get('/api/me')).json();if(me.tenant?.id!==tenant.id)failure('FIXTURE_AUTH_TENANT_MISMATCH');
  }
}
async function measureApi() {
  phase = 'real authenticated API measurements';
  const endpoints = {
    workflow_snapshot: tenant=>`/api/v2/workflow?warehouse_id=${tenant.warehouse_id}`,
    ledger_page_100: tenant=>`/api/v2/workflow/ledger?warehouse_id=${tenant.warehouse_id}&limit=100`,
    ledger_filtered_100: tenant=>`/api/v2/workflow/ledger?warehouse_id=${tenant.warehouse_id}&item_id=${tenant.first_item_id}&limit=100`,
  };
  for(const [name,path] of Object.entries(endpoints)) {
    const sample = async index => {
      const company=index%2, tenant=report.fixture.tenants[company], start=performance.now();
      try {
        const response=await contexts[company].get(path(tenant));const data=await response.json();const ms=performance.now()-start;
        if(!response.ok())return {ok:false,company:tenant.company,ms,status:response.status(),code:typeof data.error==='string'?data.error:'API_ERROR'};
        if(name==='workflow_snapshot') {
          if(data.snapshot.stock.length!==report.fixture.balances_per_tenant||!data.snapshot.reconciliation?.ok||data.snapshot.stock.reduce((sum,row)=>sum+row.H,0)!==report.fixture.ledger_per_tenant)failure('API_SNAPSHOT_MISMATCH');
        } else if(data.rows?.length!==(name==='ledger_filtered_100'?Math.min(100,Math.ceil(report.fixture.ledger_per_tenant/100)):100)||data.warehouse_id!==tenant.warehouse_id)failure('API_LEDGER_MISMATCH');
        return {ok:true,company:tenant.company,ms,status:response.status(),rows:name==='workflow_snapshot'?data.snapshot.stock.length:data.rows.length};
      } catch(error){return {ok:false,company:tenant.company,ms:performance.now()-start,code:String(error.code??error.name)};}
    };
    const warmups=await warmupSamples(sample);
    report.api[name]=summarize(warmups.failed?[]:await parallelSamples(samples,concurrency,sample));report.api[name].warmups=warmups.values;report.api[name].requested_measured_samples=samples;report.api[name].early_stopped=warmups.failed||report.api[name].count<samples;progress(`API ${name}: p95=${displayMs(report.api[name].p95_ms)} ms, errors=${report.api[name].errors}`);await writeReport();
  }
  const denied=await contexts[0].get(`/api/v2/workflow?warehouse_id=${report.fixture.tenants[1].warehouse_id}`);
  report.isolation_probe={status:denied.status(),passed:denied.status()===403};if(!report.isolation_probe.passed)failure('CROSS_TENANT_EXPOSURE');
}
function inventoryDisplayContract(){
 report.measurement_profile=INVENTORY_DISPLAY_PROFILE;
 report.method.server_timing_diagnostics='Explicitly disabled during acceptance measurements; opt-in diagnostics require a separate diagnostic runtime.';
 report.method.exclusions=[...new Set([...report.method.exclusions,'post-measurement independent inventory preservation proof'])];
 report.method.required_qualification={samples_per_endpoint:100,concurrency:5,browser_samples:20,browser_samples_per_company:10,browser_target_ms:2000,inventory_preservation_required:true};
 report.method.inventory_display={profile:INVENTORY_DISPLAY_PROFILE,total_positions_per_company:stockSlots,first_page_rows:INVENTORY_PAGE_SIZE,complete_pages_per_company:stockSlots/INVENTORY_PAGE_SIZE,first_page_timing:'Navigation through first100rows plus two animation frames; total1600/page0/page-size100 are checked in every sample.',independent_preservation:'After timed samples: both companies traverse16pages and compare all1600keys,7bucket values,global totals,full CSV,full-scope search and last-page traces with the independent manifest.',comparison:'Display condition changed from the preserved1600-simultaneous-DOM profile. Earlier pass/failure is retained separately;2s/company/sample counts/1Mledger/API scope are unchanged.'};
}
async function measureBrowser() {
  phase='browser first-page data-display measurements';inventoryDisplayContract();
  const executablePath=process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || (await stat('/usr/bin/chromium').then(()=>'/usr/bin/chromium').catch(()=>undefined));
  browser=await chromium.launch({executablePath});report.machine.chromium=browser.version();
  const values=[],warmups=[];let failures=0;
  for(let company=0;company<2&&failures<3;company++) {
    const context=await browser.newContext({baseURL:origin,storageState:await contexts[company].storageState(),viewport:{width:1280,height:900}});const page=await context.newPage();
    for(let index=0;index<11&&failures<3;index++) {
      const start=performance.now();
      try {
        const navigation=await page.goto('/dashboard/v2');if(!navigation?.ok())failure('BROWSER_NAVIGATION_FAILED');
        await page.getByRole('tab',{name:'재고·실사·승인',exact:true}).click();
        const table=page.getByRole('table',{name:'위치·품목별 재고 목록',exact:true});
        await expect(table.locator('tbody tr').first()).toBeVisible({timeout:15000});
        await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
        const {rows,total,pageIndex,pageSize}=await table.evaluate(node=>({rows:node.querySelectorAll('tbody tr').length,total:Number(node.getAttribute('data-stock-total')),pageIndex:Number(node.getAttribute('data-stock-page-index')),pageSize:Number(node.getAttribute('data-stock-page-size'))}));
        if(rows!==INVENTORY_PAGE_SIZE||total!==report.fixture.balances_per_tenant||pageIndex!==0||pageSize!==INVENTORY_PAGE_SIZE)failure('BROWSER_PAGE_CONTRACT_MISMATCH');
        const value={ok:true,company:report.fixture.tenants[company].company,ms:performance.now()-start,display_profile:INVENTORY_DISPLAY_PROFILE,rendered_rows:rows,total_positions:total,page_index:pageIndex,page_size:pageSize};if(index)values.push(value);else warmups.push(value);
      }catch(error){failures++;const value={ok:false,company:report.fixture.tenants[company].company,ms:performance.now()-start,code:String(error.code??error.name)};if(index)values.push(value);else warmups.push(value);}
    }
    await context.close();
  }
  report.browser.inventory=summarize(values);report.browser.inventory.warmups=warmups;report.browser.inventory.requested_measured_samples=20;report.browser.inventory.early_stopped=values.length<20;progress(`Browser inventory first page: p95=${displayMs(report.browser.inventory.p95_ms)} ms, errors=${report.browser.inventory.errors}`);await writeReport();
  report.inventory_preservation={profile:INVENTORY_DISPLAY_PROFILE,baseline_manifest_sha256:report.baseline_manifest_sha256,excluded_from_latency_statistics:true,companies:[],passed:false};
  if(values.length===20&&!report.browser.inventory.errors&&warmups.every(sample=>sample.ok)){
    phase='independent inventory pagination preservation proof';
    const baseline=JSON.parse(await readFile(baselinePath,'utf8'));
    for(let index=0;index<2;index++){
      const tenant=baseline.tenants.find(tenant=>tenant.id===report.fixture.tenants[index].id);
      const evidence=await verifyInventoryPagePreservation({browser,origin,storageState:await contexts[index].storageState(),tenant:{...tenant,expected_version:report.fixture.ledger_per_tenant/20}});
      report.inventory_preservation.companies.push(evidence);progress(`Inventory preservation ${tenant.company}: ${evidence.passed?'passed':'failed'}`);await writeReport();
    }
    report.inventory_preservation.passed=report.inventory_preservation.companies.length===2&&report.inventory_preservation.companies.every(company=>company.passed);
  }else report.inventory_preservation.reason='BROWSER_SAMPLES_INCOMPLETE_OR_ERRORS';
  await writeReport();
}

async function cleanupFixture() {
  phase='remove only the owned fixture database';await fixtureOwnership();
  await owner.query(`DROP DATABASE ${pg.escapeIdentifier(report.fixture.database)}`);
  report.cleanup={database:'owned disposable fixture database dropped',at:new Date().toISOString()};
  if(report.fixture.created_application_role) {
    try {await owner.query('DROP ROLE wms_app');report.cleanup.role='new restricted role dropped';}
    catch(error) {if(error.code!=='2BP01')throw error;report.cleanup.role='restricted role retained because another database has dependencies';}
  } else report.cleanup.role='preexisting restricted role preserved';
}
try {
  await owner.connect();
  if(args.has('--resume')||args.has('--cleanup')||args.has('--prepare-runtime-only')) {report=JSON.parse(await readFile(reportPath,'utf8'));await fixtureOwnership();}
  else await prepare();
  if(args.has('--cleanup')) {await cleanupFixture();report.phase='cleaned';}
  else if(args.has('--prepare-runtime-only')) {
    if(report.phase==='measured')report.previous_measurement={measurement_profile:report.measurement_profile??'inventory-1600-dom-v1',build_id:report.build_id,measurement_started_at:report.measurement_started_at,finished_at:report.finished_at,verdict:report.verdict,failure_analysis:report.latest_failure_analysis};
    // Preparing a new build must never label its unmeasured runtime with older successful samples.
    report.phase='runtime_prepared';delete report.verdict;delete report.finished_at;delete report.measurement_started_at;delete report.latest_failure_analysis;report.db={};report.api={};report.browser={};delete report.inventory_preservation;delete report.isolation_probe;inventoryDisplayContract();
    await prepareRuntime();
  }
  else if(!args.has('--prepare-only')) {
    if(report.fixture.ledger_per_tenant!==ledgerPerTenant)failure('RESUME_PROFILE_MISMATCH');
    if(report.phase==='measured')report.previous_measurement={measurement_profile:report.measurement_profile??'inventory-1600-dom-v1',build_id:report.build_id,measurement_started_at:report.measurement_started_at,finished_at:report.finished_at,verdict:report.verdict,failure_analysis:report.latest_failure_analysis};
    delete report.error; delete report.cleanup_error;delete report.verdict;delete report.finished_at;delete report.latest_failure_analysis;delete report.isolation_probe; report.db={}; report.api={}; report.browser={}; delete report.inventory_preservation;inventoryDisplayContract(); report.phase='measuring';
    await measureDatabase();const databasePhasePool=appPool;appPool=null;await databasePhasePool.end();await startServer();await measureApi();await measureBrowser();
    const metrics=[...Object.values(report.db),...Object.values(report.api),...Object.values(report.browser)];
    report.verdict=report.fixture.full_million_profile&&samples===100&&concurrency===5&&metrics.every(metric=>metric.target_met&&!metric.early_stopped&&metric.count===metric.requested_measured_samples&&metric.warmups.every(sample=>sample.ok))&&report.isolation_probe?.passed&&report.inventory_preservation?.passed?'passed_local_million_ledger_read_profile':'failed_local_read_profile';
    report.phase='measured';report.finished_at=new Date().toISOString();
    if(report.verdict==='failed_local_read_profile')process.exitCode=1;
  }
} catch(error) {
  report??={schema_version:'1.0',started_at:new Date().toISOString()};report.error={phase,code:String(error.code??error.name)};report.phase='failed';process.exitCode=1;
} finally {
  await browser?.close();for(const context of contexts)await context.dispose();
  if(server&&server.exitCode===null){const exited=new Promise(resolve=>server.once('exit',resolve));server.kill('SIGTERM');await Promise.race([exited,delay(5000)]);if(server.exitCode===null){server.kill('SIGKILL');await exited;}}
  await appPool?.end();await databaseClient?.end();
  if(ownedRuntime&&!args.has('--prepare-runtime-only')&&(await readFile(join(ownedRuntime,'benchmark-run-id'),'utf8').catch(()=>null))===report.run_id){await rm(ownedRuntime,{recursive:true,force:true});if(report.runtime)report.runtime.cleaned=true;}
  if(report?.fixture?.database&&!args.has('--prepare-only')&&!args.has('--prepare-runtime-only')&&!args.has('--keep-fixture')&&!args.has('--cleanup')&&!report.cleanup) {
    try{await cleanupFixture();}catch(error){report.cleanup_error={phase,code:String(error.code??error.name)};process.exitCode=1;}
  }
  await owner.end().catch(()=>{});
  await writeReport();progress(`report: ${reportPath}; phase=${report.phase}; verdict=${report.verdict??'not measured'}`);
}
