import {randomUUID,randomBytes} from 'node:crypto';
import pg from 'pg';
import {beforeAll,afterAll,it,expect,vi} from 'vitest';
import {migrate} from '../../scripts/db-migrate.mjs';
import type {Identity} from '../../src/server/auth/access';
const connection=vi.hoisted(()=>({pool:undefined as pg.Pool|undefined}));
vi.mock('../../src/server/db/pool',()=>({getPool:()=>connection.pool}));
import {withTenant} from '../../src/server/db/tenant';
import {assertV2MachineKey} from '../../src/server/v2/access';
import {executeWorkflow,type WorkflowState} from '../../src/server/v2/workflow';
const url=process.env.TEST_DATABASE_URL;
if(!url||!decodeURIComponent(new URL(url).pathname).endsWith('_test'))throw Error('Dedicated _test database required');
const schema='handover_'+randomUUID().replaceAll('-',''),role='handover_'+randomUUID().replaceAll('-',''),password=randomBytes(24).toString('hex');
const owner=new pg.Pool({connectionString:url}),tenant=randomUUID(),foreignTenant=randomUUID(),warehouse=randomUUID(),location=randomUUID(),item=randomUUID();
const ids={requester:randomUUID(),first:randomUUID(),last:randomUUID(),eligible:randomUUID(),override:randomUUID(),worker:randomUUID(),noGrant:randomUUID(),foreign:randomUUID()};
const machineIds={valid:randomUUID(),noApprove:randomUUID(),revoked:randomUUID()};
const previousEnvironment=process.env.WMS_ENVIRONMENT;let roleCreated=false,countId:string,approvalId:string;
const who=(id:string,role:Identity['role']='admin'):Identity=>({tenant:{id:tenant,name:'Handover'},user:{id,name:id,email:id+'@example.test'},role});
const tx=<T>(fn:(c:pg.PoolClient)=>Promise<T>)=>withTenant(tenant,fn);
const command=(actor:Identity,name:string,payload:Record<string,unknown>)=>executeWorkflow(actor,{warehouse_id:warehouse,request_id:randomUUID(),command:name,payload});
const handover=(assignee_id:string)=>({object_type:'approval',object_id:approvalId,assignee_id,reason:'Independent next reviewer'});
const close=(assignee:string,extra:Record<string,unknown>[]=[] )=>command(who(ids.requester),'shift.close',{handover:[handover(assignee),...extra],unconfirmed_request_ids:[]});
async function effects(){return tx(async c=>({state:(await c.query('SELECT state FROM v2_workflow_state WHERE warehouse_id=$1',[warehouse])).rows[0].state,counts:(await c.query('SELECT (SELECT count(*)::int FROM v2_workflow_requests) requests,(SELECT count(*)::int FROM v2_workflow_performances) performances,(SELECT count(*)::int FROM v2_workflow_ledger) ledger')).rows[0]}));}
beforeAll(async()=>{
 process.env.WMS_ENVIRONMENT='test';
 await migrate(url,{schema,migrationsSchema:schema,createSchema:true,createMigrationsSchema:true,log:()=>{}});
 await owner.query(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD ${pg.escapeLiteral(password)}`);roleCreated=true;
 await owner.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${role}"`);await owner.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA "${schema}" TO "${role}"`);
 await owner.query(`INSERT INTO "${schema}".tenants(id,name,is_test) VALUES($1,'Handover',true),($2,'Foreign',true)`,[tenant,foreignTenant]);
 for(const [label,id] of Object.entries(ids)){
  const t=label==='foreign'?foreignTenant:tenant,roleName=label==='worker'?'worker':label==='requester'||label==='override'?'admin':'supervisor';
  await owner.query(`INSERT INTO "${schema}"."user"(id,name,email) VALUES($1,$2,$3)`,[id,label,id+'@example.test']);
  await owner.query(`INSERT INTO "${schema}".memberships(tenant_id,user_id,role) VALUES($1,$2,$3)`,[t,id,roleName]);
 }
 const app=new URL(url!);app.username=role;app.password=password;connection.pool=new pg.Pool({connectionString:app.toString(),options:`-c search_path=${schema}`,max:1});
 await tx(async c=>{
  await c.query("INSERT INTO warehouses(id,tenant_id,code,name) VALUES($1,$2,'HANDOVER','Handover')",[warehouse,tenant]);
  for(const [label,id] of Object.entries(ids))if(!['noGrant','foreign'].includes(label))await c.query('INSERT INTO v2_warehouse_grants(tenant_id,user_id,warehouse_id) VALUES($1,$2,$3)',[tenant,id,warehouse]);
  await c.query("INSERT INTO locations(id,tenant_id,warehouse_id,code,name,kind) VALUES($1,$2,$3,'COUNT','Count','STORAGE')",[location,tenant,warehouse]);
  await c.query("INSERT INTO items(id,tenant_id,code,name) VALUES($1,$2,'SKU','SKU')",[item,tenant]);
  for(const [label,id] of Object.entries(machineIds)){
   await c.query(`INSERT INTO v2_machine_keys(id,tenant_id,name,source_system,environment,kind,role,scopes,token_hash,expires_at,created_by,revoked_at) VALUES($1,$2,$3,'HANDOVER','test','automation','supervisor',$4,$5,now()+interval '1 day',$6,CASE WHEN $7 THEN now() ELSE NULL END)`,[id,tenant,label,label==='noApprove'?['read','write']:['read','write','approve'],randomBytes(32).toString('hex'),ids.requester,label==='revoked']);
   await c.query('INSERT INTO v2_machine_warehouses(tenant_id,key_id,warehouse_id) VALUES($1,$2,$3)',[tenant,id,warehouse]);
  }
 });
 countId=String((await command(who(ids.requester),'count.start',{location_id:location})).result.id);
 for(const id of [ids.first,ids.last])await command(who(id,'supervisor'),'count.record',{count_id:countId,lines:[{item_id:item,bucket:'S',quantity:0}],recount:true,reason:'Independent physical count'});
 approvalId=String((await command(who(ids.requester),'count.submit',{count_id:countId,reason:'Review all counters'})).result.id);
 // Legacy loss of aggregate fields must not erase actors retained in immutable history.
 const saved=(await owner.query<{state:WorkflowState}>(`SELECT state FROM "${schema}".v2_workflow_state WHERE warehouse_id=$1`,[warehouse])).rows[0].state;
 const approval=saved.approvals.find(row=>row.id===approvalId)!;delete approval.origin_actor_ids;delete approval.request_id;
 delete saved.counts.find(row=>row.id===countId)!.counter_ids;
 await owner.query(`UPDATE "${schema}".v2_workflow_state SET state=$2::jsonb WHERE warehouse_id=$1`,[warehouse,JSON.stringify(saved)]);
},30000);
afterAll(async()=>{
 if(previousEnvironment===undefined)delete process.env.WMS_ENVIRONMENT;else process.env.WMS_ENVIRONMENT=previousEnvironment;
 await connection.pool?.end();try{await owner.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);}finally{if(roleCreated)await owner.query(`DROP ROLE "${role}"`);await owner.end();}
});

it.each(['requester','first','last','worker','noGrant','foreign'] as const)('rejects %s as effective next approver with every workflow effect rolled back',async(label)=>{
 const before=await effects();await expect(close(ids[label])).rejects.toMatchObject({code:'ASSIGNEE_UNAVAILABLE'});expect(await effects()).toEqual(before);
});
it('rechecks a selected human current role, warehouse grant and active membership despite stale candidate data',async()=>{
 for(const change of ['role','grant','status']){
  await tx(c=>change==='grant'?c.query('DELETE FROM v2_warehouse_grants WHERE user_id=$1 AND warehouse_id=$2',[ids.eligible,warehouse]):c.query(`UPDATE memberships SET ${change==='role'?"role='worker'":"status='suspended'"} WHERE user_id=$1`,[ids.eligible]));
  try{const before=await effects();await expect(close(ids.eligible)).rejects.toMatchObject({code:'ASSIGNEE_UNAVAILABLE'});expect(await effects()).toEqual(before);}
  finally{await tx(c=>change==='grant'?c.query('INSERT INTO v2_warehouse_grants(tenant_id,user_id,warehouse_id) VALUES($1,$2,$3)',[tenant,ids.eligible,warehouse]):c.query("UPDATE memberships SET role='supervisor',status='active' WHERE user_id=$1",[ids.eligible]));}
 }
});
it('rejects a barred later duplicate and a differently typed override of an approval owner',async()=>{
 for(const extra of [handover(ids.first),{...handover(ids.worker),object_type:'count'}]){
  const before=await effects();await expect(close(ids.eligible,[extra])).rejects.toMatchObject({code:extra.object_type==='count'?'HANDOVER_REQUIRED':'ASSIGNEE_UNAVAILABLE'});expect(await effects()).toEqual(before);
 }
});
it('retains ordinary worker assignment eligibility for physical work',async()=>{
 expect((await command(who(ids.requester),'task.assign',{object_type:'count',object_id:countId,assignee_id:ids.worker,reason:'Physical counting is worker work',unconfirmed_request_ids:[]})).snapshot.tasks.at(-1)).toMatchObject({object_id:countId,assignee_id:ids.worker});
});
it('requires live machine approve scope and revocation checks on the same single pool connection',async()=>{
 for(const [key,code] of [[machineIds.noApprove,'SCOPE_FORBIDDEN'],[machineIds.revoked,'ASSIGNEE_UNAVAILABLE']]){
  const before=await effects();await expect(close('machine:'+key)).rejects.toMatchObject({code});expect(await effects()).toEqual(before);
 }
 const result=await close('machine:'+machineIds.valid);
 expect(result.snapshot.tasks.at(-1)).toMatchObject({object_id:approvalId,assignee_id:'machine:'+machineIds.valid});expect(result.snapshot.approvals.find(row=>row.id===approvalId)?.status).toBe('pending');
 expect(await assertV2MachineKey(tenant,machineIds.valid,'approve',warehouse)).toMatchObject({role:'supervisor',warehouseIds:[warehouse]});expect(connection.pool!.waitingCount).toBe(0);
});
it('lets the designated eligible reviewer decide, retains separation, and keeps other authorized managers able to review',async()=>{
 await close(ids.eligible);
 for(const id of [ids.requester,ids.first,ids.last])await expect(command(who(id),'approval.decide',{approval_id:approvalId,approve:false,reason:'Must remain separated'})).rejects.toMatchObject({code:'SELF_APPROVAL_FORBIDDEN'});
 const decided=await command(who(ids.eligible,'supervisor'),'approval.decide',{approval_id:approvalId,approve:false,reason:'Independent review'});
 expect(decided.snapshot.approvals.find(row=>row.id===approvalId)).toMatchObject({status:'rejected',decider_id:ids.eligible});
 const next=await command(who(ids.requester),'count.submit',{count_id:countId,reason:'Fresh independent review'});approvalId=String(next.result.id);await close(ids.eligible);
 const override=await command(who(ids.override),'approval.decide',{approval_id:approvalId,approve:false,reason:'Another authorized independent manager'});
 expect(override.snapshot.approvals.find(row=>row.id===approvalId)).toMatchObject({status:'rejected',decider_id:ids.override});expect(override.snapshot.stock).toEqual([]);expect(override.snapshot.ledger_count??0).toBe(0);
});
