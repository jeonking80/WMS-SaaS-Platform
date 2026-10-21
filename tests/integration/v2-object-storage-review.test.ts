import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {afterAll,expect,it} from 'vitest';
import {migrate} from '../../scripts/db-migrate.mjs';
import {emptyState,type WorkflowState} from '../../src/server/v2/workflow/types';
import {readWorkflowState,writeWorkflowState,claimLoadedWorkflowState} from '../../src/server/v2/workflow/object-storage';
import {ownDetachedWorkflowState} from '../../src/server/v2/workflow/owned-state';
import {executeWorkflowInTransaction} from '../../src/server/v2/workflow';

const url=process.env.TEST_DATABASE_URL;
if(!url||!decodeURIComponent(new URL(url).pathname).endsWith('_test'))throw Error('Dedicated _test database required');
const schema='body_review_'+randomUUID().replaceAll('-','');
const owner=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`});
const options={schema,migrationsSchema:schema,createSchema:true,createMigrationsSchema:true,log:()=>{}};
afterAll(async()=>{try{await owner.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);}finally{await owner.end();}});

it('requires a captured UPDATE-read baseline before ownership or owned persistence',async()=>{
 const draft=emptyState();expect(()=>claimLoadedWorkflowState(draft)).toThrow('captured UPDATE-read baseline');
 ownDetachedWorkflowState(draft);let queries=0;
 const client={query:()=>{queries++;throw Error('SQL must not run');}} as unknown as pg.PoolClient;
 await expect(writeWorkflowState(client,randomUUID(),randomUUID(),draft,draft)).rejects.toThrow('Owned workflow lost persisted baseline');expect(queries).toBe(0);
});

it('keeps nonstring legacy IDs writable after backfill and compatibility replacement',async()=>{
 await migrate(url,{...options,count:19});
 const tenant=randomUUID(),warehouse=randomUUID();
 await owner.query("INSERT INTO tenants(id,name) VALUES($1,'Mixed ID review')",[tenant]);
 await owner.query("INSERT INTO warehouses(id,tenant_id,code,name) VALUES($1,$2,'MIXED','Mixed ID review')",[warehouse,tenant]);
 const original={...emptyState(),version:3,future_array:[{id:123,note:'numeric'},{id:true,note:'boolean'},{id:{nested:1},note:'object'},{id:['nested'],note:'array'},{id:null,note:'null'}],future_scalar_array:[null,3,false,'retained',['nested']],future_metadata:{retained:true}} as unknown as WorkflowState;
 await owner.query('INSERT INTO v2_workflow_state(tenant_id,warehouse_id,version,state) VALUES($1,$2,$3,$4::jsonb)',[tenant,warehouse,original.version,JSON.stringify(original)]);
 await migrate(url,options);
 const client=await owner.connect();
 try{
  for(let pass=0;pass<2;pass++){
   if(pass)await client.query('UPDATE v2_workflow_state SET state=$1::jsonb WHERE tenant_id=$2',[JSON.stringify(original),tenant]);
   await client.query('BEGIN');
   const before=(await readWorkflowState(client,tenant,warehouse,'UPDATE'))!;
   expect(before).toEqual(original);
   const after=structuredClone(before);after.version++;
   for(const body of (after as unknown as {future_array:{note:string}[]}).future_array)body.note+=' changed';
   await writeWorkflowState(client,tenant,warehouse,before,after);
   await client.query('COMMIT');
   expect((await owner.query('SELECT state FROM v2_workflow_state WHERE tenant_id=$1',[tenant])).rows[0].state).toEqual(after);
   // Reorder and remove bodies, including scalar/null arrays, without losing
   // their complete content or introducing unique-position conflicts.
   await client.query('BEGIN');
   const previous=(await readWorkflowState(client,tenant,warehouse,'UPDATE'))!;
   const reordered=structuredClone(previous) as unknown as WorkflowState&{future_array:unknown[];future_scalar_array:unknown[];future_metadata?:unknown};
   reordered.version++;reordered.future_array.reverse();reordered.future_array.splice(2,1);
   reordered.future_scalar_array.reverse();reordered.future_scalar_array.splice(1,1);delete reordered.future_metadata;
   await writeWorkflowState(client,tenant,warehouse,previous,reordered);
   await client.query('COMMIT');
   expect((await owner.query('SELECT state FROM v2_workflow_state WHERE tenant_id=$1',[tenant])).rows[0].state).toEqual(reordered);
  }
 }finally{await client.query('ROLLBACK');client.release();}
});

it('rolls back a late normalized-write failure with stock, requests and history and safely retries once',async()=>{
 const tenant=randomUUID(),warehouse=randomUUID(),actor=randomUUID(),item=randomUUID(),supplier=randomUUID(),receiving=randomUUID();
 const identity={tenant:{id:tenant,name:'Atomic review'},user:{id:actor,name:'Reviewer',email:actor+'@review.invalid'},role:'admin' as const};
 await owner.query("INSERT INTO tenants(id,name) VALUES($1,'Atomic review')",[tenant]);
 await owner.query('INSERT INTO "user"(id,name,email) VALUES($1,\'Reviewer\',$2)',[actor,identity.user.email]);
 await owner.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'admin')",[tenant,actor]);
 await owner.query("INSERT INTO warehouses(id,tenant_id,code,name) VALUES($1,$2,'ATOMIC','Atomic review')",[warehouse,tenant]);
 await owner.query('INSERT INTO v2_warehouse_grants(tenant_id,user_id,warehouse_id) VALUES($1,$2,$3)',[tenant,actor,warehouse]);
 await owner.query("INSERT INTO items(id,tenant_id,code,name) VALUES($1,$2,'ITEM','Review item')",[item,tenant]);
 await owner.query("INSERT INTO locations(id,tenant_id,warehouse_id,code,name,kind) VALUES($1,$2,$3,'RECEIVING','Receiving','RECEIVING')",[receiving,tenant,warehouse]);
 await owner.query("INSERT INTO business_partners(id,tenant_id,code,name,supplier) VALUES($1,$2,'SUPPLIER','Review supplier',true)",[supplier,tenant]);
 const client=await owner.connect();
 const transaction=async(input:Parameters<typeof executeWorkflowInTransaction>[2])=>{
  try{await client.query('BEGIN');const response=await executeWorkflowInTransaction(client,identity,input);await client.query('COMMIT');return response;}
  catch(error){await client.query('ROLLBACK');throw error;}
 };
 try{
  const created=await transaction({warehouse_id:warehouse,request_id:randomUUID(),command:'receipt.create',payload:{supplier_id:supplier,expected_at:'2026-11-01T00:00:00Z',lines:[{item_id:item,quantity:2}]}});
  const receipt=created.snapshot.receipts.find(r=>r.id===created.result.id)!;
  const input={warehouse_id:warehouse,request_id:randomUUID(),command:'receipt.receive',payload:{receipt_id:receipt.id,receiving_id:randomUUID(),manual_entry_reason:'Physical item independently compared',lines:[{line_id:receipt.lines[0].id,quantity:2,location_id:receiving,input_mode:'search'}]}};
  const original=(await owner.query('SELECT state FROM v2_workflow_state WHERE tenant_id=$1',[tenant])).rows[0].state;
  const originalBodies=(await owner.query('SELECT kind,object_key,position,body,changed_version FROM v2_workflow_object_state WHERE tenant_id=$1 ORDER BY kind,position',[tenant])).rows;
  await owner.query("CREATE FUNCTION reject_review_header() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected late persistence failure' USING ERRCODE='P0001'; END $$");
  await owner.query(`CREATE TRIGGER reject_review_header BEFORE UPDATE ON v2_workflow_state_header FOR EACH ROW WHEN (NEW.tenant_id='${tenant}'::uuid) EXECUTE FUNCTION reject_review_header()`);
  try{await expect(transaction(input)).rejects.toMatchObject({code:'P0001'});}
  finally{await owner.query('DROP TRIGGER reject_review_header ON v2_workflow_state_header');await owner.query('DROP FUNCTION reject_review_header()');}
  expect((await owner.query('SELECT state FROM v2_workflow_state WHERE tenant_id=$1',[tenant])).rows[0].state).toEqual(original);
  expect((await owner.query('SELECT kind,object_key,position,body,changed_version FROM v2_workflow_object_state WHERE tenant_id=$1 ORDER BY kind,position',[tenant])).rows).toEqual(originalBodies);
  for(const relation of ['v2_workflow_requests','v2_workflow_performances','v2_workflow_ledger','v2_workflow_receivings'])expect((await owner.query(`SELECT count(*)::int n FROM ${relation} WHERE tenant_id=$1 AND request_id=$2`,[tenant,input.request_id])).rows[0].n).toBe(0);
  expect((await owner.query('SELECT count(*)::int n FROM v2_workflow_stock WHERE tenant_id=$1',[tenant])).rows[0].n).toBe(0);
  // A failed owned draft is never reused after SQL savepoint rollback. The next
  // invocation on the same client must reload the complete current DB graph.
  await client.query('BEGIN');await client.query('SAVEPOINT owned_failure');
  const lateFailure={...input,payload:{...input.payload,lines:[...input.payload.lines.map(line=>({...line,quantity:1})),{...input.payload.lines[0],quantity:0}]}};
  await expect(executeWorkflowInTransaction(client,identity,lateFailure,{includeSnapshot:false})).rejects.toMatchObject({code:'INVALID_QUANTITY'});
  await client.query('ROLLBACK TO SAVEPOINT owned_failure');
  expect((await client.query('SELECT state FROM v2_workflow_state WHERE tenant_id=$1',[tenant])).rows[0].state).toEqual(original);
  const compactRetry=await executeWorkflowInTransaction(client,identity,input,{includeSnapshot:false});await client.query('COMMIT');expect(compactRetry.replayed).toBe(false);
  const retried=await transaction(input),replayed=await transaction(input);
  expect(retried.replayed).toBe(true);expect(retried.snapshot.version).toBe(original.version+1);expect(replayed.replayed).toBe(true);expect(replayed.result).toEqual(retried.result);
  expect((await owner.query('SELECT count(*)::int n,sum(delta)::int quantity FROM v2_workflow_ledger WHERE tenant_id=$1 AND request_id=$2',[tenant,input.request_id])).rows[0]).toEqual({n:1,quantity:2});
 }finally{await client.query('ROLLBACK');client.release();}
});

it('enforces tenant and warehouse RLS through the invoker view, helpers, and legacy writes',async()=>{
 const role='body_reader_'+randomUUID().replaceAll('-',''),password=randomUUID();
 const tenant=randomUUID(),foreignTenant=randomUUID(),actor=randomUUID();
 const warehouses=[randomUUID(),randomUUID(),randomUUID()];
 await owner.query(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD ${pg.escapeLiteral(password)}`);
 let app:pg.Pool|undefined;
 try{
  await owner.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${role}"`);
  await owner.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA "${schema}" TO "${role}"`);
  await owner.query("INSERT INTO tenants(id,name) VALUES($1,'Visible tenant'),($2,'Foreign tenant')",[tenant,foreignTenant]);
  await owner.query('INSERT INTO "user"(id,name,email) VALUES($1,\'Reviewer\',$2)',[actor,actor+'@review.invalid']);
  await owner.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'admin')",[tenant,actor]);
  for(let i=0;i<warehouses.length;i++){
   const t=i===2?foreignTenant:tenant;
   await owner.query('INSERT INTO warehouses(id,tenant_id,code,name) VALUES($1,$2,$3,\'Review warehouse\')',[warehouses[i],t,'W'+i]);
   await owner.query('INSERT INTO v2_workflow_state(tenant_id,warehouse_id,version,state) VALUES($1,$2,1,$3::jsonb)',[t,warehouses[i],JSON.stringify({...emptyState(),version:1,shifts:[{id:'retained-'+i}]})]);
  }
  await owner.query('INSERT INTO v2_warehouse_grants(tenant_id,user_id,warehouse_id) VALUES($1,$2,$3)',[tenant,actor,warehouses[0]]);
  const connection=new URL(url!);connection.username=role;connection.password=password;
  app=new pg.Pool({connectionString:connection.toString(),options:`-c search_path=${schema}`});
  const client=await app.connect();
  try{
   await client.query('BEGIN');
   await client.query("SELECT set_config('app.tenant_id',$1,true),set_config('app.user_id',$2,true)",[tenant,actor]);
   for(const relation of ['v2_workflow_state','v2_workflow_state_header','v2_workflow_object_state']){
    const rows=await client.query(`SELECT DISTINCT tenant_id,warehouse_id FROM ${relation}`);
    expect(rows.rows).toEqual([{tenant_id:tenant,warehouse_id:warehouses[0]}]);
   }
   for(const [t,w] of [[tenant,warehouses[1]],[foreignTenant,warehouses[2]]]){
    expect((await client.query("SELECT v2_workflow_full_state($1,$2,'{}'::jsonb) state",[t,w])).rows[0].state).toEqual({});
    expect((await client.query('UPDATE v2_workflow_state SET version=version+1 WHERE tenant_id=$1 AND warehouse_id=$2',[t,w])).rowCount).toBe(0);
    expect((await client.query('DELETE FROM v2_workflow_state WHERE tenant_id=$1 AND warehouse_id=$2',[t,w])).rowCount).toBe(0);
    await client.query('SAVEPOINT denied');
    await expect(client.query("INSERT INTO v2_workflow_object_state(tenant_id,warehouse_id,kind,object_key,position,body,changed_version) VALUES($1,$2,'shifts','denied',99,'{}',1)",[t,w])).rejects.toMatchObject({code:'42501'});
    await client.query('ROLLBACK TO SAVEPOINT denied');
   }
   const visible={...emptyState(),version:2,shifts:[{id:'updated-visible'}]};
   expect((await client.query('UPDATE v2_workflow_state SET version=2,state=$1::jsonb WHERE warehouse_id=$2 RETURNING state',[JSON.stringify(visible),warehouses[0]])).rows[0].state).toEqual(visible);
   expect(await readWorkflowState(client,tenant,warehouses[0],'SHARE')).toEqual(visible);
   await client.query('ROLLBACK');
  }finally{await client.query('ROLLBACK');client.release();}
  expect((await owner.query("SELECT reloptions FROM pg_class WHERE oid='v2_workflow_state'::regclass")).rows[0].reloptions).toContain('security_invoker=true');
  expect((await owner.query("SELECT bool_and(NOT prosecdef) invoker FROM pg_proc WHERE oid IN ('v2_workflow_full_state(uuid,uuid,jsonb)'::regprocedure,'v2_workflow_legacy_state_write()'::regprocedure)")).rows[0].invoker).toBe(true);
 }finally{await app?.end();await owner.query(`DROP OWNED BY "${role}"`);await owner.query(`DROP ROLE "${role}"`);}
});
