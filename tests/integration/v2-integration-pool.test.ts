import {randomBytes,randomUUID} from 'node:crypto';
import pg from 'pg';
import {beforeAll,afterAll,it,expect,vi} from 'vitest';
import {migrate} from '../../scripts/db-migrate.mjs';
import type {Identity} from '../../src/server/auth/access';
const state=vi.hoisted(()=>({pool:undefined as pg.Pool|undefined}));
vi.mock('../../src/server/db/pool',()=>({getPool:()=>state.pool}));
import {withTenant} from '../../src/server/db/tenant';
import {assertV2MachineKey,assertV2MachineKeyInTransaction,tokenHash} from '../../src/server/v2/access';
import * as access from '../../src/server/v2/access';
import {acceptEvent,listEvents,processEvents,type IntegrationIdentity} from '../../src/server/v2/integration';
import {parseEvent} from '../../src/server/v2/integration/contract';
const url=process.env.TEST_DATABASE_URL;
if(!url||!decodeURIComponent(new URL(url).pathname).endsWith('_test'))throw Error('Dedicated _test PostgreSQL required');
const schema='int_pool_'+randomUUID().replaceAll('-',''),role='ip_'+randomUUID().replaceAll('-',''),password=randomBytes(24).toString('hex');
const owner=new pg.Pool({connectionString:url}),appUrl=new URL(url);appUrl.username=role;appUrl.password=password;
const tenant=randomUUID(),foreign=randomUUID(),warehouse=randomUUID(),otherWarehouse=randomUUID(),foreignWarehouse=randomUUID(),actor=randomUUID(),foreignActor=randomUUID(),item=randomUUID(),supplier=randomUUID(),key=randomUUID(),foreignKey=randomUUID();
const token=`wms_${tenant}.${key}.${randomBytes(32).toString('base64url')}`,originalEnvironment=process.env.WMS_ENVIRONMENT;let roleCreated=false;
const admin:Identity={tenant:{id:tenant,name:'Single connection fixture'},user:{id:actor,name:'Admin',email:actor+'@example.test'},role:'admin'};
const source:IntegrationIdentity={...admin,user:{id:'machine:'+key,name:'Source',email:''},role:'worker',sourceSystem:'POOL',keyId:key};
const tx=<T>(fn:(client:pg.PoolClient)=>Promise<T>)=>withTenant(tenant,fn);
const event=()=>parseEvent({schema_version:'2.0',event_id:randomUUID(),source_system:'POOL',external_entity_id:randomUUID(),revision:1,event_type:'receipt.create',occurred_at:new Date().toISOString(),correlation_id:'single-connection-fixture',warehouse_id:warehouse,payload:{supplier_id:supplier,expected_at:'2026-11-01T00:00:00Z',lines:[{item_id:item,quantity:1}]}});
beforeAll(async()=>{
 process.env.WMS_ENVIRONMENT='test';await owner.query(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD ${pg.escapeLiteral(password)}`);roleCreated=true;
 await migrate(url,{schema,migrationsSchema:schema,createSchema:true,createMigrationsSchema:true,log:()=>{}});
 await owner.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${role}"`);await owner.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA "${schema}" TO "${role}"`);await owner.query(`GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA "${schema}" TO "${role}"`);
 await owner.query(`INSERT INTO "${schema}".tenants(id,name,is_test) VALUES($1,'Single connection fixture',true),($2,'Foreign fixture',true)`,[tenant,foreign]);
 for(const[id,t]of[[actor,tenant],[foreignActor,foreign]]){await owner.query(`INSERT INTO "${schema}"."user"(id,name,email) VALUES($1,'Admin',$2)`,[id,id+'@example.test']);await owner.query(`INSERT INTO "${schema}".memberships(user_id,tenant_id,role) VALUES($1,$2,'admin')`,[id,t]);}
 // Exactly one application connection: a nested withTenant cannot ever acquire a spare.
 state.pool=new pg.Pool({connectionString:appUrl.toString(),options:`-c search_path=${schema}`,max:1,connectionTimeoutMillis:500});
 await tx(async c=>{
  await c.query("INSERT INTO warehouses(id,tenant_id,code,name) VALUES($1,$2,'ONE','One'),($3,$2,'TWO','Two')",[warehouse,tenant,otherWarehouse]);
  await c.query("INSERT INTO items(id,tenant_id,code,name) VALUES($1,$2,'SKU','SKU')",[item,tenant]);
  await c.query("INSERT INTO business_partners(id,tenant_id,code,name,supplier) VALUES($1,$2,'SUPPLIER','Supplier',true)",[supplier,tenant]);
  await c.query(`INSERT INTO v2_machine_keys(id,tenant_id,name,source_system,environment,kind,scopes,token_hash,expires_at,created_by) VALUES($1,$2,'Source','POOL','test','integration',ARRAY['integration:event','integration:read'],$3,now()+interval '1 day',$4)`,[key,tenant,tokenHash(token),actor]);
  await c.query('INSERT INTO v2_machine_warehouses(tenant_id,key_id,warehouse_id) VALUES($1,$2,$3)',[tenant,key,warehouse]);
 });
 await withTenant(foreign,async c=>{await c.query("INSERT INTO warehouses(id,tenant_id,code,name) VALUES($1,$2,'FOREIGN','Foreign')",[foreignWarehouse,foreign]);await c.query(`INSERT INTO v2_machine_keys(id,tenant_id,name,source_system,environment,kind,scopes,token_hash,expires_at,created_by) VALUES($1,$2,'Foreign','FOREIGN','test','integration',ARRAY['integration:event'],$3,now()+interval '1 day',$4)`,[foreignKey,foreign,'a'.repeat(64),foreignActor]);await c.query('INSERT INTO v2_machine_warehouses(tenant_id,key_id,warehouse_id) VALUES($1,$2,$3)',[foreign,foreignKey,foreignWarehouse]);});
},30000);
afterAll(async()=>{if(originalEnvironment===undefined)delete process.env.WMS_ENVIRONMENT;else process.env.WMS_ENVIRONMENT=originalEnvironment;await state.pool?.end();try{await owner.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);}finally{if(roleCreated)await owner.query(`DROP ROLE "${role}"`);await owner.end();}});

it('processes and commits an actual queued event using only its one outer pool connection',async()=>{
 const input=event(),accepted=await acceptEvent(source,input),connect=vi.spyOn(state.pool!,'connect');
 try{const processed=await processEvents(admin,warehouse,1);expect(processed.events).toMatchObject([{id:accepted.event.id,status:'applied',reason:null}]);expect(connect).toHaveBeenCalledTimes(1);expect(state.pool!.waitingCount).toBe(0);}finally{connect.mockRestore();}
 expect((await listEvents(source,warehouse,{eventId:input.event_id})).events).toMatchObject([{status:'applied'}]);
 const stored=await tx(c=>c.query('SELECT response FROM v2_workflow_requests WHERE request_id=$1',[accepted.event.id]));expect(stored.rows[0].response.result.id).toEqual(expect.any(String));
});

it('commits the active event after budget exhaustion and leaves subsequent PostgreSQL events untouched for later calls',async()=>{
 const inputs=[event(),event(),event()],queued=[];
 for(const input of inputs)queued.push(await acceptEvent(source,input));
 let monotonic=0;
 const originalAuthorize=access.assertV2MachineKeyInTransaction;
 const clock=vi.spyOn(performance,'now').mockImplementation(()=>monotonic);
 const authorize=vi.spyOn(access,'assertV2MachineKeyInTransaction').mockImplementation(async(...args)=>{
  const authorized=await originalAuthorize(...args);
  // No sleep and no fake database: expiry occurs during the real active event.
  monotonic=6000;return authorized;
 });
 try{
  expect((await processEvents(admin,warehouse,50)).events).toMatchObject([{id:queued[0].event.id,status:'applied',attempts:1}]);
  expect(authorize).toHaveBeenCalledTimes(1);
 }finally{authorize.mockRestore();clock.mockRestore();}
 const ids=queued.map(row=>row.event.id);
 const remaining=await tx(c=>c.query('SELECT id,status,attempts,result,processed_at FROM v2_integration_events WHERE id=ANY($1::uuid[]) ORDER BY sequence',[ids]));
 expect(remaining.rows).toEqual([
  expect.objectContaining({id:ids[0],status:'applied',attempts:1}),
  {id:ids[1],status:'accepted',attempts:0,result:null,processed_at:null},
  {id:ids[2],status:'accepted',attempts:0,result:null,processed_at:null},
 ]);
 expect((await tx(c=>c.query('SELECT request_id FROM v2_workflow_requests WHERE request_id=ANY($1::uuid[])',[ids]))).rows).toEqual([{request_id:ids[0]}]);
 // One-event calls always attempt progress, irrespective of elapsed batch time.
 for(const id of ids.slice(1))expect((await processEvents(admin,warehouse,1)).events).toMatchObject([{id,status:'applied',attempts:1}]);
 expect((await processEvents(admin,warehouse,1)).events).toEqual([]);
 expect((await tx(c=>c.query('SELECT request_id FROM v2_workflow_requests WHERE request_id=ANY($1::uuid[]) ORDER BY request_id',[ids]))).rows.map(row=>row.request_id)).toEqual([...ids].sort());
 expect((await tx(c=>c.query('SELECT revision FROM v2_integration_entities WHERE external_entity_id=ANY($1::text[])',[inputs.map(input=>input.external_entity_id)]))).rows).toEqual([{revision:1},{revision:1},{revision:1}]);
 for(let i=0;i<inputs.length;i++)expect(await acceptEvent(source,inputs[i])).toMatchObject({replayed:true,event:{id:ids[i],status:'applied',attempts:1}});
});

it('rechecks a revoked issuing key on that same connection and commits rejection without business effects',async()=>{
 const input=event(),accepted=await acceptEvent(source,input);await tx(c=>c.query('UPDATE v2_machine_keys SET revoked_at=statement_timestamp() WHERE id=$1',[key]));
 const connect=vi.spyOn(state.pool!,'connect');try{expect((await processEvents(admin,warehouse,1)).events).toMatchObject([{id:accepted.event.id,status:'business_rejected',reason:'INVALID_MACHINE_KEY'}]);expect(connect).toHaveBeenCalledTimes(1);}finally{connect.mockRestore();await tx(c=>c.query('UPDATE v2_machine_keys SET revoked_at=NULL WHERE id=$1',[key]));}
 expect((await tx(c=>c.query('SELECT 1 FROM v2_workflow_requests WHERE request_id=$1',[accepted.event.id]))).rowCount).toBe(0);
});

it('rejects mismatched tenant settings, foreign keys, unauthorized warehouses and scopes without acquiring another connection',async()=>{
 const connect=vi.spyOn(state.pool!,'connect');
 try{await tx(async c=>{
  const active=await assertV2MachineKeyInTransaction(c,tenant,key,'integration:event',warehouse);expect(active).toMatchObject({tenant:{id:tenant,isTest:true},keyId:key,sourceSystem:'POOL',warehouseIds:[warehouse]});
  await expect(assertV2MachineKeyInTransaction(c,foreign,foreignKey,'integration:event',foreignWarehouse)).rejects.toMatchObject({status:403,code:'TENANT_CONTEXT_MISMATCH'});
  await expect(assertV2MachineKeyInTransaction(c,tenant,foreignKey,'integration:event',warehouse)).rejects.toMatchObject({status:401,code:'INVALID_MACHINE_KEY'});
  await expect(assertV2MachineKeyInTransaction(c,tenant,key,'integration:event',otherWarehouse)).rejects.toMatchObject({status:403,code:'WAREHOUSE_FORBIDDEN'});
  await expect(assertV2MachineKeyInTransaction(c,tenant,key,'write',warehouse)).rejects.toMatchObject({status:403,code:'SCOPE_FORBIDDEN'});
  await c.query("SELECT set_config('app.environment','production',true)");await expect(assertV2MachineKeyInTransaction(c,tenant,key,'integration:event',warehouse)).rejects.toMatchObject({status:403,code:'ENVIRONMENT_FORBIDDEN'});await c.query("SELECT set_config('app.environment','test',true)");
  expect((await c.query("SELECT current_setting('app.tenant_id') AS tenant_id")).rows[0].tenant_id).toBe(tenant);
 });expect(connect).toHaveBeenCalledTimes(1);}finally{connect.mockRestore();}
 // The standalone entry point retains the same checks and still owns its own transaction.
 await expect(assertV2MachineKey(tenant,key,'integration:event',otherWarehouse)).rejects.toMatchObject({code:'WAREHOUSE_FORBIDDEN'});
});

it('checks current tenant activation, environment, scopes and statement-time expiry inside an already begun transaction',async()=>{
 await tx(async c=>{
  await c.query('UPDATE tenants SET active=false WHERE id=$1',[tenant]);await expect(assertV2MachineKeyInTransaction(c,tenant,key,'integration:event',warehouse)).rejects.toMatchObject({code:'INVALID_MACHINE_KEY'});await c.query('UPDATE tenants SET active=true WHERE id=$1',[tenant]);
  await c.query("UPDATE v2_machine_keys SET scopes=ARRAY['integration:read'] WHERE id=$1",[key]);await expect(assertV2MachineKeyInTransaction(c,tenant,key,'integration:event',warehouse)).rejects.toMatchObject({code:'SCOPE_FORBIDDEN'});await c.query("UPDATE v2_machine_keys SET scopes=ARRAY['integration:event','integration:read'] WHERE id=$1",[key]);
  // Between transaction start and this statement, so CURRENT_TIMESTAMP would accept
  // this expired key. No sleeps or timing thresholds are needed to exercise the boundary.
  await c.query('UPDATE v2_machine_keys SET expires_at=CURRENT_TIMESTAMP+(statement_timestamp()-CURRENT_TIMESTAMP)/2 WHERE id=$1',[key]);
  expect((await c.query('SELECT expires_at>CURRENT_TIMESTAMP AS after_transaction_start,expires_at<statement_timestamp() AS already_expired FROM v2_machine_keys WHERE id=$1',[key])).rows[0]).toEqual({after_transaction_start:true,already_expired:true});
  await expect(assertV2MachineKeyInTransaction(c,tenant,key,'integration:event',warehouse)).rejects.toMatchObject({code:'INVALID_MACHINE_KEY'});await c.query("UPDATE v2_machine_keys SET expires_at=statement_timestamp()+interval '1 day' WHERE id=$1",[key]);
  process.env.WMS_ENVIRONMENT='production';try{await expect(assertV2MachineKeyInTransaction(c,tenant,key,'integration:event',warehouse)).rejects.toMatchObject({code:'ENVIRONMENT_FORBIDDEN'});}finally{process.env.WMS_ENVIRONMENT='test';}
  expect((await assertV2MachineKeyInTransaction(c,tenant,key,'integration:event',warehouse)).keyId).toBe(key);
 });
});
