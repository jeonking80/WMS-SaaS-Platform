import {randomBytes,randomUUID} from 'node:crypto';
import pg from 'pg';
import {beforeAll,afterAll,describe,it,expect,vi} from 'vitest';
import {migrate} from '../../scripts/db-migrate.mjs';
const state=vi.hoisted(()=>({pool:undefined as pg.Pool|undefined}));
vi.mock('../../src/server/db/pool',()=>({getPool:()=>state.pool}));
import {withTenant} from '../../src/server/db/tenant';
import {acceptEvent,listEvents,type IntegrationIdentity} from '../../src/server/v2/integration';
import {parseEvent} from '../../src/server/v2/integration/contract';
import {tokenHash} from '../../src/server/v2/access';
import {GET} from '../../src/app/api/v2/integration/events/route';
const url=process.env.TEST_DATABASE_URL;
if(!url||!decodeURIComponent(new URL(url).pathname).endsWith('_test'))throw Error('Dedicated _test PostgreSQL required');
const schema='eventquery_'+randomUUID().replaceAll('-',''),role='eq_'+randomUUID().replaceAll('-',''),password=randomBytes(24).toString('hex');
const owner=new pg.Pool({connectionString:url}),appUrl=new URL(url);appUrl.username=role;appUrl.password=password;
const tenant=randomUUID(),foreign=randomUUID(),warehouse=randomUUID(),otherWarehouse=randomUUID(),actor=randomUUID(),key=randomUUID(),otherKey=randomUUID();
const token=`wms_${tenant}.${key}.${randomBytes(32).toString('base64url')}`;
const identity:IntegrationIdentity={tenant:{id:tenant,name:'Query test'},user:{id:'machine:'+key,name:'Source',email:''},role:'worker',sourceSystem:'QUERY',keyId:key};
const admin={...identity,user:{id:actor,name:'Admin',email:actor+'@example.test'},role:'admin' as const,sourceSystem:undefined,keyId:undefined};
const finalExternal='QUERY-101-QUARANTINED',eventIds:string[]=[];
let roleCreated=false;
const tx=<T>(fn:(c:pg.PoolClient)=>Promise<T>)=>withTenant(tenant,fn);
async function get(extra:Record<string,string>={}){return GET(new Request('http://localhost/api/v2/integration/events?'+new URLSearchParams({warehouse_id:warehouse,...extra}),{headers:{authorization:'Bearer '+token}}));}
beforeAll(async()=>{
 process.env.WMS_ENVIRONMENT='test';await owner.query(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD ${pg.escapeLiteral(password)}`);roleCreated=true;
 await migrate(url,{schema,migrationsSchema:schema,createSchema:true,createMigrationsSchema:true,log:()=>{}});
 await owner.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${role}"`);await owner.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA "${schema}" TO "${role}"`);await owner.query(`GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA "${schema}" TO "${role}"`);
 await owner.query(`INSERT INTO "${schema}".tenants(id,name,is_test) VALUES($1,'Query test',true),($2,'Foreign',true)`,[tenant,foreign]);
 await owner.query(`INSERT INTO "${schema}"."user"(id,name,email) VALUES($1,'Admin',$2)`,[actor,admin.user.email]);
 await owner.query(`INSERT INTO "${schema}".memberships(user_id,tenant_id,role) VALUES($1,$2,'admin')`,[actor,tenant]);
 state.pool=new pg.Pool({connectionString:appUrl.toString(),options:`-c search_path=${schema}`,max:4});
 await tx(async c=>{
  await c.query("INSERT INTO warehouses(id,tenant_id,code,name) VALUES($1,$2,'ONE','One'),($3,$2,'TWO','Two')",[warehouse,tenant,otherWarehouse]);
  for(const [id,source]of [[key,'QUERY'],[otherKey,'OTHER']]){
   await c.query(`INSERT INTO v2_machine_keys(id,tenant_id,name,source_system,environment,kind,scopes,token_hash,expires_at,created_by) VALUES($1,$2,'reader',$3,'test','integration',ARRAY['integration:event','integration:read'],$4,now()+interval '1 day',$5)`,[id,tenant,source,id===key?tokenHash(token):'a'.repeat(64),actor]);
   await c.query('INSERT INTO v2_machine_warehouses(tenant_id,key_id,warehouse_id) VALUES($1,$2,$3)',[tenant,id,warehouse]);
  }
 });
 // These are genuine durable envelopes. The result statuses below are a reader-only
 // fixture, not evidence that 100 business workflows executed successfully.
 for(let i=1;i<=101;i++){
  const eventId=randomUUID();eventIds.push(eventId);
  await acceptEvent(identity,parseEvent({schema_version:'2.0',event_id:eventId,source_system:'QUERY',external_entity_id:i===101?finalExternal:'QUERY-'+i,revision:1,event_type:'receipt.create',occurred_at:new Date().toISOString(),correlation_id:'reader-fixture',warehouse_id:warehouse,payload:{}}));
 }
 await tx(c=>c.query(`UPDATE v2_integration_events SET status=CASE WHEN external_entity_id=$1 THEN 'quarantined' ELSE 'applied' END,reason=CASE WHEN external_entity_id=$1 THEN 'READER_FIXTURE' ELSE NULL END`,[finalExternal]));
 await acceptEvent({...identity,sourceSystem:'OTHER',keyId:otherKey},parseEvent({schema_version:'2.0',event_id:randomUUID(),source_system:'OTHER',external_entity_id:finalExternal,revision:1,event_type:'receipt.create',occurred_at:new Date().toISOString(),correlation_id:'other-source',warehouse_id:warehouse,payload:{}}));
},30000);
afterAll(async()=>{await state.pool?.end();try{await owner.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);}finally{if(roleCreated)await owner.query(`DROP ROLE "${role}"`);await owner.end();}});
describe('integration event list covers records beyond the first page in real PostgreSQL',()=>{
 it('reproduces the hidden 101st error and fixes full-scope error filtering/counts through the real authenticated route',async()=>{
  const first=await get();expect(first.status).toBe(200);const page=await first.json();
  expect(page.events).toHaveLength(100);expect(page.events.every((e:{status:string})=>e.status==='applied')).toBe(true);
  const response=await get({status:'dependency_wait,business_rejected,retry_wait,quarantined',limit:'100'});expect(response.status).toBe(200);const errors=await response.json();
  expect(errors.events).toHaveLength(1);expect(errors.events[0]).toMatchObject({event_id:eventIds[100],external_entity_id:finalExternal,status:'quarantined'});
  expect(errors).toMatchObject({has_more:false,total_count:101,filtered_count:1,status_counts:{applied:100,quarantined:1,accepted:0}});
  expect(page).toMatchObject({has_more:true,total_count:101,filtered_count:101});
 });
 it('paginates all records with a stable sequence cursor and untruncated counts',async()=>{
  const page=await (await get()).json(),next=await (await get({cursor:page.cursor})).json();
  expect(next.events).toHaveLength(1);expect(next.events[0].event_id).toBe(eventIds[100]);expect(next).toMatchObject({has_more:false,total_count:101,filtered_count:101});
  expect(new Set([...page.events,...next.events].map((e:{id:string})=>e.id)).size).toBe(101);
  const empty=await (await get({cursor:next.cursor})).json();expect(empty).toMatchObject({events:[],cursor:next.cursor,has_more:false,total_count:101,filtered_count:101});
 });
 it('applies exact external/event/source filters without leaking another source, warehouse or tenant into counts',async()=>{
  for(const field of ['external_id','external_entity_id']){
   const page=await (await get({[field]:finalExternal})).json();expect(page.events).toHaveLength(1);expect(page).toMatchObject({total_count:1,filtered_count:1,status_counts:{quarantined:1,accepted:0}});
  }
  const matched=await (await get({event_id:eventIds[100],status:'applied'})).json();expect(matched).toMatchObject({events:[],total_count:1,filtered_count:0,status_counts:{quarantined:1}});
  const human=await listEvents(admin,warehouse,{externalId:finalExternal});expect(human).toMatchObject({total_count:2,filtered_count:2,status_counts:{quarantined:1,accepted:1}});
  expect(await listEvents(admin,warehouse,{sourceSystem:'OTHER'})).toMatchObject({total_count:1,status_counts:{accepted:1,quarantined:0}});
  expect(await listEvents(identity,otherWarehouse)).toMatchObject({events:[],total_count:0,filtered_count:0});
  expect(await listEvents({...identity,tenant:{id:foreign,name:'Foreign'}},warehouse)).toMatchObject({events:[],total_count:0,filtered_count:0});
  expect((await get({source_system:'OTHER'})).status).toBe(403);
  expect((await get({warehouse_id:otherWarehouse})).status).toBe(403);
  expect((await state.pool!.query('SELECT id FROM v2_integration_events')).rows).toHaveLength(0);
 });
 it('rejects malformed statuses, limits, aliases and overflowing cursors as 400 before SQL casts',async()=>{
  for(const query of ([{status:'unknown'},{status:'applied,'},{limit:'0'},{limit:'101'},{limit:'1.5'},{limit:'1e2'},{cursor:'-1'},{cursor:'9223372036854775808'},{cursor:'99999999999999999999'},{external_id:'a',external_entity_id:'b'}] as Record<string,string>[]))expect((await get(query)).status,JSON.stringify(query)).toBe(400);
 });
});
