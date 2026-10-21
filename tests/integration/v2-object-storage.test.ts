import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {afterAll,expect,it} from 'vitest';
import {migrate} from '../../scripts/db-migrate.mjs';
import {emptyState,type WorkflowState} from '../../src/server/v2/workflow/types';
import {readWorkflowState,writeWorkflowState} from '../../src/server/v2/workflow/object-storage';
const url=process.env.TEST_DATABASE_URL;
if(!url||!decodeURIComponent(new URL(url).pathname).endsWith('_test'))throw Error('Dedicated _test database required');
const schema='v2_body_'+randomUUID().replaceAll('-','');
const owner=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`});
const options={schema,migrationsSchema:schema,createSchema:true,createMigrationsSchema:true,log:()=>{}};
afterAll(async()=>{await owner.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await owner.end();});
it('backfills all bodies without loss, resumes changed-only writes, rolls back atomically and reverses/replays migration',async()=>{
 await migrate(url,{...options,count:19});
 const tenant=randomUUID(),warehouse=randomUUID();
 await owner.query("INSERT INTO tenants(id,name) VALUES($1,'Body migration')",[tenant]);
 await owner.query("INSERT INTO warehouses(id,tenant_id,code,name) VALUES($1,$2,'BODY','Body migration')",[warehouse,tenant]);
 const object={id:randomUUID(),version:7,legacy:{actor:'departed',delivery:{address:'original'}},closed:true};
 // Deliberately includes duplicate IDs and all historically supported arrays.
 const original={...emptyState(),version:17,ledger_count:900,stock:[{item_id:randomUUID(),location_id:randomUUID(),S:0,R:0,P:0,Q:0,B:0,reservation_blocked:true,location_kind:'HOLD'}],receipts:[object],orders:[object],returns:[object],packages:[object],shipments:[object],approvals:[object],counts:[object],tasks:[object],shifts:[object,{...object,version:8}],holds:[object],receiving_ids:['old','old'],location_blocks:[object],ledger_base:[],future_array:[null,5,{id:'future'}],extra:{preserved:true}} as unknown as WorkflowState;
 await owner.query('INSERT INTO v2_workflow_state(tenant_id,warehouse_id,version,state) VALUES($1,$2,$3,$4::jsonb)',[tenant,warehouse,original.version,JSON.stringify(original)]);
 await migrate(url,options);
 expect((await owner.query('SELECT state FROM v2_workflow_state')).rows[0].state).toEqual(original);
 const header=(await owner.query('SELECT state,storage_format FROM v2_workflow_state_header')).rows[0];
 expect(header.storage_format).toBe(2);expect(header.state.orders).toEqual([]);expect(header.state.extra).toEqual({preserved:true});
 const client=await owner.connect();
 let after:WorkflowState;
 try{
  await client.query('BEGIN');const before=(await readWorkflowState(client,tenant,warehouse,'UPDATE'))!;
  after=structuredClone(before);after.version++;after.shifts[1].version=9;
  await writeWorkflowState(client,tenant,warehouse,before,after);
  expect((await client.query('SELECT count(*)::int n FROM v2_workflow_object_state WHERE changed_version=$1',[after.version])).rows[0].n).toBe(1);
  await client.query('ROLLBACK');
  expect((await owner.query('SELECT state FROM v2_workflow_state')).rows[0].state).toEqual(original);
  await client.query('BEGIN');await readWorkflowState(client,tenant,warehouse,'UPDATE');await writeWorkflowState(client,tenant,warehouse,original,after);await client.query('COMMIT');
 }finally{client.release();}
 expect((await owner.query('SELECT state FROM v2_workflow_state')).rows[0].state).toEqual(after!);
 // A waiting reader must hydrate with the post-lock statement snapshot.
 const writer=await owner.connect(),reader=await owner.connect();
 try{
  const readerPid=(await reader.query('SELECT pg_backend_pid() pid')).rows[0].pid;
  await writer.query('BEGIN');await readWorkflowState(writer,tenant,warehouse,'UPDATE');
  const newest=structuredClone(after!);newest.version++;newest.shifts[0].after_wait=true;
  await writeWorkflowState(writer,tenant,warehouse,after!,newest);
  await reader.query('BEGIN');const pending=readWorkflowState(reader,tenant,warehouse,'SHARE');
  let blocked=false;
  for(let attempt=0;attempt<100&&!blocked;attempt++)blocked=(await owner.query('SELECT cardinality(pg_blocking_pids($1))>0 blocked',[readerPid])).rows[0].blocked;
  expect(blocked).toBe(true);await writer.query('COMMIT');expect(await pending).toEqual(newest);await reader.query('COMMIT');after=newest;
 }finally{await writer.query('ROLLBACK');await reader.query('ROLLBACK');writer.release();reader.release();}
 // Legacy whole-body SQL transforms must retry if a warehouse writer commits
 // while their view statement is waiting; they must never overwrite new bodies.
 const concurrent=await owner.connect(),legacy=await owner.connect();
 try{
  const legacyPid=(await legacy.query('SELECT pg_backend_pid() pid')).rows[0].pid;
  await concurrent.query('BEGIN');await readWorkflowState(concurrent,tenant,warehouse,'UPDATE');
  const newest=structuredClone(after!);newest.version++;newest.shifts[0].concurrent='retained';
  await writeWorkflowState(concurrent,tenant,warehouse,after!,newest);
  await legacy.query('BEGIN');
  const pending=legacy.query(`UPDATE v2_workflow_state SET state=jsonb_set(state,'{version}','999') WHERE tenant_id=$1`,[tenant]).then(()=>null,error=>error);
  let blocked=false;
  for(let attempt=0;attempt<100&&!blocked;attempt++)blocked=(await owner.query('SELECT cardinality(pg_blocking_pids($1))>0 blocked',[legacyPid])).rows[0].blocked;
  expect(blocked).toBe(true);await concurrent.query('COMMIT');expect(await pending).toMatchObject({code:'40001'});await legacy.query('ROLLBACK');after=newest;
  expect((await owner.query('SELECT state FROM v2_workflow_state')).rows[0].state).toEqual(newest);
 }finally{await concurrent.query('ROLLBACK');await legacy.query('ROLLBACK');concurrent.release();legacy.release();}
 await migrate(url,{...options,direction:'down',count:1});
 expect((await owner.query('SELECT state FROM v2_workflow_state')).rows[0].state).toEqual(after!);
 await migrate(url,options);
 expect((await owner.query('SELECT state FROM v2_workflow_state')).rows[0].state).toEqual(after!);
 // Legacy body replacement remains a complete, lossless write after cutover.
 await owner.query('UPDATE v2_workflow_state SET state=$1::jsonb',[JSON.stringify(original)]);
 expect((await owner.query('SELECT state FROM v2_workflow_state')).rows[0].state).toEqual(original);
 const policies=await owner.query("SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='v2_workflow_object_state'::regclass");
 expect(policies.rows).toEqual([{relrowsecurity:true,relforcerowsecurity:true}]);
});

it('backfills every tenant under a real table-owner migrator without superuser or BYPASSRLS',async()=>{
 const role='body_owner_'+randomUUID().replaceAll('-',''),owned='body_owned_'+randomUUID().replaceAll('-',''),password=randomUUID();
 const roleUrl=new URL(url!);roleUrl.username=role;roleUrl.password=password;
 const opts={...options,schema:owned,migrationsSchema:owned,createSchema:false,createMigrationsSchema:false};
 await owner.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS`);
 try{
  await owner.query(`CREATE SCHEMA "${owned}" AUTHORIZATION "${role}"`);
  await migrate(roleUrl.toString(),{...opts,count:19});
  const ids=[randomUUID(),randomUUID()],warehouses=[randomUUID(),randomUUID()];
  const saved=ids.map((_,i)=>({...emptyState(),version:3+i,shifts:[{id:'same',actor:'original-'+i}],receiving_ids:['legacy-'+i]}));
  for(let i=0;i<ids.length;i++){
   await owner.query(`INSERT INTO "${owned}".tenants(id,name) VALUES($1,'Nonbypass migration')`,[ids[i]]);
   await owner.query(`INSERT INTO "${owned}".warehouses(id,tenant_id,code,name) VALUES($1,$2,'BODY','Nonbypass migration')`,[warehouses[i],ids[i]]);
   await owner.query(`INSERT INTO "${owned}".v2_workflow_state(tenant_id,warehouse_id,version,state) VALUES($1,$2,$3,$4::jsonb)`,[ids[i],warehouses[i],saved[i].version,JSON.stringify(saved[i])]);
  }
  // A legacy malformed row must abort the whole migration, retaining the old
  // relation and every valid body's original JSON for repair and retry.
  await owner.query(`UPDATE "${owned}".v2_workflow_state SET state='[]'::jsonb WHERE tenant_id=$1`,[ids[1]]);
  await expect(migrate(roleUrl.toString(),opts)).rejects.toMatchObject({code:'22023'});
  expect((await owner.query('SELECT to_regclass($1) relation',[`${owned}.v2_workflow_state_header`])).rows[0].relation).toBeNull();
  expect((await owner.query(`SELECT state FROM "${owned}".v2_workflow_state WHERE tenant_id=$1`,[ids[0]])).rows[0].state).toEqual(saved[0]);
  await owner.query(`UPDATE "${owned}".v2_workflow_state SET state=$1::jsonb WHERE tenant_id=$2`,[JSON.stringify(saved[1]),ids[1]]);
  await migrate(roleUrl.toString(),opts);
  for(let i=0;i<ids.length;i++)expect((await owner.query(`SELECT state FROM "${owned}".v2_workflow_state WHERE tenant_id=$1`,[ids[i]])).rows[0].state).toEqual(saved[i]);
  expect((await owner.query(`SELECT count(*)::int n FROM "${owned}".v2_workflow_object_state`)).rows[0].n).toBe(4);
  await migrate(roleUrl.toString(),{...opts,direction:'down',count:1});
  for(let i=0;i<ids.length;i++)expect((await owner.query(`SELECT state FROM "${owned}".v2_workflow_state WHERE tenant_id=$1`,[ids[i]])).rows[0].state).toEqual(saved[i]);
 }finally{
  await owner.query(`DROP SCHEMA IF EXISTS "${owned}" CASCADE`);await owner.query(`DROP ROLE "${role}"`);
 }
});
