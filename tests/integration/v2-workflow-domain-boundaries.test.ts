import {randomUUID,randomBytes} from 'node:crypto';
import pg from 'pg';
import {beforeAll,afterAll,it,expect,vi} from 'vitest';
import {migrate} from '../../scripts/db-migrate.mjs';
import type {Identity} from '../../src/server/auth/access';
const state=vi.hoisted(()=>({pool:undefined as pg.Pool|undefined}));
vi.mock('../../src/server/db/pool',()=>({getPool:()=>state.pool}));
import {withTenant} from '../../src/server/db/tenant';
import {executeWorkflow,getWorkflowSnapshot,physicalWorkflowCommands,type WorkflowState,type Lot} from '../../src/server/v2/workflow';
const url=process.env.TEST_DATABASE_URL;
if(!url||!decodeURIComponent(new URL(url).pathname).endsWith('_test'))throw Error('Dedicated _test database required');
const schema='v2_boundaries_'+randomUUID().replaceAll('-',''),role='app_'+randomUUID().replaceAll('-',''),password=randomBytes(24).toString('hex');
const owner=new pg.Pool({connectionString:url}),tenant=randomUUID(),actor=randomUUID(),reviewer=randomUUID(),warehouse=randomUUID(),receiving=randomUUID(),storage=randomUUID(),hold=randomUUID(),item=randomUUID(),partner=randomUUID(),destination=randomUUID();let created=false;
const identity:Identity={tenant:{id:tenant,name:'Domain boundary fixture'},user:{id:actor,name:'Requester',email:actor+'@example.test'},role:'admin'};
const independent:Identity={...identity,user:{id:reviewer,name:'Independent approver',email:reviewer+'@example.test'}};
beforeAll(async()=>{
 await migrate(url,{schema,migrationsSchema:schema,createSchema:true,createMigrationsSchema:true,log:()=>{}});await owner.query(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD ${pg.escapeLiteral(password)}`);created=true;
 await owner.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${role}"`);await owner.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA "${schema}" TO "${role}"`);
 await owner.query(`INSERT INTO "${schema}".tenants(id,name) VALUES($1,'Domain boundary fixture')`,[tenant]);
 for(const user of[identity.user,independent.user]){await owner.query(`INSERT INTO "${schema}"."user"(id,name,email) VALUES($1,$2,$3)`,[user.id,user.name,user.email]);await owner.query(`INSERT INTO "${schema}".memberships(tenant_id,user_id,role) VALUES($1,$2,'admin')`,[tenant,user.id]);}
 const connection=new URL(url!);connection.username=role;connection.password=password;state.pool=new pg.Pool({connectionString:connection.toString(),options:`-c search_path=${schema}`});
 await withTenant(tenant,async c=>{
  await c.query("INSERT INTO warehouses(id,tenant_id,code,name) VALUES($1,$2,'BOUNDARY','Boundary warehouse')",[warehouse,tenant]);
  for(const id of[actor,reviewer])await c.query('INSERT INTO v2_warehouse_grants(tenant_id,user_id,warehouse_id) VALUES($1,$2,$3)',[tenant,id,warehouse]);
  for(const[id,kind]of[[receiving,'RECEIVING'],[storage,'STORAGE'],[hold,'HOLD']])await c.query('INSERT INTO locations(id,tenant_id,warehouse_id,code,name,kind) VALUES($1::uuid,$2,$3,$4,$4,$5)',[id,tenant,warehouse,kind,kind]);
  await c.query("INSERT INTO items(id,tenant_id,code,name) VALUES($1,$2,'SKU','Boundary item')",[item,tenant]);
  await c.query("INSERT INTO business_partners(id,tenant_id,code,name,supplier,customer) VALUES($1,$2,'PARTNER','Boundary partner',true,true)",[partner,tenant]);
  await c.query("INSERT INTO delivery_destinations(id,tenant_id,partner_id,recipient_name,name,address_line1) VALUES($1,$2,$3,'Recipient','Main','Boundary address')",[destination,tenant,partner]);
 });
},30000);
afterAll(async()=>{await state.pool?.end();try{await owner.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);}finally{try{if(created)await owner.query(`DROP ROLE "${role}"`);}finally{await owner.end();}}});
function run(command:string,payload:Record<string,unknown>,who=identity,request_id=randomUUID()){
 const p=structuredClone(payload);
 if(command==='receipt.create'){p.supplier_id??=partner;p.expected_at??='2026-11-01T00:00:00Z';}
 if(command==='order.create'){p.delivery??={partner_id:partner,delivery_destination_id:destination};p.due_at??='2026-11-02T00:00:00Z';}
 if((physicalWorkflowCommands as readonly string[]).includes(command)){p.manual_entry_reason??='Physical item and location independently compared';if(Array.isArray(p.lines))p.lines=p.lines.map(line=>({input_mode:'search',...(line as object)}));else p.input_mode??='search';}
 return executeWorkflow(who,{warehouse_id:warehouse,command,payload:p,request_id});
}
async function effects(){return withTenant(tenant,async c=>({state:(await c.query('SELECT state FROM v2_workflow_state WHERE warehouse_id=$1',[warehouse])).rows[0]?.state,counts:(await c.query('SELECT (SELECT count(*)::int FROM v2_workflow_requests) requests,(SELECT count(*)::int FROM v2_workflow_performances) performances,(SELECT count(*)::int FROM v2_workflow_ledger) ledger')).rows[0]}));}
async function excess(){const created=await run('receipt.create',{lines:[{item_id:item,quantity:100}]});const receipt=created.snapshot.receipts.find(r=>r.id===created.result.id)!;const received=await run('receipt.receive',{receipt_id:receipt.id,receiving_id:randomUUID(),reason:'Five excess physically arrived',lines:[{line_id:receipt.lines[0].id,quantity:105,location_id:receiving,hold_location_id:hold}]});return{receipt,lot:received.snapshot.receipts.find(r=>r.id===receipt.id)!.lots.find(l=>l.overage)!};}
async function accept(lot_id:string,quantity:number){const requested=await run('overage.request',{lot_id,quantity,reason:'Review documented physical excess'});return run('approval.decide',{approval_id:requested.result.id,approve:true,reason:'Independently accepted'},independent);}
async function oldAggregate(lot_id:string,edit:(lot:Lot,s:WorkflowState)=>void){const s=(await owner.query<{state:WorkflowState}>(`SELECT state FROM "${schema}".v2_workflow_state WHERE warehouse_id=$1`,[warehouse])).rows[0].state;const lot=s.receipts.flatMap(r=>r.lots).find(l=>l.id===lot_id)!;edit(lot,s);await owner.query(`UPDATE "${schema}".v2_workflow_state SET version=$2,state=$3::jsonb WHERE warehouse_id=$1`,[warehouse,s.version,JSON.stringify(s)]);}

it('keeps acquisition approval at five through repeated quality holds and releases, with one physical effect per request',async()=>{
 const {receipt,lot}=await excess();await accept(lot.id,5);await run('hold.release',{lot_id:lot.id,quantity:5,location_id:receiving,reason:'Release accepted acquisition'});
 await run('receipt.inspect',{receipt_id:receipt.id,lines:[{lot_id:lot.id,quantity:2,outcome:'hold'},{lot_id:lot.id,quantity:3,outcome:'normal'}]});
 const inspected=await getWorkflowSnapshot(identity,warehouse);expect(inspected.receipts.find(r=>r.id===receipt.id)!.lots.find(l=>l.id===lot.id)).toMatchObject({approved:5,released:5,hold:2,quality_hold:2,normal:3});
 const before=await effects();await expect(run('overage.request',{lot_id:lot.id,quantity:1,reason:'Must not count the same excess twice'})).rejects.toMatchObject({code:'INVALID_OVERAGE'});expect(await effects()).toEqual(before);
 const payload={lot_id:lot.id,quantity:2,location_id:receiving,reason:'Quality reviewed, acquisition already accepted'},key=randomUUID();
 await run('hold.release',payload,identity,key);expect((await run('hold.release',payload,identity,key)).replayed).toBe(true);
 await run('receipt.inspect',{receipt_id:receipt.id,lines:[{lot_id:lot.id,quantity:2,outcome:'hold'}]});
 await run('hold.release',{...payload,reason:'Second independent quality disposition'});
 await run('receipt.inspect',{receipt_id:receipt.id,lines:[{lot_id:lot.id,quantity:2,outcome:'normal'}]});
 const finished=await run('receipt.putaway',{receipt_id:receipt.id,lines:[{lot_id:lot.id,quantity:5,location_id:storage}]});
 expect(finished.snapshot.receipts.find(r=>r.id===receipt.id)!.lots.find(l=>l.id===lot.id)).toMatchObject({approved:5,released:5,hold:0,quality_hold:0,pending:0,normal:0,putaway:5});
 expect(finished.snapshot.approvals.filter(a=>a.type==='overage'&&a.target_id===lot.id&&a.status==='approved').reduce((n,a)=>n+a.quantity,0)).toBe(5);expect(finished.snapshot.reconciliation.ok).toBe(true);
 const rows=await withTenant(tenant,c=>c.query('SELECT bucket,sum(delta)::int delta FROM v2_workflow_ledger WHERE request_id=$1 GROUP BY bucket ORDER BY bucket',[key]));expect(rows.rows).toEqual([{bucket:'B',delta:-2},{bucket:'Q',delta:2}]);
});

it('preserves unapproved excess after a partial acquisition release and excludes quality holds from acquisition capacity',async()=>{
 const {receipt,lot}=await excess();await accept(lot.id,2);const released=await run('hold.release',{lot_id:lot.id,quantity:2,location_id:receiving,reason:'Only two accepted'});
 const converted=released.snapshot.receipts.find(r=>r.id===receipt.id)!.lots.find(l=>l.id!==lot.id&&l.pending===2)!;
 const before=await effects();await expect(run('hold.release',{lot_id:lot.id,quantity:3,location_id:receiving,reason:'Unapproved remainder'})).rejects.toMatchObject({code:'OVERAGE_APPROVAL_REQUIRED'});expect(await effects()).toEqual(before);
 await run('receipt.inspect',{receipt_id:receipt.id,lines:[{lot_id:converted.id,quantity:2,outcome:'hold'}]});
 await run('hold.release',{lot_id:converted.id,quantity:2,location_id:receiving,reason:'Quality disposition does not accept the three remaining excess pieces'});
 await accept(lot.id,3);await run('hold.release',{lot_id:lot.id,quantity:3,location_id:receiving,reason:'Remaining acquisition independently accepted'});
 await run('receipt.inspect',{receipt_id:receipt.id,lines:[{lot_id:lot.id,quantity:1,outcome:'hold'}]});
 await expect(run('overage.request',{lot_id:lot.id,quantity:1,reason:'Repeated acceptance forbidden'})).rejects.toMatchObject({code:'INVALID_OVERAGE'});
 const final=await run('hold.release',{lot_id:lot.id,quantity:1,location_id:receiving,reason:'Quality approval only'});expect(final.snapshot.receipts.find(r=>r.id===receipt.id)!.lots.find(l=>l.id===lot.id)).toMatchObject({approved:5,released:5,quality_hold:0,hold:0});expect(final.snapshot.reconciliation.ok).toBe(true);
});

it('freezes every original order line after any cancellation while permitting unchanged quantity metadata and linked additional demand',async()=>{
 const created=await run('order.create',{lines:[{item_id:item,quantity:10},{item_id:item,quantity:10}]});const order=created.snapshot.orders.find(o=>o.id===created.result.id)!;
 await run('order.cancel',{order_id:order.id,reason:'First line partially cancelled',lines:[{line_id:order.lines[0].id,quantity:1}]});
 for(const[quantity,code]of[[12,'CREATE_LINKED_ORDER'],[8,'USE_CANCELLATION']]as const){const before=await effects();await expect(run('order.update',{order_id:order.id,reason:'Changing untouched second line',lines:[{id:order.lines[1].id,item_id:item,quantity}]})).rejects.toMatchObject({code});expect(await effects()).toEqual(before);}
 const updated=await run('order.update',{order_id:order.id,lines:order.lines.map(l=>({id:l.id,item_id:l.item_id,quantity:l.quantity})),due_at:'2026-11-03T00:00:00Z',reason:'Keep original quantities, amend due date only'});
 expect(updated.snapshot.orders.find(o=>o.id===order.id)!.lines.map(l=>({quantity:l.quantity,cancelled:l.cancelled}))).toEqual([{quantity:10,cancelled:1},{quantity:10,cancelled:0}]);
 const extra=await run('order.create',{original_order_id:order.id,lines:[{item_id:item,quantity:2}]});expect(extra.snapshot.orders.find(o=>o.id===extra.result.id)).toMatchObject({original_order_id:order.id,lines:[{quantity:2}]});expect(extra.snapshot.reconciliation.ok).toBe(true);
});

it('recovers an existing accepted quality hold from immutable work and records the repair when the next command commits',async()=>{
 const{receipt,lot}=await excess();await accept(lot.id,5);await run('hold.release',{lot_id:lot.id,quantity:5,location_id:receiving,reason:'Accepted acquisition'});
 await run('receipt.inspect',{receipt_id:receipt.id,lines:[{lot_id:lot.id,quantity:2,outcome:'hold'},{lot_id:lot.id,quantity:3,outcome:'normal'}]});
 await oldAggregate(lot.id,l=>{delete l.quality_hold;});const before=await effects();
 const projected=await getWorkflowSnapshot(identity,warehouse);expect(projected.receipts.find(r=>r.id===receipt.id)!.lots.find(l=>l.id===lot.id)).toMatchObject({quality_hold:2,approved:5,released:5,overage_recovery:{previous_approved:5,previous_released:5,approved:5,released:5,quality_hold:2}});expect(await effects()).toEqual(before);
 const key=randomUUID();await run('hold.release',{lot_id:lot.id,quantity:2,location_id:receiving,reason:'Recovered quality disposition'},identity,key);
 const stored=await withTenant(tenant,c=>c.query('SELECT evidence FROM v2_workflow_performances WHERE request_id=$1',[key]));expect(stored.rows[0].evidence.overage_history_recovery).toEqual([expect.objectContaining({lot_id:lot.id,previous_approved:5,previous_released:5,approved:5,released:5,quality_hold:2,evidence_request_ids:expect.any(Array)})]);
 const final=await getWorkflowSnapshot(identity,warehouse);expect(final.receipts.find(r=>r.id===receipt.id)!.lots.find(l=>l.id===lot.id)).toMatchObject({approved:5,released:5,quality_hold:0,hold:0});expect(final.reconciliation.ok).toBe(true);
});

it('does not infer ambiguous old unapproved excess from released and held counters alone',async()=>{
 const{receipt,lot}=await excess();await accept(lot.id,2);await run('hold.release',{lot_id:lot.id,quantity:2,location_id:receiving,reason:'Two accepted pieces only'});await oldAggregate(lot.id,l=>{delete l.quality_hold;});
 const projected=await getWorkflowSnapshot(identity,warehouse);expect(projected.receipts.find(r=>r.id===receipt.id)!.lots.find(l=>l.id===lot.id)).toMatchObject({quality_hold:0,approved:2,released:2,hold:3});
 const before=await effects();await expect(run('hold.release',{lot_id:lot.id,quantity:3,location_id:receiving,reason:'Must remain blocked without acquisition approval'})).rejects.toMatchObject({code:'OVERAGE_APPROVAL_REQUIRED'});expect(await effects()).toEqual(before);
 // Contradictory counters without supporting inspection history must be surfaced, never masked as quality.
 await oldAggregate(lot.id,l=>{l.approved=6;});await expect(getWorkflowSnapshot(identity,warehouse)).rejects.toMatchObject({code:'OVERAGE_HISTORY_REPAIR_REQUIRED'});await oldAggregate(lot.id,l=>{l.approved=2;l.quality_hold=0;});
});

it('repairs historical duplicate acquisition counters without deleting the old decisions or ledger and retains their provenance',async()=>{
 const{receipt,lot}=await excess();await accept(lot.id,5);await run('hold.release',{lot_id:lot.id,quantity:5,location_id:receiving,reason:'Original accepted acquisition'});
 await run('receipt.inspect',{receipt_id:receipt.id,lines:[{lot_id:lot.id,quantity:2,outcome:'hold'},{lot_id:lot.id,quantity:3,outcome:'normal'}]});
 // Emulate the previous deployed engine: it required a second acquisition approval for
 // these same two quality-held pieces, then added the release to the acquisition counter.
 const legacyApproval=randomUUID(),at='2026-10-20T12:00:00.000Z';
 const legacy=await owner.connect();try{await legacy.query('BEGIN');await legacy.query(`SET LOCAL search_path TO "${schema}"`);
  const s=(await legacy.query<{state:WorkflowState}>('SELECT state FROM v2_workflow_state WHERE warehouse_id=$1 FOR UPDATE',[warehouse])).rows[0].state;
  const current=s.receipts.flatMap(r=>r.lots).find(l=>l.id===lot.id)!;
  async function history(command:string,evidence:Record<string,unknown>,result:Record<string,unknown>,actorId:string,deltas:[string,number][]=[]){const id=randomUUID();s.version++;await legacy.query('INSERT INTO v2_workflow_requests(tenant_id,warehouse_id,request_id,request_hash,command,actor_id,response) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)',[tenant,warehouse,id,'legacy-fixture-'+id,command,actorId,JSON.stringify({result,version:s.version})]);await legacy.query('INSERT INTO v2_workflow_performances(tenant_id,warehouse_id,request_id,actor_id,command,evidence,reason) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)',[tenant,warehouse,id,actorId,command,JSON.stringify(evidence),'Preserved historical engine behavior']);for(const[bucket,delta]of deltas)await legacy.query('INSERT INTO v2_workflow_ledger(id,tenant_id,warehouse_id,item_id,location_id,request_id,actor_id,command,bucket,delta,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[randomUUID(),tenant,warehouse,item,receiving,id,actorId,command,bucket,delta,'Preserved historical engine behavior']);return id;}
  const request=await history('overage.request',{lot_id:lot.id,lines:[]},{id:legacyApproval},actor);
  s.approvals.push({id:legacyApproval,type:'overage',target_id:lot.id,target_version:5,quantity:2,data:{},requester_id:actor,request_id:request,requested_at:at,origin_actor_ids:[actor],reason:'Historical duplicate quality acceptance',status:'approved',decider_id:reviewer,decided_at:at});
  await history('approval.decide',{approval_id:legacyApproval,lines:[]},{id:legacyApproval},reviewer);
  await history('hold.release',{lot_id:lot.id,lines:[{lot_id:lot.id,quantity:2}]},{id:lot.id},actor,[['B',-2],['Q',2]]);
  await history('receipt.inspect',{receipt_id:receipt.id,lines:[{lot_id:lot.id,quantity:2,outcome:'hold'}]},{id:receipt.id},actor,[['Q',-2],['B',2]]);
  current.approved=7;current.released=7;delete current.quality_hold;s.ledger_count=(s.ledger_count??0)+4;
  await legacy.query('UPDATE v2_workflow_state SET version=$2,state=$3::jsonb WHERE warehouse_id=$1',[warehouse,s.version,JSON.stringify(s)]);await legacy.query('COMMIT');
 }catch(error){await legacy.query('ROLLBACK');throw error;}finally{legacy.release();}
 const before=await effects(),projected=await getWorkflowSnapshot(identity,warehouse);expect(projected.receipts.find(r=>r.id===receipt.id)!.lots.find(l=>l.id===lot.id)).toMatchObject({approved:5,released:5,quality_hold:2,overage_recovery:{previous_approved:7,previous_released:7,approved:5,released:5,quality_hold:2}});expect(projected.approvals.find(a=>a.id===legacyApproval)).toMatchObject({quantity:2,status:'approved'});expect(await effects()).toEqual(before);
 const key=randomUUID();const released=await run('hold.release',{lot_id:lot.id,quantity:2,location_id:receiving,reason:'Quality release after evidenced repair'},identity,key);expect(released.snapshot.reconciliation.ok).toBe(true);
 const audited=await withTenant(tenant,c=>c.query('SELECT evidence FROM v2_workflow_performances WHERE request_id=$1',[key]));expect(audited.rows[0].evidence.overage_history_recovery[0]).toMatchObject({previous_approved:7,previous_released:7,approved:5,released:5});
 await expect(run('overage.request',{lot_id:lot.id,quantity:1,reason:'Repaired history cannot authorize duplicate acquisition'})).rejects.toMatchObject({code:'INVALID_OVERAGE'});
});
