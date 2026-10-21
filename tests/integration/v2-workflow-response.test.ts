import {randomUUID,randomBytes} from 'node:crypto';
import pg from 'pg';
import {beforeAll,afterAll,it,expect,expectTypeOf,vi} from 'vitest';
import {migrate} from '../../scripts/db-migrate.mjs';
import type {Identity} from '../../src/server/auth/access';
const state=vi.hoisted(()=>({pool:undefined as pg.Pool|undefined}));
vi.mock('../../src/server/db/pool',()=>({getPool:()=>state.pool}));
import {withTenant} from '../../src/server/db/tenant';
import {requireV2Access} from '../../src/server/v2/access';
import {executeWorkflowInTransaction,getWorkflowSnapshot,type WorkflowInput,type WorkflowResponse,type WorkflowCompactResponse} from '../../src/server/v2/workflow';
const url=process.env.TEST_DATABASE_URL;
if(!url||!decodeURIComponent(new URL(url).pathname).endsWith('_test'))throw Error('Dedicated _test database required');
const schema='v2_response_'+randomUUID().replaceAll('-',''),role='app_'+randomUUID().replaceAll('-',''),password=randomBytes(24).toString('hex');
const owner=new pg.Pool({connectionString:url}),tenant=randomUUID(),actor=randomUUID(),warehouse=randomUUID(),receiving=randomUUID(),item=randomUUID(),supplier=randomUUID();let created=false;
const identity:Identity={tenant:{id:tenant,name:'Response fixture'},user:{id:actor,name:'Response manager',email:actor+'@example.test'},role:'admin'};
beforeAll(async()=>{
 await migrate(url,{schema,migrationsSchema:schema,createSchema:true,createMigrationsSchema:true,log:()=>{}});await owner.query(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD ${pg.escapeLiteral(password)}`);created=true;
 await owner.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${role}"`);await owner.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA "${schema}" TO "${role}"`);
 await owner.query(`INSERT INTO "${schema}".tenants(id,name) VALUES($1,'Response fixture')`,[tenant]);await owner.query(`INSERT INTO "${schema}"."user"(id,name,email) VALUES($1,'Response manager',$2)`,[actor,identity.user.email]);await owner.query(`INSERT INTO "${schema}".memberships(tenant_id,user_id,role) VALUES($1,$2,'admin')`,[tenant,actor]);
 const connection=new URL(url!);connection.username=role;connection.password=password;state.pool=new pg.Pool({connectionString:connection.toString(),options:`-c search_path=${schema}`});
 await withTenant(tenant,async c=>{await c.query("INSERT INTO warehouses(id,tenant_id,code,name) VALUES($1,$2,'RESPONSE','Response warehouse')",[warehouse,tenant]);await c.query('INSERT INTO v2_warehouse_grants(tenant_id,user_id,warehouse_id) VALUES($1,$2,$3)',[tenant,actor,warehouse]);await c.query("INSERT INTO locations(id,tenant_id,warehouse_id,code,name,kind) VALUES($1,$2,$3,'RECEIVING','Receiving','RECEIVING')",[receiving,tenant,warehouse]);await c.query("INSERT INTO items(id,tenant_id,code,name) VALUES($1,$2,'SKU','Response item')",[item,tenant]);await c.query("INSERT INTO business_partners(id,tenant_id,code,name,supplier) VALUES($1,$2,'SUPPLIER','Response supplier',true)",[supplier,tenant]);});
},30000);
afterAll(async()=>{await state.pool?.end();try{await owner.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);}finally{try{if(created)await owner.query(`DROP ROLE "${role}"`);}finally{await owner.end();}}});
const createInput=():WorkflowInput=>({warehouse_id:warehouse,request_id:randomUUID(),command:'receipt.create',payload:{supplier_id:supplier,expected_at:'2026-11-01T00:00:00Z',lines:[{item_id:item,quantity:10}]}});
function traced(c:pg.PoolClient,queries:string[]){return new Proxy(c,{get(target,key){if(key==='query')return(...args:unknown[])=>{queries.push(typeof args[0]==='string'?args[0]:String((args[0] as {text?:string})?.text));return Reflect.apply(target.query,target,args);};return Reflect.get(target,key,target);}});}
async function full(input:WorkflowInput){await requireV2Access(identity,warehouse,'write');const queries:string[]=[];const value=await withTenant(tenant,c=>executeWorkflowInTransaction(traced(c,queries),identity,input));return{value,queries};}
async function compact(input:WorkflowInput){await requireV2Access(identity,warehouse,'write');const queries:string[]=[];const value=await withTenant(tenant,c=>executeWorkflowInTransaction(traced(c,queries),identity,input,{includeSnapshot:false}));return{value,queries};}
it('keeps the default snapshot type and every SQL operation when only internal response presentation is omitted',async()=>{
 const ordinary=await full(createInput()),minimal=await compact(createInput());expectTypeOf(ordinary.value).toEqualTypeOf<WorkflowResponse>();expectTypeOf(minimal.value).toEqualTypeOf<WorkflowCompactResponse>();
 expect(ordinary.value.snapshot.receipts.some(r=>r.id===ordinary.value.result.id)).toBe(true);expect(Object.keys(minimal.value).sort()).toEqual(['replayed','result','version']);expect(minimal.value.version).toBe(ordinary.value.snapshot.version+1);expect(minimal.value.replayed).toBe(false);
 // This includes both aggregate checks and all location/history queries; compact mode skips no SQL.
 expect(minimal.queries).toEqual(ordinary.queries);expect(minimal.queries.filter(sql=>sql.startsWith('SELECT item_id,location_id,s,r,p,q,b FROM v2_workflow_stock'))).toHaveLength(2);
});
it('replays the original result/version across representation changes and preserves independent persisted-ledger checks',async()=>{
 const input=createInput(),first=await full(input);await compact(createInput());const minimal=await compact(input),ordinary=await full(input);
 expect(minimal.value).toEqual({result:first.value.result,version:first.value.snapshot.version,replayed:true});expect(ordinary.value.result).toEqual(first.value.result);expect(ordinary.value.snapshot.version).toBeGreaterThan(minimal.value.version);
 expect(minimal.queries).toEqual(ordinary.queries);expect(minimal.queries.some(sql=>sql.startsWith('WITH l AS (SELECT item_id,location_id'))).toBe(true);
 const saved=await withTenant(tenant,c=>c.query('SELECT response FROM v2_workflow_requests WHERE request_id=$1',[input.request_id]));expect(saved.rows[0].response).toEqual({result:first.value.result,version:first.value.snapshot.version});
});
it('keeps physical effects, scan rejection, idempotency conflicts and corrupt-stock rejection in compact mode',async()=>{
 const created=await full(createInput()),receipt=created.value.snapshot.receipts.find(r=>r.id===created.value.result.id)!;
 const input:WorkflowInput={warehouse_id:warehouse,request_id:randomUUID(),command:'receipt.receive',payload:{receipt_id:receipt.id,receiving_id:randomUUID(),manual_entry_reason:'Physical item and location independently compared',lines:[{line_id:receipt.lines[0].id,quantity:5,location_id:receiving,input_mode:'search'}]}};
 const applied=await compact(input);expect(applied.value).not.toHaveProperty('snapshot');const replay=await full(input);expect(replay.value.result).toEqual(applied.value.result);expect(replay.value.snapshot.stock.find(s=>s.item_id===item&&s.location_id===receiving)?.Q).toBe(5);
 const stored=await withTenant(tenant,c=>c.query('SELECT count(*)::int n,sum(delta)::int quantity FROM v2_workflow_ledger WHERE request_id=$1',[input.request_id]));expect(stored.rows[0]).toEqual({n:1,quantity:5});
 await expect(compact({...input,payload:{...input.payload,reason:'Different intent under original key'}})).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
 const invalid={...input,request_id:randomUUID(),payload:{receipt_id:receipt.id,receiving_id:randomUUID(),lines:[{line_id:receipt.lines[0].id,quantity:1,location_id:receiving}]}};await expect(compact(invalid)).rejects.toMatchObject({code:'INVALID_SCAN_MODE'});await expect(full({...invalid,request_id:randomUUID()})).rejects.toMatchObject({code:'INVALID_SCAN_MODE'});
 await owner.query(`UPDATE "${schema}".v2_workflow_stock SET q=q+1 WHERE warehouse_id=$1`,[warehouse]);try{await expect(compact(createInput())).rejects.toMatchObject({code:'RECONCILIATION_FAILED'});await expect(full(createInput())).rejects.toMatchObject({code:'RECONCILIATION_FAILED'});}finally{await owner.query(`UPDATE "${schema}".v2_workflow_stock SET q=q-1 WHERE warehouse_id=$1`,[warehouse]);}
 expect((await getWorkflowSnapshot(identity,warehouse)).reconciliation.ok).toBe(true);
});
