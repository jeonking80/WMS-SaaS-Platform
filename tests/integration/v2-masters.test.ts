import { randomBytes,randomUUID } from 'node:crypto';
import pg from 'pg';
import { beforeAll,afterAll,describe,it,expect,vi } from 'vitest';
import { migrate } from '../../scripts/db-migrate.mjs';
import type { Identity } from '../../src/server/auth/access';
import {recordRequestIdentity,recordAuthorizedWarehouse,withRequestLog} from '../../src/server/request-log';
const state=vi.hoisted(()=>({pool:undefined as pg.Pool|undefined}));
vi.mock('../../src/server/db/pool',()=>({getPool:()=>state.pool}));
vi.mock('../../src/server/auth/access',async original=>({...await original<object>(),requireIdentity:async()=>{recordRequestIdentity(identity);return identity;}}));
import {withTenant} from '../../src/server/db/tenant';
import {insertMaster,updateMaster,resolveBarcode} from '../../src/server/v2/masters/service';
import {previewCsv,applyCsv} from '../../src/server/v2/masters/imports';
import {masterHttp} from '../../src/server/v2/masters/http';
import {previewBusinessCsv,applyBusinessCsv} from '../../src/server/v2/masters/business-imports';
import {emptyState} from '../../src/server/v2/workflow/types';
import {collectMonitor,collectDatabaseLocks} from '../../scripts/v2-monitor-lib.mjs';
import {transactionApplicationName} from '../../scripts/v2-lock-scope.mjs';
import {monitorOperations} from '../../src/server/v2/operations/monitor';
import {GET as masterGet} from '../../src/app/api/v2/masters/[kind]/route';
import {GET as monitorGet} from '../../src/app/api/v2/operations/monitor/route';
const url=process.env.TEST_DATABASE_URL;
if(!url||!decodeURIComponent(new URL(url).pathname).endsWith('_test'))throw new Error('Dedicated test DB required');
const schema='masters_'+randomUUID().replaceAll('-','');const role='app_'+randomUUID().replaceAll('-','');const password=randomBytes(24).toString('hex');
const owner=new pg.Pool({connectionString:url});const appUrl=new URL(url);appUrl.username=role;appUrl.password=password;
const tenant=randomUUID(),foreign=randomUUID(),warehouse=randomUUID(),otherWarehouse=randomUUID(),actor=randomUUID();
const identity:Identity={user:{id:actor,name:'Master',email:actor+'@example.test'},tenant:{id:tenant,name:'A'},role:'admin'};
let created=false;
beforeAll(async()=>{
 await owner.query(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD ${pg.escapeLiteral(password)}`);created=true;
 await migrate(url,{schema,migrationsSchema:schema,createSchema:true,createMigrationsSchema:true,log:()=>{}});
 await owner.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${role}"`);await owner.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA "${schema}" TO "${role}"`);await owner.query(`GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA "${schema}" TO "${role}"`);
 await owner.query(`INSERT INTO "${schema}".tenants(id,name) VALUES($1,'A'),($2,'B')`,[tenant,foreign]);
 await owner.query(`INSERT INTO "${schema}"."user"(id,name,email) VALUES($1,'Master',$2)`,[actor,identity.user.email]);
 await owner.query(`INSERT INTO "${schema}".memberships(user_id,tenant_id,role) VALUES($1,$2,'admin')`,[actor,tenant]);
 state.pool=new pg.Pool({connectionString:appUrl.toString(),options:`-c search_path=${schema}`,max:4});
 await withTenant(tenant,async c=>{await c.query("INSERT INTO warehouses(id,tenant_id,code,name) VALUES($1,$2,'MAIN','Main'),($3,$2,'OTHER','Other')",[warehouse,tenant,otherWarehouse]);await c.query('INSERT INTO v2_warehouse_grants(tenant_id,user_id,warehouse_id) VALUES($1,$2,$3)',[tenant,actor,warehouse]);});
 process.env.BETTER_AUTH_URL='http://localhost:3000';
},30000);
afterAll(async()=>{await state.pool?.end();try{await owner.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);}finally{if(created)await owner.query(`DROP ROLE "${role}"`);await owner.end();}});
const tx=<T>(fn:(c:pg.PoolClient)=>Promise<T>)=>withTenant(tenant,fn);
async function item(code:string=randomUUID()){return tx(c=>insertMaster(c,tenant,warehouse,'items',{code:code.toUpperCase(),name:code}));}
async function location(code:string=randomUUID(),kind='STORAGE'){return tx(c=>insertMaster(c,tenant,warehouse,'locations',{code,name:code,kind}));}
function req(method='GET',body?:unknown,wh=warehouse,extra=''){return new Request(`http://localhost:3000/api/v2/masters/items?warehouse_id=${wh}${extra}`,{method,headers:{origin:'http://localhost:3000','content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});}
const ctx=(kind='items')=>({params:Promise.resolve({kind})});
describe('V2 masters PostgreSQL isolation and operations',()=>{
 it('enforces FORCE RLS and composite cross-tenant target references',async()=>{
  const i=await item();await withTenant(foreign,async c=>expect((await c.query('SELECT id FROM items WHERE id=$1',[i.id])).rows).toEqual([]));
  await expect(withTenant(foreign,c=>c.query("INSERT INTO master_barcodes(tenant_id,barcode,item_id,unit,quantity) VALUES($1,'foreign',$2,'EA',1)",[foreign,i.id]))).rejects.toMatchObject({code:'23503'});
  await expect(withTenant(tenant,c=>c.query("INSERT INTO business_partners(tenant_id,code,name,supplier) VALUES($1,'spoof','Spoof',true)",[foreign]))).rejects.toMatchObject({code:'42501'});
 });
 it('makes barcode assignment immutable, resolves exact box conversion and retains retired labels',async()=>{
  const i=await item();const b=await tx(c=>insertMaster(c,tenant,warehouse,'barcodes',{barcode:randomUUID(),item_id:i.id,unit:'BOX',quantity:12}));
  expect(await tx(c=>resolveBarcode(c,b.barcode))).toMatchObject({item_id:i.id,quantity:12,unit:'BOX'});
  await expect(tx(c=>c.query('UPDATE master_barcodes SET quantity=10 WHERE id=$1',[b.id]))).rejects.toMatchObject({code:'23514'});
  await expect(tx(c=>c.query("INSERT INTO master_barcodes(tenant_id,barcode,item_id) VALUES($1,'no-unit',$2)",[tenant,i.id]))).rejects.toMatchObject({code:'23514'});
  await tx(c=>updateMaster(c,warehouse,'barcodes',b.id,{active:false}));
  await expect(tx(c=>resolveBarcode(c,b.barcode))).rejects.toMatchObject({code:'BARCODE_NOT_FOUND'});
  await expect(tx(c=>insertMaster(c,tenant,warehouse,'barcodes',{barcode:b.barcode,item_id:i.id,unit:'BOX',quantity:10}))).rejects.toMatchObject({code:'23505'});
 });
 it('blocks inactivity and location type changes with v2 physical/reserved stock even through direct legacy updates',async()=>{
  const i=await item();const l=await location();
  await tx(async c=>{await c.query("INSERT INTO v2_workflow_state(tenant_id,warehouse_id,state) VALUES($1,$2,'{}') ON CONFLICT DO NOTHING",[tenant,warehouse]);await c.query('INSERT INTO v2_workflow_stock(tenant_id,warehouse_id,item_id,location_id,s,r) VALUES($1,$2,$3,$4,10,3)',[tenant,warehouse,i.id,l.id]);});
  await expect(tx(c=>updateMaster(c,warehouse,'items',i.id,{active:false}))).rejects.toMatchObject({code:'MASTER_IN_USE'});
  await expect(tx(c=>c.query('UPDATE locations SET active=false WHERE id=$1',[l.id]))).rejects.toMatchObject({code:'23503'});
  await expect(tx(c=>c.query("UPDATE locations SET kind='HOLD' WHERE id=$1",[l.id]))).rejects.toMatchObject({code:'23503'});
 });
 it('blocks unreceived open item references and permits inactive after remainder closure',async()=>{
  const i=await item();await tx(c=>c.query('UPDATE v2_workflow_state SET state=$1::jsonb WHERE warehouse_id=$2',[JSON.stringify({receipts:[{closed:false,lines:[{item_id:i.id,quantity:5,received:0,cancelled:0}]}]}),warehouse]));
  await expect(tx(c=>updateMaster(c,warehouse,'items',i.id,{active:false}))).rejects.toMatchObject({code:'MASTER_IN_USE'});
  await tx(c=>c.query("UPDATE v2_workflow_state SET state='{}' WHERE warehouse_id=$1",[warehouse]));await tx(c=>updateMaster(c,warehouse,'items',i.id,{active:false}));
 });
 it('previews per-row errors, selects only valid rows and prevents duplicated apply effects across keys',async()=>{
  const code=randomUUID();const csv=`code,name\n${code},Good\n${code},Duplicate\n,Missing\nBad`;const p=await tx(c=>previewCsv(c,tenant,warehouse,'items',csv,'preview-one'));
  expect(p.rows.map(r=>r.errors.length)).toEqual([0,1,1,1]);
  await expect(tx(c=>applyCsv(c,tenant,warehouse,'items',p.preview_id,[2,3],'bad-apply'))).rejects.toMatchObject({code:'INVALID_ROW_SELECTION'});
  const first=await tx(c=>applyCsv(c,tenant,warehouse,'items',p.preview_id,[2],'apply-one'));expect(first.applied).toBe(1);
  expect(await tx(c=>applyCsv(c,tenant,warehouse,'items',p.preview_id,[2],'apply-one'))).toEqual(first);
  expect((await tx(c=>applyCsv(c,tenant,warehouse,'items',p.preview_id,[2],'apply-two'))).applied).toBe(0);
  await expect(tx(c=>previewCsv(c,tenant,warehouse,'items','code,name\nx,y','preview-one'))).rejects.toMatchObject({code:'REQUEST_KEY_CONFLICT'});
  expect((await tx(c=>c.query('SELECT id FROM items WHERE code=$1',[code.toUpperCase()]))).rows).toHaveLength(1);
 });
 it('applies nothing when selected rows become invalid after preview',async()=>{
  const a=randomUUID(),b=randomUUID();const p=await tx(c=>previewCsv(c,tenant,warehouse,'items',`code,name\n${a},A\n${b},B`,'preview-conflict'));await item(b.toUpperCase());
  await expect(tx(c=>applyCsv(c,tenant,warehouse,'items',p.preview_id,[2,3],'atomic-conflict'))).rejects.toMatchObject({code:'23505'});
  expect((await tx(c=>c.query('SELECT id FROM items WHERE code=$1',[a.toUpperCase()]))).rows).toHaveLength(0);
 });
 it('imports grouped receipt and order CSV atomically with external duplicate and group selection protection',async()=>{
  await tx(async c=>{await c.query('DELETE FROM v2_workflow_stock WHERE warehouse_id=$1',[warehouse]);await c.query('UPDATE v2_workflow_state SET state=$1::jsonb WHERE warehouse_id=$2',[JSON.stringify(emptyState()),warehouse]);});
  const a=await item(),b=await item();const supplier=await tx(c=>insertMaster(c,tenant,warehouse,'partners',{code:randomUUID().toUpperCase(),name:'Supplier',supplier:true}));
  const csv=`external_id,supplier_code,item_code,quantity,expected_at\nCSV-RECEIPT,${supplier.code},${a.code},12,2027-01-02\nCSV-RECEIPT,${supplier.code},${b.code},3,2027-01-02`;
  const p=await tx(c=>previewBusinessCsv(c,tenant,warehouse,'receipts',csv,'receipt-preview'));expect(p.rows.map((r:{errors:string[]})=>r.errors)).toEqual([[],[]]);
  await expect(tx(c=>applyBusinessCsv(c,identity,warehouse,'receipts',p.preview_id,[2],'receipt-partial'))).rejects.toMatchObject({code:'GROUP_SELECTION_REQUIRED'});
  const result=await tx(c=>applyBusinessCsv(c,identity,warehouse,'receipts',p.preview_id,[2,3],'receipt-apply'));expect(result.applied).toBe(1);
  expect((await tx(c=>applyBusinessCsv(c,identity,warehouse,'receipts',p.preview_id,[2,3],'receipt-retry'))).applied).toBe(0);
  const duplicate=await tx(c=>previewBusinessCsv(c,tenant,warehouse,'receipts',csv,'receipt-duplicate'));expect(duplicate.rows[0].errors).toContain('EXTERNAL_ID_CONFLICT');
  const customer=await tx(c=>insertMaster(c,tenant,warehouse,'partners',{code:randomUUID().toUpperCase(),name:'CSV Customer',customer:true}));const destination=await tx(c=>insertMaster(c,tenant,warehouse,'destinations',{recipient_name:'Recipient',name:'CSV Destination',address_line1:'Seoul',partner_id:customer.id,external_code:randomUUID()}));
  const order=await tx(c=>previewBusinessCsv(c,tenant,warehouse,'orders',`external_id,customer_code,destination_external_code,due_at,item_code,quantity\nCSV-ORDER,${customer.code},${destination.external_code},2027-01-03,${a.code},2`,'order-preview'));expect(order.rows[0].errors).toEqual([]);
  expect((await tx(c=>applyBusinessCsv(c,identity,warehouse,'orders',order.preview_id,[2],'order-apply'))).applied).toBe(1);
  const saved=await tx(c=>c.query('SELECT state FROM v2_workflow_state WHERE warehouse_id=$1',[warehouse]));expect(saved.rows[0].state.receipts[0].lines).toHaveLength(2);expect(saved.rows[0].state.receipts[0].expected_at).toBe('2027-01-02T00:00:00.000Z');expect(saved.rows[0].state.orders[0].delivery).toMatchObject({partner_id:customer.id,delivery_destination_id:destination.id});
 });
 it('resolves barcode and destination CSV codes inside tenant and warehouse boundaries',async()=>{
  const shared='SHARED-'+randomUUID().slice(0,8).toUpperCase(),foreignWarehouse=randomUUID();
  const ownItem=await item(shared);const ownLocation=await location(shared);
  const ownCustomer=await tx(c=>insertMaster(c,tenant,warehouse,'partners',{code:shared,name:'Own customer',customer:true}));
  const foreignRefs=await withTenant(foreign,async c=>{
   await c.query('INSERT INTO warehouses(id,tenant_id,code,name) VALUES($1,$2,$3,$3)',[foreignWarehouse,foreign,shared]);
   const i=await insertMaster(c,foreign,foreignWarehouse,'items',{code:shared,name:'Foreign item'});
   const l=await insertMaster(c,foreign,foreignWarehouse,'locations',{code:shared,name:'Foreign location',kind:'STORAGE'});
   const p=await insertMaster(c,foreign,foreignWarehouse,'partners',{code:shared,name:'Foreign customer',customer:true});
   return {i,l,p};
  });
  const ownPreview=await tx(c=>previewCsv(c,tenant,warehouse,'barcodes',`barcode,item_code,unit,quantity\nOWN-LABEL,${shared},BOX,12`,'code-own'));
  expect(ownPreview.rows[0]).toMatchObject({errors:[],data:{item_id:ownItem.id}});
  const foreignPreview=await withTenant(foreign,c=>previewCsv(c,foreign,foreignWarehouse,'barcodes',`barcode,item_code,unit,quantity\nFOREIGN-LABEL,${shared},EA,1`,'code-foreign'));
  expect(foreignPreview.rows[0]).toMatchObject({errors:[],data:{item_id:foreignRefs.i.id}});
  const locationPreview=await tx(c=>previewCsv(c,tenant,warehouse,'barcodes',`barcode,location_code\nLOCATION-LABEL,${shared}`,'code-location'));
  expect(locationPreview.rows[0]).toMatchObject({errors:[],data:{location_id:ownLocation.id}});
  const wrongWarehouse=await tx(c=>previewCsv(c,tenant,otherWarehouse,'barcodes',`barcode,location_code\nWRONG-WAREHOUSE,${shared}`,'code-wrong-warehouse'));
  expect(wrongWarehouse.rows[0].errors).toContain('INACTIVE_OR_UNKNOWN_REFERENCE');
  const destination=await tx(c=>previewCsv(c,tenant,warehouse,'destinations',`recipient_name,name,address_line1,customer_code\nRecipient,Office,Seoul,${shared}`,'code-destination'));
  expect(destination.rows[0]).toMatchObject({errors:[],data:{partner_id:ownCustomer.id}});
  const foreignDestination=await withTenant(foreign,c=>previewCsv(c,foreign,foreignWarehouse,'destinations',`recipient_name,name,address_line1,partner_code\nRecipient,Office,Elsewhere,${shared}`,'code-foreign-destination'));
  expect(foreignDestination.rows[0]).toMatchObject({errors:[],data:{partner_id:foreignRefs.p.id}});
 });
 it('monitors independent persisted mismatches and old reservations while reporting unverified backups and delivery',async()=>{
  const monitorItem=await item();const monitorLocation=await location();
  await tx(c=>c.query('UPDATE items SET min_stock=10 WHERE id=$1',[monitorItem.id]));
  await tx(c=>c.query('INSERT INTO v2_workflow_stock(tenant_id,warehouse_id,item_id,location_id,s) VALUES($1,$2,$3,$4,5)',[tenant,warehouse,monitorItem.id,monitorLocation.id]));
  await tx(async c=>{
   await c.query("UPDATE v2_workflow_state SET state=jsonb_set(state,'{orders}',COALESCE(state->'orders','[]') || $1::jsonb) WHERE warehouse_id=$2",[JSON.stringify([{created_at:'2020-01-01T00:00:00Z',due_at:'2020-01-02T00:00:00Z',lines:[{quantity:1,cancelled:0,shipped:0}],reservations:[{quantity:1}]}]),warehouse]);
   await c.query("UPDATE v2_workflow_state SET state=jsonb_set(state,'{counts}',$1::jsonb) WHERE warehouse_id=$2",[JSON.stringify([{status:'completed',location_id:monitorLocation.id,baseline:[{item_id:monitorItem.id,S:7}],lines:[{item_id:monitorItem.id,bucket:'S',quantity:5}]}]),warehouse]);
   for(const [status,revision] of [['accepted',1],['quarantined',2]] as const)await c.query(`INSERT INTO v2_integration_events(tenant_id,source_system,warehouse_id,actor_id,source_key_id,event_id,entity_kind,external_entity_id,revision,event_type,schema_version,occurred_at,correlation_id,request_hash,revision_hash,payload,status,received_at)
   VALUES($1,'monitor',$2,$3,$4,$5,'order','monitor',$6,'order.create','2.0','2020-01-01','monitor',$7,$7,'{}',$8,'2020-01-01')`,[tenant,warehouse,actor,randomUUID(),randomUUID(),revision,'a'.repeat(64),status]);
  });
  const report=await tx(c=>collectMonitor(c,{tenantId:tenant,warehouseIds:[warehouse],now:new Date('2030-01-01T00:00:00Z')}));
  expect(report.checks.find(c=>c.name==='inventory_reconciliation')).toMatchObject({status:'critical'});
  expect(report.checks.find(c=>c.name==='integration_queue')).toMatchObject({status:'warning',details:{pending:1,quarantined:1}});
  expect(report.checks.find(c=>c.name==='long_reservations')).toMatchObject({status:'warning',details:{long_reservations:1,estimated_from_order_creation:1}});
  expect(report.checks.find(c=>c.name==='backup')).toMatchObject({status:'unknown'});
  expect(report.checks.find(c=>c.name==='low_available_stock')).toMatchObject({status:'warning',details:{below_minimum:expect.arrayContaining([{item_id:monitorItem.id,item_code:monitorItem.code,available_ea:5,min_stock_ea:10}])}});
  expect(report.checks.find(c=>c.name==='operational_kpis')).toMatchObject({status:'warning',details:{as_of:'2030-01-01T00:00:00.000Z',overdue_orders:{numerator:2,denominator:2},count_differences:{difference_rows:1,recorded_rows:1,difference_ea_absolute:2,difference_ea_signed:-2},request_failure_rate:{status:'no_samples',numerator:0,denominator:0},wrong_pick_rate:{status:'no_samples',numerator:0,denominator:0}}});
  expect(report.checks.find(c=>c.name==='database')).toMatchObject({status:'ok',details:{probe_latency_ms:expect.any(Number)}});
  expect(report.checks.find(c=>c.name==='provider_recovery')).toMatchObject({status:'unknown'});
  expect(report.notifications).toMatchObject({status:'not_configured',sent:false});
  const queueAlert=report.alerts.find(a=>a.code==='INTEGRATION_QUARANTINED');
  expect(queueAlert).toMatchObject({tenant:{id:tenant,name:'A'},warehouses:[{id:warehouse,code:'MAIN',name:'Main'}],references:expect.arrayContaining([expect.objectContaining({kind:'integration_event',business_id:expect.any(String),business_number:expect.any(String)})]),action:{path:expect.stringContaining('/dashboard/v2?warehouse_id='+warehouse)}});
  expect(report.alerts.every(a=>a.warehouses.every(w=>w.id===warehouse))).toBe(true);
  expect(report.alerts.find(a=>a.code==='KPI_TELEMETRY_INCOMPLETE')?.references).toEqual(expect.arrayContaining([expect.objectContaining({kind:'order',business_id:expect.stringMatching(/^[a-f0-9-]{36}$/),business_number:expect.any(String)})]));
  expect((await monitorOperations(identity,warehouse)).warehouse_ids).toEqual([warehouse]);
  await expect(monitorOperations(identity,otherWarehouse)).rejects.toMatchObject({code:'WAREHOUSE_FORBIDDEN'});
 });
 it('measures failed requests and rejected pick scans from persisted scoped telemetry with explicit denominators',async()=>{
  await tx(async c=>{for(const [status,error] of [[200,'OK'],[409,'WRONG_ITEM_SCAN'],[503,'SERVICE_UNAVAILABLE']] as const)await c.query("INSERT INTO api_request_metrics(tenant_id,warehouse_id,request_id,actor_id,operation,command,method,status,error_code,duration_ms,created_at) VALUES($1,$2,$3,$4,'v2.workflow.command','order.pick','POST',$5,$6,10,'2030-02-01T00:00:00Z')",[tenant,warehouse,randomUUID(),actor,status,error]);});
  const report=await tx(c=>collectMonitor(c,{tenantId:tenant,warehouseIds:[warehouse],now:new Date('2030-02-01T00:00:01Z')}));
  expect(report.checks.find(c=>c.name==='operational_kpis')).toMatchObject({status:'warning',details:{wrong_pick_rate:{status:'measured',numerator:1,denominator:3},request_failure_rate:{status:'measured',numerator:1,denominator:3,business_rejections:1}}});
  expect(report.alerts.find(a=>a.code==='KPI_TELEMETRY_INCOMPLETE')?.references).toEqual(expect.arrayContaining([expect.objectContaining({kind:'request',request_id:expect.stringMatching(/^[a-f0-9-]{36}$/)})]));
  const other=await tx(c=>collectMonitor(c,{tenantId:tenant,warehouseIds:[otherWarehouse],now:new Date('2030-02-01T00:00:01Z')}));expect(other.checks.find(c=>c.name==='operational_kpis')).toMatchObject({details:{request_failure_rate:{denominator:0}}});
 });
 it('measures induced live lock waits of this warehouse and excludes other warehouses, tenants and unclassified work under the same app role',async()=>{
  const second=randomUUID(),foreignWh=randomUUID(),foreignActor=randomUUID();
  await owner.query(`INSERT INTO "${schema}".warehouses(id,tenant_id,code,name) VALUES($1,$2,'LOCK2','Lock second'),($3,$4,'LOCKF','Lock foreign')`,[second,tenant,foreignWh,foreign]);
  await owner.query(`INSERT INTO "${schema}"."user"(id,name,email) VALUES($1,'Foreign lock actor',$2)`,[foreignActor,foreignActor+'@example.invalid']);
  await owner.query(`INSERT INTO "${schema}".memberships(user_id,tenant_id,role) VALUES($1,$2,'admin')`,[foreignActor,foreign]);
  for(const[t,w,u]of [[tenant,second,actor],[foreign,foreignWh,foreignActor]])await owner.query(`INSERT INTO "${schema}".v2_warehouse_grants VALUES($1,$2,$3)`,[t,u,w]);
  const blocker=await owner.connect();
  const observer=new pg.Client({connectionString:appUrl.toString(),options:`-c search_path=${schema}`});await observer.connect();
  const log=vi.spyOn(console,'info').mockImplementation(()=>{});const running:Promise<unknown>[]=[];
  async function waitForLocks(expected:number){const end=Date.now()+3000;while(Date.now()<end){const count=(await owner.query('SELECT count(DISTINCT a.pid)::int n FROM pg_stat_activity a JOIN pg_locks l ON l.pid=a.pid WHERE a.usename=$1 AND NOT l.granted',[role])).rows[0].n;if(count>=expected)return;await new Promise(resolve=>setTimeout(resolve,20));}throw new Error('Actual PostgreSQL wait did not appear');}
  try{
   await blocker.query('BEGIN');await blocker.query(`SELECT id FROM "${schema}".warehouses WHERE id=ANY($1::uuid[]) FOR UPDATE`,[[warehouse,second,foreignWh]]);
   for(const[t,w,u]of [[tenant,warehouse,actor],[tenant,second,actor],[foreign,foreignWh,foreignActor]])running.push(withRequestLog('monitor.lock.regression',async()=>{recordRequestIdentity({user:{id:u},tenant:{id:t}});recordAuthorizedWarehouse(t,w);await withTenant(t,c=>c.query('SELECT id FROM warehouses WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[t,w]));return new Response('{}');})());
   await waitForLocks(3);await new Promise(resolve=>setTimeout(resolve,40));
   const measured=await collectDatabaseLocks(observer,tenant,[warehouse]);expect(measured).toMatchObject({waiting_requests:1,unknown_start:0});expect(measured.max_wait_ms).toBeGreaterThanOrEqual(30);expect(measured.mean_wait_ms).toBeGreaterThanOrEqual(30);
   expect(await collectDatabaseLocks(observer,tenant,[second])).toMatchObject({waiting_requests:1});expect(await collectDatabaseLocks(observer,foreign,[foreignWh])).toMatchObject({waiting_requests:1});
   expect(JSON.stringify(measured)).not.toContain(foreign);expect(JSON.stringify(measured)).not.toContain(second);expect(JSON.stringify(measured)).not.toContain('SELECT');
   expect((await blocker.query('SELECT application_name FROM pg_stat_activity WHERE application_name=$1',[transactionApplicationName(tenant,warehouse)])).rowCount).toBe(1);
   await blocker.query('ROLLBACK');await Promise.all(running);running.length=0;
   await blocker.query('BEGIN');await blocker.query(`SELECT id FROM "${schema}".warehouses WHERE id=$1 FOR UPDATE`,[warehouse]);
   running.push(withTenant(tenant,c=>c.query('SELECT id FROM warehouses WHERE id=$1 FOR UPDATE',[warehouse])));await waitForLocks(1);
   expect(await collectDatabaseLocks(observer,tenant,[warehouse])).toMatchObject({waiting_requests:0,tenant_only_transactions:expect.stringContaining('excluded')});
  }finally{await blocker.query('ROLLBACK');await Promise.all(running);log.mockRestore();await observer.end();blocker.release();}
 });
 it('correlates master and monitor API requests without logging request bodies',async()=>{
  const log=vi.spyOn(console,'info').mockImplementation(()=>{});
  try{const masters=await masterGet(req(),ctx());expect(masters.headers.get('x-request-id')).toMatch(/^[a-f0-9-]{36}$/);const monitor=await monitorGet(req());expect(monitor.headers.get('x-request-id')).toMatch(/^[a-f0-9-]{36}$/);expect(log.mock.calls.map(args=>JSON.parse(String(args[0])))).toEqual(expect.arrayContaining([expect.objectContaining({tenantId:tenant,userId:actor,operation:'v2.operations.monitor'})]));}finally{log.mockRestore();}
 });
 it('paginates every master past row1000 without scope/filter drift, duplicates, or permission bypass',async()=>{
  const prefix='PAGE'+randomUUID().replaceAll('-','');
  await tx(async c=>{
   await c.query("INSERT INTO items(tenant_id,code,name) SELECT $1,$2||g,$2||g FROM generate_series(1,1001) g",[tenant,prefix]);
   await c.query("INSERT INTO locations(tenant_id,warehouse_id,code,name) SELECT $1,$2,$3||g,$3||g FROM generate_series(1,1001) g",[tenant,warehouse,prefix]);
   await c.query("INSERT INTO business_partners(tenant_id,code,name,supplier,customer) SELECT $1,$2||g,$2||g,true,true FROM generate_series(1,1001) g",[tenant,prefix]);
   await c.query("INSERT INTO delivery_destinations(tenant_id,name,recipient_name,address_line1,partner_id) SELECT $1,$2||g,$2||g,'Synthetic page address',(SELECT id FROM business_partners WHERE code=$2||'1') FROM generate_series(1,1001) g",[tenant,prefix]);
   await c.query("INSERT INTO master_barcodes(tenant_id,barcode,item_id,unit,quantity) SELECT $1,$2||row_number() OVER(ORDER BY id),id,'EA',1 FROM items WHERE code LIKE $2||'%'",[tenant,prefix]);
   await c.query("INSERT INTO items(tenant_id,code,name,active) VALUES($1,$2,$2,false)",[tenant,prefix+'INACTIVE']);
   await c.query("INSERT INTO locations(tenant_id,warehouse_id,code,name) VALUES($1,$2,$3,$3)",[tenant,otherWarehouse,prefix+'OTHER']);
  });
  await owner.query(`INSERT INTO "${schema}".items(tenant_id,code,name) VALUES($1,$2,$2)`,[foreign,prefix+'FOREIGN']);
  let itemCursor='';
  for(const kind of ['items','locations','partners','destinations','barcodes']){
   const first=await masterHttp(req('GET',undefined,warehouse,'&q='+prefix+'&active=true'),ctx(kind),'collection');expect(first.status).toBe(200);const a=await first.json();expect(a.rows).toHaveLength(1000);expect(a.has_more).toBe(true);expect(a.next_cursor).toEqual(expect.any(String));
   const second=await masterHttp(req('GET',undefined,warehouse,'&q='+prefix+'&active=true&cursor='+encodeURIComponent(a.next_cursor)),ctx(kind),'collection');expect(second.status).toBe(200);const b=await second.json();expect(b.rows).toHaveLength(1);expect(b.has_more).toBe(false);expect(b.next_cursor).toBeNull();const rows=[...a.rows,...b.rows];expect(new Set(rows.map(row=>row.id)).size).toBe(1001);expect(rows.every(row=>row.tenant_id===tenant)).toBe(true);if(kind==='locations')expect(rows.every(row=>row.warehouse_id===warehouse)).toBe(true);if(kind==='items')itemCursor=a.next_cursor;
  }
  const suffix='&q='+prefix+'&active=true&cursor='+encodeURIComponent(itemCursor);
  expect((await masterHttp(req('GET',undefined,warehouse,suffix+'&limit=1'),ctx(),'collection')).status).toBe(400);
  expect((await masterHttp(req('GET',undefined,warehouse,'&q=changed&active=true&cursor='+itemCursor),ctx(),'collection')).status).toBe(400);
  expect((await masterHttp(req('GET',undefined,warehouse,'&q='+prefix+'&active=false&cursor='+itemCursor),ctx(),'collection')).status).toBe(400);
  expect((await masterHttp(req('GET',undefined,warehouse,suffix),ctx('locations'),'collection')).status).toBe(400);
  expect((await masterHttp(req('GET',undefined,otherWarehouse,suffix),ctx(),'collection')).status).toBe(403);
  expect((await masterHttp(req('GET',undefined,warehouse,'&cursor=not-a-valid-cursor'),ctx(),'collection')).status).toBe(400);
  expect((await masterHttp(req('GET',undefined,warehouse,'&limit=1001'),ctx(),'collection')).status).toBe(400);
  const inactive=await (await masterHttp(req('GET',undefined,warehouse,'&q='+prefix+'&active=false'),ctx(),'collection')).json();expect(inactive.rows).toHaveLength(1);expect(inactive.has_more).toBe(false);
  await owner.query(`DELETE FROM "${schema}".v2_warehouse_grants WHERE tenant_id=$1 AND user_id=$2 AND warehouse_id=$3`,[tenant,actor,warehouse]);
  try{expect((await masterHttp(req('GET',undefined,warehouse,suffix),ctx(),'collection')).status).toBe(403);}finally{await owner.query(`INSERT INTO "${schema}".v2_warehouse_grants(tenant_id,user_id,warehouse_id) VALUES($1,$2,$3)`,[tenant,actor,warehouse]);}
 });
 it('rechecks explicit warehouse grants, live roles and applies formula-safe filtered exports',async()=>{
  const code=randomUUID();await item(code);await tx(c=>c.query('UPDATE items SET name=$1 WHERE code=$2',['=HYPERLINK("x")',code.toUpperCase()]));
  const exportResponse=await masterHttp(req('GET',undefined,warehouse,'&q='+code),ctx(),'export');expect(exportResponse.status).toBe(200);expect(await exportResponse.text()).toContain("'=HYPERLINK");
  expect((await masterHttp(req('GET',undefined,otherWarehouse),ctx(),'collection')).status).toBe(403);
  await owner.query(`UPDATE "${schema}".memberships SET role='viewer' WHERE user_id=$1`,[actor]);
  expect((await masterHttp(req('POST',{code:'FORBIDDEN',name:'Forbidden'}),ctx(),'collection')).status).toBe(403);
  expect((await masterHttp(req(),ctx(),'collection')).status).toBe(200);
  await expect(monitorOperations(identity,warehouse)).rejects.toMatchObject({code:'ROLE_FORBIDDEN'});
 });
});
