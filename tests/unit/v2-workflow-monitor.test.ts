import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {describe,it,expect} from 'vitest';
import {collectMonitor} from '../../scripts/v2-monitor-lib.mjs';
type Event={id:string;event_id:string;sequence:string;tenant_id:string;warehouse_id:string;status:string;received_at:string;payload?:unknown};
const tenant=randomUUID(),warehouse=randomUUID(),otherWarehouse=randomUUID(),foreignTenant=randomUUID(),now=new Date('2030-01-01T00:00:00Z');
const event=(sequence:number,status:string,received_at='2029-12-31T23:59:00Z',scope={tenant_id:tenant,warehouse_id:warehouse}):Event=>({id:randomUUID(),event_id:randomUUID(),sequence:String(sequence),status,received_at,...scope,payload:{secret:'never_expose_raw_payload'}});
function client(events:Event[],warehouses=[warehouse]){
 const rows=(rows:unknown[])=>({rows,rowCount:rows.length});
 return {query:async(sql:string,values:unknown[]=[])=>{
  if(sql==='SELECT 1'||/^(SAVEPOINT|RELEASE|ROLLBACK TO)/.test(sql))return rows([]);
  if(sql.includes('SELECT id,code,name FROM warehouses'))return rows(warehouses.map(id=>({id,code:'TEST',name:'Test warehouse'})));
  if(sql.includes("to_regclass('v2_workflow_stock')"))return rows([{stock:null,ledger:null,state:null,events:'events'}]);
  if(sql.includes('AS pending')){const own=events.filter(e=>e.tenant_id===values[0]&&(values[1] as string[]).includes(e.warehouse_id)),pending=own.filter(e=>['accepted','dependency_wait','retry_wait'].includes(e.status));return rows([{pending:pending.length,oldest_pending_at:pending.map(e=>e.received_at).sort()[0]??null,quarantined:own.filter(e=>e.status==='quarantined').length,rejected:own.filter(e=>e.status==='business_rejected').length}]);}
  if(sql.includes('WITH scoped AS'))return rows([{waiting_requests:0,unknown_start:0,max_wait_ms:0,mean_wait_ms:0,measured_at:now}]);
  if(sql.includes('SELECT id,name FROM tenants'))return rows([{id:tenant,name:'Test tenant'}]);
  if(sql.includes('SELECT id,event_id,sequence::text,status'))return rows(events.filter(e=>e.tenant_id===values[0]&&e.warehouse_id===values[1]&&(values[2] as string[]).includes(e.status)&&(!values[3]||Date.parse(e.received_at)<Date.parse(String(values[3])))).sort((a,b)=>Date.parse(a.received_at)-Date.parse(b.received_at)||Number(a.sequence)-Number(b.sequence)).slice(0,10));
  if(sql.includes('jsonb_array_elements'))return rows([]);
  throw Error('Unexpected monitor query');
 }} as unknown as Pick<PoolClient,'query'>;
}
describe('integration alert incident references',()=>{
 it('links the quarantined eleventh incident after ten accepted events and excludes another authorized warehouse',async()=>{
  const accepted=Array.from({length:10},(_,i)=>event(i+1,'accepted')),quarantined=event(11,'quarantined'),other=event(12,'accepted');other.warehouse_id=otherWarehouse;
  const foreign=event(13,'quarantined');foreign.tenant_id=foreignTenant;
  const report=await collectMonitor(client([...accepted,quarantined,other,foreign],[warehouse,otherWarehouse]),{tenantId:tenant,warehouseIds:[warehouse,otherWarehouse],now});
  expect(report.checks.find(c=>c.name==='integration_queue')).toMatchObject({details:{pending:11,quarantined:1,rejected:0}});
  const alerts=report.alerts.filter(a=>a.code==='INTEGRATION_QUARANTINED');expect(alerts).toHaveLength(1);expect(alerts[0].warehouses.map(w=>w.id)).toEqual([warehouse]);expect(alerts[0].references.map(r=>r.business_id)).toEqual([quarantined.id]);expect(new URL(alerts[0].action.path,'https://wms.invalid').searchParams.get('event_id')).toBe(quarantined.id);
  expect(JSON.stringify(report.alerts)).not.toContain('never_expose_raw_payload');expect(JSON.stringify(report.alerts)).not.toContain(foreign.id);
 });
 it('links the delayed pending incident after ten fresh accepted events rather than an unrelated quarantine',async()=>{
  const fresh=Array.from({length:10},(_,i)=>event(i+1,'accepted')),delayed=event(11,'retry_wait','2029-12-31T23:30:00Z'),other=event(12,'quarantined');other.warehouse_id=otherWarehouse;
  const report=await collectMonitor(client([...fresh,delayed,other]),{tenantId:tenant,warehouseIds:[warehouse],now,pendingMinutes:15});
  expect(report.checks.find(c=>c.name==='integration_queue')).toMatchObject({details:{pending:11,quarantined:0,oldest_pending_minutes:30}});
  const alert=report.alerts.find(a=>a.code==='INTEGRATION_QUEUE_DELAYED')!;expect(alert.references.map(r=>r.business_id)).toEqual([delayed.id]);expect(new URL(alert.action.path,'https://wms.invalid').searchParams.get('event_id')).toBe(delayed.id);
 });
});
