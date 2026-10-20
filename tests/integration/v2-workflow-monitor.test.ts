import {randomUUID,randomBytes} from 'node:crypto';
import pg from 'pg';
import {beforeAll,afterAll,it,expect} from 'vitest';
import {migrate} from '../../scripts/db-migrate.mjs';
import {collectMonitor} from '../../scripts/v2-monitor-lib.mjs';
const url=process.env.TEST_DATABASE_URL;
if(!url||!decodeURIComponent(new URL(url).pathname).endsWith('_test'))throw Error('Dedicated _test database required');
const schema='v2_alert_'+randomUUID().replaceAll('-',''),role='app_'+randomUUID().replaceAll('-',''),password=randomBytes(24).toString('hex');
const owner=new pg.Pool({connectionString:url});let app:pg.Pool|undefined,created=false;
const tenant=randomUUID(),foreign=randomUUID(),actor=randomUUID(),warehouse=randomUUID(),otherWarehouse=randomUUID(),delayedWarehouse=randomUUID(),foreignWarehouse=randomUUID();
const quarantined=randomUUID(),delayed=randomUUID(),foreignEvent=randomUUID(),now=new Date('2030-01-01T00:00:00Z');
beforeAll(async()=>{
 await migrate(url,{schema,migrationsSchema:schema,createSchema:true,createMigrationsSchema:true,log:()=>{}});
 await owner.query(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD ${pg.escapeLiteral(password)}`);created=true;
 await owner.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${role}"`);await owner.query(`GRANT SELECT ON ALL TABLES IN SCHEMA "${schema}" TO "${role}"`);
 await owner.query(`INSERT INTO "${schema}".tenants(id,name) VALUES($1,'Scoped alert tenant'),($2,'Foreign alert tenant')`,[tenant,foreign]);
 await owner.query(`INSERT INTO "${schema}"."user"(id,name,email) VALUES($1,'Alert manager',$2)`,[actor,actor+'@example.test']);
 await owner.query(`INSERT INTO "${schema}".memberships(tenant_id,user_id,role) VALUES($1,$2,'admin')`,[tenant,actor]);
 for(const[id,t,code]of[[warehouse,tenant,'MAIN'],[otherWarehouse,tenant,'OTHER'],[delayedWarehouse,tenant,'DELAY'],[foreignWarehouse,foreign,'FOREIGN']]){await owner.query(`INSERT INTO "${schema}".warehouses(id,tenant_id,code,name) VALUES($1,$2,$3,$3)`,[id,t,code]);if(t===tenant)await owner.query(`INSERT INTO "${schema}".v2_warehouse_grants(tenant_id,user_id,warehouse_id) VALUES($1,$2,$3)`,[tenant,actor,id]);}
 async function insert(id:string,t:string,w:string,status:string,at:string){await owner.query(`INSERT INTO "${schema}".v2_integration_events(id,tenant_id,warehouse_id,source_system,actor_id,source_key_id,event_id,entity_kind,external_entity_id,revision,event_type,schema_version,occurred_at,correlation_id,request_hash,revision_hash,payload,status,received_at)
 VALUES($1::uuid,$2,$3,'alert-regression',$4,$5,$6,'order',$1::text,1,'order.create','2.0',$7,'alert-regression',$8,$8,$9::jsonb,$10,$7)`,[id,t,w,actor,randomUUID(),randomUUID(),at,'a'.repeat(64),JSON.stringify({private:'never_expose_raw_payload'}),status]);}
 // These accepted rows have lower sequence values than the actual quarantine.
 for(let i=0;i<10;i++)await insert(randomUUID(),tenant,warehouse,'accepted','2029-12-31T23:59:00Z');
 await insert(quarantined,tenant,warehouse,'quarantined','2029-12-31T23:58:00Z');
 await insert(randomUUID(),tenant,otherWarehouse,'accepted','2029-12-31T23:59:00Z');
 await insert(foreignEvent,foreign,foreignWarehouse,'quarantined','2029-12-31T23:00:00Z');
 for(let i=0;i<10;i++)await insert(randomUUID(),tenant,delayedWarehouse,'accepted','2029-12-31T23:59:00Z');
 await insert(delayed,tenant,delayedWarehouse,'retry_wait','2029-12-31T23:30:00Z');
 const connection=new URL(url!);connection.username=role;connection.password=password;app=new pg.Pool({connectionString:connection.toString(),options:`-c search_path=${schema}`});
},30000);
afterAll(async()=>{await app?.end();try{await owner.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);}finally{try{if(created)await owner.query(`DROP ROLE "${role}"`);}finally{await owner.end();}}});
async function report(warehouseIds:string[]){const c=await app!.connect();try{await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await c.query("SELECT set_config('app.tenant_id',$1,true),set_config('app.user_id',$2,true),set_config('app.environment','test',true)",[tenant,actor]);
 expect((await c.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0]).toEqual({rolsuper:false,rolbypassrls:false});expect((await c.query('SELECT relforcerowsecurity FROM pg_class WHERE oid=\'v2_integration_events\'::regclass')).rows[0].relforcerowsecurity).toBe(true);
 expect((await c.query('SELECT id FROM v2_integration_events WHERE id=$1',[foreignEvent])).rowCount).toBe(0);
 const result=await collectMonitor(c,{tenantId:tenant,warehouseIds,now,pendingMinutes:15});await c.query('COMMIT');return result;
 }finally{await c.query('ROLLBACK');c.release();}}
it('references quarantine eleven after ten accepted rows, preserving aggregate counts and exact authorized warehouse links',async()=>{
 const r=await report([warehouse,otherWarehouse]);expect(r.checks.find(c=>c.name==='integration_queue')).toMatchObject({details:{pending:11,quarantined:1,rejected:0}});
 const alerts=r.alerts.filter(a=>a.code==='INTEGRATION_QUARANTINED');expect(alerts).toHaveLength(1);expect(alerts[0].warehouses.map(w=>w.id)).toEqual([warehouse]);expect(alerts[0].references.map(x=>x.business_id)).toEqual([quarantined]);expect(new URL(alerts[0].action.path,'https://wms.invalid').searchParams.get('event_id')).toBe(quarantined);
 expect(JSON.stringify(r.alerts)).not.toContain(foreignEvent);expect(JSON.stringify(r)).not.toContain('never_expose_raw_payload');
});
it('references the old pending incident after ten fresh accepted rows and excludes quarantine from another warehouse',async()=>{
 const r=await report([delayedWarehouse]);expect(r.checks.find(c=>c.name==='integration_queue')).toMatchObject({details:{pending:11,quarantined:0,oldest_pending_minutes:30}});
 const alert=r.alerts.find(a=>a.code==='INTEGRATION_QUEUE_DELAYED')!;expect(alert.references.map(x=>x.business_id)).toEqual([delayed]);expect(new URL(alert.action.path,'https://wms.invalid').searchParams.get('event_id')).toBe(delayed);expect(r.alerts.some(a=>a.code==='INTEGRATION_QUARANTINED')).toBe(false);expect(JSON.stringify(r)).not.toContain(quarantined);
});
