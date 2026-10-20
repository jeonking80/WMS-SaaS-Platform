/** Local P6 benchmark. Build first; run: node --env-file=.env.local scripts/performance.mjs */
import { randomUUID } from 'node:crypto';
import { cpus, totalmem, platform, release } from 'node:os';
import { readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { hashPassword } from 'better-auth/crypto';
import { chromium, expect } from '@playwright/test';

const database = new URL(process.env.MIGRATION_DATABASE_URL ?? '');
if (!['localhost', '127.0.0.1', '[::1]'].includes(database.hostname) || database.pathname !== '/wms_lite') {
  throw new Error('Performance fixtures require a loopback wms_lite database.');
}
const password = process.env.DEMO_PASSWORD;
if (!password || password.length < 12 || password.length > 128) throw new Error('DEMO_PASSWORD (12–128 characters) is required.');
const port = Number(process.env.PERF_PORT ?? 3200);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid PERF_PORT.');
const origin = `http://127.0.0.1:${port}`;
const tenant = randomUUID();
const user = `p6-perf-${tenant}`;
const email = `${user}@example.test`;
const warehouse = randomUUID();
const client = new pg.Client({ connectionString: database.href });
let server, browser, seeded = false;
let serverOutput = '';
const report = {
  started_at: new Date().toISOString(), fixture: { tenant, documents: 10000, ledger: 10000, balances: 10000, items: 100, locations: 100, audits: 10000 },
  method: { production_build: 'prebuilt .next; this script never builds', concurrency: 1, warmups: 1, measured_repeats: 5, target_ms: 2000, statistic: 'nearest-rank p95; 5 samples means p95=max', browser_timing: 'full navigation until fixture table rows visible; home until metrics, 7-day chart and recent posted documents visible; then two animation frames', exclusions: ['fixture seed', 'server startup', 'login', 'warmup'], scope: 'local latency measurement, not a load test; all synthetic documents are original posted INBOUND quantity=1 across 7 days' },
  machine: { platform: `${platform()} ${release()}`, cpu: cpus()[0]?.model, logical_cpus: cpus().length, ram_bytes: totalmem(), node: process.version }, api: {}, browser: {},
};
function summarize(samples) {
  const sorted = samples.map(x => x.ms).sort((a,b) => a-b);
  return { samples, median_ms: sorted[2], p95_ms: sorted[4], max_ms: sorted[4], target_met: sorted[4] <= 2000 };
}
async function seed() {
  await client.query('BEGIN');
  try {
    await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenant]);
    await client.query('INSERT INTO tenants(id,name) VALUES($1,$2)', [tenant, user]);
    await client.query('INSERT INTO "user"(id,name,email) VALUES($1,$1,$2)', [user,email]);
    await client.query('INSERT INTO account(id,"accountId","providerId","userId",password) VALUES($1,$2,\'credential\',$2,$3)', [randomUUID(),user,await hashPassword(password)]);
    await client.query("INSERT INTO memberships(user_id,tenant_id,role) VALUES($1,$2,'admin')", [user,tenant]);
    await client.query("INSERT INTO warehouses(id,tenant_id,code,name) VALUES($1,$2,'PERF','P6 benchmark warehouse')", [warehouse,tenant]);
    await client.query("CREATE TEMP TABLE perf_items AS SELECT n,gen_random_uuid() id FROM generate_series(1,100) n");
    await client.query("CREATE TEMP TABLE perf_locations AS SELECT n,gen_random_uuid() id FROM generate_series(1,100) n");
    await client.query("INSERT INTO items(id,tenant_id,code,name) SELECT id,$1,'PERF-I-'||lpad(n::text,3,'0'),'P6 item '||n FROM perf_items", [tenant]);
    await client.query("INSERT INTO locations(id,tenant_id,warehouse_id,code,name) SELECT id,$1,$2,'PERF-L-'||lpad(n::text,3,'0'),'P6 location '||n FROM perf_locations", [tenant,warehouse]);
    await client.query("CREATE TEMP TABLE perf_documents AS SELECT gen_random_uuid() id,i.id item_id,l.id location_id,CURRENT_TIMESTAMP - ((i.n*100+l.n)%10000)*interval '60 seconds' AS fixture_at FROM perf_items i CROSS JOIN perf_locations l");
    await client.query("INSERT INTO inventory_documents(id,tenant_id,kind,status,warehouse_id,destination_location_id,posted_at,created_at,updated_at,note) SELECT id,$1,'INBOUND','POSTED',$2,location_id,fixture_at,fixture_at,fixture_at,'P6 synthetic performance fixture' FROM perf_documents", [tenant,warehouse]);
    await client.query('INSERT INTO inventory_document_lines(tenant_id,document_id,item_id,quantity) SELECT $1,id,item_id,1 FROM perf_documents', [tenant]);
    await client.query('INSERT INTO stock_ledger(tenant_id,document_id,warehouse_id,location_id,item_id,quantity_delta,created_at) SELECT $1,id,$2,location_id,item_id,1,fixture_at FROM perf_documents', [tenant,warehouse]);
    await client.query('INSERT INTO stock_balances(tenant_id,warehouse_id,location_id,item_id,quantity) SELECT $1,$2,location_id,item_id,1 FROM perf_documents', [tenant,warehouse]);
    await client.query("INSERT INTO audit_logs(tenant_id,document_id,actor_id,action,created_at) SELECT $1,id,$2,'POST_INBOUND',fixture_at FROM perf_documents", [tenant,user]);
    await client.query('COMMIT');
    seeded = true;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
}
async function cleanup() {
  if (!seeded) return;
  await client.query('BEGIN');
  try {
    await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenant]);
    const owned = await client.query('SELECT id FROM tenants WHERE id=$1 AND name=$2', [tenant,user]);
    if (owned.rowCount !== 1 || !user.startsWith('p6-perf-')) throw new Error('Fixture ownership check failed; cleanup refused.');
    for (const table of ['idempotency_requests','audit_logs','stock_ledger','stock_balances','inventory_document_lines','inventory_documents','locations','warehouses','items','memberships']) {
      await client.query(`DELETE FROM ${table} WHERE tenant_id=$1`, [tenant]);
    }
    await client.query('DELETE FROM "user" WHERE id=$1 AND email=$2', [user,email]);
    await client.query('DELETE FROM tenants WHERE id=$1 AND name=$2', [tenant,user]);
    await client.query('COMMIT');
    report.cleanup = 'dedicated tenant and synthetic identity removed';
  } catch (error) { await client.query('ROLLBACK'); throw error; }
}
try {
  await client.connect();
  report.machine.postgresql = (await client.query('SHOW server_version')).rows[0].server_version;
  await seed();
  await client.query("SELECT set_config('app.tenant_id',$1,false)", [tenant]);
  report.fixture.actual_counts = {};
  for (const [table,expected] of [['inventory_documents',10000],['inventory_document_lines',10000],['stock_ledger',10000],['stock_balances',10000],['audit_logs',10000],['items',100],['locations',100]]) {
    const actual = Number((await client.query(`SELECT count(*) AS count FROM ${table} WHERE tenant_id=$1`, [tenant])).rows[0].count);
    if (actual !== expected) throw new Error(`Fixture ${table}: expected ${expected}, found ${actual}`);
    report.fixture.actual_counts[table] = actual;
  }
  // Bulk fixture loading changes cardinalities; refresh planner statistics before warmup.
  for (const table of ['inventory_documents','inventory_document_lines','stock_ledger','stock_balances','audit_logs','items','locations','warehouses']) await client.query(`ANALYZE ${table}`);
  report.method.planner_statistics = 'ANALYZE after bulk fixture seed, before warmup';
  if (process.env.PERF_EXPLAIN === '1') {
    const source = await readFile('src/server/queries.ts','utf8');
    const joins = source.match(/const stockJoins = `([^`]+)`/)[1];
    const select = source.slice(source.indexOf('export function pagedLedger')).match(/return paged\(tenant, `([^`]+)`/)[1]
      .replace('${stockJoins}', joins)
      .replace('${documentNumberSql("d")}', "('WMS-' || lpad(d.document_no::text, greatest(6, length(d.document_no::text)), '0'))");
    const explainClient = new pg.Client({connectionString:process.env.DATABASE_URL});
    await explainClient.connect();
    await explainClient.query('BEGIN');
    try {
      await explainClient.query("SELECT set_config('app.tenant_id',$1,true)",[tenant]);
      await explainClient.query("SET LOCAL statement_timeout='60s'");
      report.ledger_explain = (await explainClient.query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) WITH filtered AS (${select}), page AS (SELECT * FROM filtered ORDER BY created_at DESC,id DESC LIMIT 25 OFFSET 0) SELECT (SELECT count(*)::int FROM filtered) total,COALESCE((SELECT json_agg(page ORDER BY created_at DESC,id DESC) FROM page),'[]'::json) rows`)).rows[0]['QUERY PLAN'];
    } finally { await explainClient.query('ROLLBACK'); await explainClient.end(); }
  }

  report.machine.cgroup = {};
  for (const name of ['memory.max','cpu.max']) {
    try { report.machine.cgroup[name] = (await readFile(`/sys/fs/cgroup/${name}`,'utf8')).trim(); }
    catch { report.machine.cgroup[name] = 'unavailable'; }
  }
  // Fail on an occupied port; never reuse or terminate another server.
  try { await fetch(`${origin}/api/health`); throw new Error('PERF_PORT is already serving HTTP.'); }
  catch (error) { if (error.message === 'PERF_PORT is already serving HTTP.') throw error; }
  server = spawn(process.execPath, ['node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','--port',String(port)], { cwd: process.cwd(), env: {...process.env,NODE_ENV:'production',BETTER_AUTH_URL:origin}, stdio: ['ignore','pipe','pipe'] });
  server.stdout.on('data', chunk => { serverOutput = (serverOutput + chunk).slice(-4000); });
  server.stderr.on('data', chunk => { serverOutput = (serverOutput + chunk).slice(-4000); });
  let ready = false;
  for (let n=0; n<120; n++) {
    if (server.exitCode !== null) throw new Error('Owned production server exited before readiness.');
    try { if ((await fetch(`${origin}/api/ready`)).ok) { ready=true; break; } } catch {}
    await delay(500);
  }
  if (!ready) throw new Error('Production server readiness timed out.');
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined });
  report.machine.chromium = browser.version();
  const context = await browser.newContext({baseURL:origin, viewport:{width:1280,height:900}});
  let signedIn = false;
  for (let attempt=0; attempt<4; attempt++) {
    const response = await context.request.post('/api/auth/sign-in/email', {headers:{Origin:origin}, data:{email,password}});
    if (response.ok()) { signedIn=true; break; }
    if (response.status() !== 429) throw new Error(`Synthetic login failed: HTTP ${response.status()}`);
    const seconds = Number(response.headers()['retry-after'] ?? 10);
    await delay(Math.min(60, Math.max(1, Number.isFinite(seconds) ? seconds : 10))*1000+250);
  }
  if (!signedIn) throw new Error('Authentication rate limit persisted after respectful retries.');
  const me = await (await context.request.get('/api/me')).json();
  if (me.tenant?.id !== tenant) throw new Error('Authenticated tenant does not match fixture.');
  for (const endpoint of ['/api/stock','/api/stock-ledger','/api/documents','/api/dashboard','/api/audit-logs','/api/stock/reconcile']) {
    const samples = [];
    for (let run=0; run<6; run++) {
      const start = performance.now();
      const response = await context.request.get(endpoint);
      const body = await response.json();
      const ms = performance.now()-start;
      if (!response.ok()) throw new Error(`${endpoint}: HTTP ${response.status()} (${body.error ?? 'unknown'})`);
      if (endpoint.endsWith('/reconcile') && body.consistent !== true) throw new Error('Synthetic stock reconciliation failed.');
      if (['/api/stock','/api/stock-ledger','/api/documents','/api/audit-logs'].includes(endpoint) && body.pagination?.total !== 10000) throw new Error(`${endpoint}: expected 10000 fixture rows`);
      const arrays = Object.fromEntries(Object.entries(body).filter(([,value]) => Array.isArray(value)).map(([key,value]) => [key,value.length]));
      if (run) samples.push({ms,status:response.status(),rows:arrays,pagination:body.pagination ?? null});
    }
    report.api[endpoint] = summarize(samples);
  }
  const page = await context.newPage();
  for (const [path, sections] of [['/dashboard/stock',['현재 재고','재고 변동 이력']],['/dashboard/documents',[]],['/dashboard/history',[]],['/dashboard/audit',[]],['/dashboard',['최근 확정 전표']]]) {
    const samples=[];
    for (let run=0;run<6;run++) {
      const start=performance.now();
      const navigation = await page.goto(path);
      if (!navigation?.ok()) throw new Error(`${path}: navigation failed`);
      await expect(page.getByTestId('current-company')).toHaveText(user);
      if (path === '/dashboard') {
        await expect(page.getByRole('heading',{name:'오늘의 운영 현황',exact:true})).toBeVisible();
        await expect(page.getByRole('img',{name:/최근 7일 추이/})).toBeVisible();
      }
      if (sections.length) {
        for (const heading of sections) await expect(page.getByRole('heading',{name:heading,exact:true}).locator('xpath=ancestor::section[1]').locator('tbody tr').first()).toBeVisible();
      } else await expect(page.locator('tbody tr').first()).toBeVisible();
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      if (run) samples.push({ms:performance.now()-start,rendered_rows:await page.locator('tbody tr:visible').count()});
    }
    report.browser[path]=summarize(samples);
  }
  report.finished_at=new Date().toISOString();
} catch (error) {
  report.error = {name:error.name,message:error.message};
  process.exitCode=1;
} finally {
  await browser?.close();
  if (server && server.exitCode === null) {
    const exited = new Promise(resolve => server.once('exit',resolve));
    server.kill('SIGTERM');
    await Promise.race([exited,delay(5000)]);
    if (server.exitCode === null) { server.kill('SIGKILL'); await exited; }
  }
  try { await cleanup(); } catch (error) { report.cleanup_error=error.message; process.exitCode=1; }
  await client.end();
  const output=process.env.PERF_REPORT_PATH ?? '/tmp/wms-p6-performance.json';
  await writeFile(output,JSON.stringify(report,null,2)+'\n');
  console.log(`P6 report: ${output}; ${report.error ? 'FAILED' : 'completed'}; ${report.cleanup ?? 'no committed fixture'}`);
}
