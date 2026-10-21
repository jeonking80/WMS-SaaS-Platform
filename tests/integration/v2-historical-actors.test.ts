import {randomBytes,randomUUID} from 'node:crypto';
import pg from 'pg';
import {it,expect,vi} from 'vitest';
import {migrate} from '../../scripts/db-migrate.mjs';
import type {Identity} from '../../src/server/auth/access';
const state=vi.hoisted(()=>({pool:undefined as pg.Pool|undefined}));
vi.mock('../../src/server/db/pool',()=>({getPool:()=>state.pool}));
import {emptyState,getWorkflowSnapshot,listWorkflowLedger} from '../../src/server/v2/workflow';
import {identityContext} from '../../src/server/v2/identity/service';
const url=process.env.TEST_DATABASE_URL;
if(!url||!decodeURIComponent(new URL(url).pathname).endsWith('_test'))throw Error('Dedicated _test database required');
it('identifies departed people and revoked keys only on scoped history, without restoring assignment eligibility',async()=>{
 const suffix=randomBytes(12).toString('hex'),schema='history_'+suffix,role='history_app_'+suffix,password=randomBytes(24).toString('hex');
 const owner=new pg.Pool({connectionString:url}),binding=new URL(url);binding.username=role;binding.password=password;
 const tenant=randomUUID(),foreign=randomUUID(),actor=randomUUID(),departed=randomUUID(),foreignActor=randomUUID(),key=randomUUID(),foreignKey=randomUUID(),warehouse=randomUUID(),foreignWarehouse=randomUUID(),item=randomUUID(),location=randomUUID(),request=randomUUID();
 const identity:Identity={tenant:{id:tenant,name:'History'},user:{id:actor,name:'Active administrator',email:'active@example.invalid'},role:'admin'};
 let created=false;
 try{
  await owner.query(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD ${pg.escapeLiteral(password)}`);created=true;
  await migrate(url,{schema,migrationsSchema:schema,createSchema:true,createMigrationsSchema:true,log:()=>{}});
  await owner.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${role}"`);await owner.query(`GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA "${schema}" TO "${role}"`);
  state.pool=new pg.Pool({connectionString:binding.href,options:`-c search_path=${schema}`});
  const c=await owner.connect();try{
   await c.query('BEGIN');await c.query(`SET LOCAL search_path TO "${schema}"`);
   await c.query("INSERT INTO tenants(id,name,is_test) VALUES($1,'History',true),($2,'Foreign',true)",[tenant,foreign]);
   for(const [id,company,name,status]of [[actor,tenant,'Active administrator','active'],[departed,tenant,'Retained departed person','departed'],[foreignActor,foreign,'FOREIGN SECRET NAME','active']]){
    await c.query('INSERT INTO "user"(id,name,email) VALUES($1,$2,$3)',[id,name,id+'@example.invalid']);await c.query("INSERT INTO memberships(user_id,tenant_id,role,status) VALUES($1,$2,'admin',$3)",[id,company,status]);
   }
   for(const [id,company]of [[warehouse,tenant],[foreignWarehouse,foreign]])await c.query("INSERT INTO warehouses(id,tenant_id,code,name) VALUES($1,$2,'H','History')",[id,company]);
   await c.query('INSERT INTO v2_warehouse_grants(tenant_id,user_id,warehouse_id) VALUES($1,$2,$3),($1,$4,$3)',[tenant,actor,warehouse,departed]);
   await c.query("INSERT INTO items(id,tenant_id,code,name) VALUES($1,$2,'H','History item')",[item,tenant]);await c.query("INSERT INTO locations(id,tenant_id,warehouse_id,code,name) VALUES($1,$2,$3,'H','History location')",[location,tenant,warehouse]);
   for(const [id,company,creator,name]of [[key,tenant,actor,'Retained revoked automation'],[foreignKey,foreign,foreignActor,'FOREIGN SECRET KEY']])await c.query("INSERT INTO v2_machine_keys(id,tenant_id,name,source_system,environment,kind,role,scopes,token_hash,expires_at,revoked_at,created_by) VALUES($1,$2,$3,'history','test','automation','worker',ARRAY['read','write'],$4,CURRENT_TIMESTAMP+interval '1 day',CURRENT_TIMESTAMP,$5)",[id,company,name,randomBytes(32).toString('hex'),creator]);
   await c.query('INSERT INTO v2_machine_warehouses(tenant_id,key_id,warehouse_id) VALUES($1,$2,$3)',[tenant,key,warehouse]);
   const saved=emptyState();saved.version=1;saved.stock=[{item_id:item,location_id:location,S:4,R:0,P:0,Q:0,B:0}];
   await c.query('INSERT INTO v2_workflow_state(tenant_id,warehouse_id,version,state) VALUES($1,$2,1,$3::jsonb)',[tenant,warehouse,JSON.stringify(saved)]);
   await c.query('INSERT INTO v2_workflow_stock(tenant_id,warehouse_id,item_id,location_id,s,r,p,q,b) VALUES($1,$2,$3,$4,4,0,0,0,0)',[tenant,warehouse,item,location]);
   await c.query("INSERT INTO v2_workflow_requests(tenant_id,warehouse_id,request_id,request_hash,command,actor_id,response) VALUES($1,$2,$3,$4,'history.fixture',$5,'{\"version\":1}')",[tenant,warehouse,request,'0'.repeat(64),actor]);
   for(const id of [departed,'machine:'+key,foreignActor,'machine:'+foreignKey])await c.query("INSERT INTO v2_workflow_ledger(id,tenant_id,warehouse_id,item_id,location_id,request_id,actor_id,command,bucket,delta) VALUES($1,$2,$3,$4,$5,$6,$7,'history.fixture','S',1)",[randomUUID(),tenant,warehouse,item,location,request,id]);
   await c.query('COMMIT');
  }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
  const page=await listWorkflowLedger(identity,{warehouse_id:warehouse});
  expect(page.rows.find(row=>row.actor_id===departed)?.actor_name).toBe('Retained departed person');
  expect(page.rows.find(row=>row.actor_id==='machine:'+key)?.actor_name).toBe('Retained revoked automation');
  expect(page.rows.filter(row=>[foreignActor,'machine:'+foreignKey].includes(row.actor_id)).every(row=>row.actor_name===undefined)).toBe(true);
  expect(JSON.stringify(page).includes('FOREIGN SECRET')).toBe(false);
  const snapshot=await getWorkflowSnapshot(identity,warehouse);expect(snapshot.ledger.find(row=>row.actor_id===departed)?.actor_name).toBe('Retained departed person');expect(snapshot.reconciliation.ok).toBe(true);
  const context=await identityContext(identity);expect(context.assignees.some(row=>row.userId===departed)).toBe(false);expect(context.automationAccounts.some(row=>row.userId==='machine:'+key)).toBe(false);
  await expect(listWorkflowLedger(identity,{warehouse_id:foreignWarehouse})).rejects.toMatchObject({status:403});
 }finally{await state.pool?.end();await owner.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);if(created)await owner.query(`DROP ROLE "${role}"`);await owner.end();}
},30000);
