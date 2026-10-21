/** Bounded deployment check: existing demo -> upgrade -> same login and usable v2 workspace. */
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {spawn,spawnSync} from 'node:child_process';
import {createServer} from 'node:net';
import {readFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import pg from 'pg';
import {request} from '@playwright/test';
import {hashPassword} from 'better-auth/crypto';
import {renderNeonInit} from './generate-neon-sql.mjs';
import {renderNeonDemo} from './generate-neon-demo.mjs';
import {renderFieldOperationsUpgrade} from './generate-neon-field-operations-upgrade.mjs';
import {roles,tenant,warehouse as oldWarehouse} from './demo-fixture.mjs';

const container='wms-field-operations-deploy-'+randomUUID().slice(0,8),password=randomBytes(24).toString('hex');
const clients=[];let created=false,server,api;
function docker(args,env=process.env){const r=spawnSync('docker',args,{env,encoding:'utf8'});assert.equal(r.status,0,'Local Docker command failed');return r.stdout.trim();}
async function connect(url){const c=new pg.Client({connectionString:String(url),connectionTimeoutMillis:2000});await c.connect();clients.push(c);return c;}
async function snapshot(client){
 await client.query('BEGIN');await client.query('SET LOCAL ROLE wms_migrator');await client.query("SELECT set_config('app.tenant_id',$1,true)",[tenant]);
 const result={};
 try{for(const {tablename:table}of(await client.query("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename<>'pgmigrations' ORDER BY tablename")).rows){
  const columns=(await client.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position",[table])).rows.map(r=>r.column_name);
  result[table]={columns,rows:(await client.query(`SELECT row_to_json(t)::text value FROM (SELECT ${columns.map(pg.escapeIdentifier).join(',')} FROM public.${pg.escapeIdentifier(table)}) t ORDER BY row_to_json(t)::text`)).rows.map(r=>r.value)};
 }return result;}finally{await client.query('ROLLBACK');}
}
try{
 const sql=await renderFieldOperationsUpgrade();assert.equal(sql,await readFile(new URL('../deploy/neon-field-operations.sql',import.meta.url),'utf8'));
 docker(['run','-d','--name',container,'--tmpfs','/var/lib/postgresql/data','-e','POSTGRES_PASSWORD','-p','127.0.0.1::5432','postgres:17.9-bookworm'],{...process.env,POSTGRES_PASSWORD:password});created=true;
 const port=docker(['port',container,'5432/tcp']).split(':').at(-1),base=new URL('postgresql://postgres@127.0.0.1:'+port+'/postgres');base.password=password;
 let admin;for(let n=0;n<60;n++){try{admin=await connect(base);break;}catch{await delay(250);}}assert(admin,'Fresh PostgreSQL unavailable');
 await admin.query('CREATE ROLE neondb_owner LOGIN CREATEROLE PASSWORD '+pg.escapeLiteral(password));await admin.query('CREATE DATABASE wms_demo OWNER neondb_owner');
 const ownerUrl=new URL(base);ownerUrl.username='neondb_owner';ownerUrl.pathname='/wms_demo';const owner=await connect(ownerUrl);
 await owner.query(await renderNeonInit({through:10}));
 const passwords=Object.fromEntries(roles.map(role=>[role,randomBytes(24).toString('hex')]));
 await owner.query(renderNeonDemo(Object.fromEntries(await Promise.all(roles.map(async role=>[role,await hashPassword(passwords[role])])))));
 const before=await snapshot(owner),result=await owner.query(sql);assert.deepEqual(result.at(-1).rows[0],{field_operations_ready:true,migrations_applied:'22',test_warehouse:'운영테스트 창고'});
 await owner.query('BEGIN');await owner.query('SET LOCAL ROLE wms_migrator');await owner.query("SELECT set_config('app.tenant_id',$1,true)",[tenant]);
 for(const [table,original]of Object.entries(before)){
  const rows=(await owner.query(`SELECT row_to_json(t)::text value FROM (SELECT ${original.columns.map(pg.escapeIdentifier).join(',')} FROM public.${pg.escapeIdentifier(table)}) t`)).rows.map(r=>r.value);
  const remaining=[...rows];for(const row of original.rows){const at=remaining.indexOf(row);assert(at>=0,'Original record changed: '+table);remaining.splice(at,1);}
  assert.equal(remaining.length,({warehouses:1,locations:5,items:1,delivery_destinations:1})[table]??0,'Unexpected legacy record addition: '+table);
 }
 const wh=(await owner.query("SELECT id FROM warehouses WHERE code='OPS-V2-TEST'")).rows[0].id;
 assert.notEqual(wh,oldWarehouse);assert.equal((await owner.query('SELECT count(*)::int n FROM v2_warehouse_grants WHERE warehouse_id=$1',[wh])).rows[0].n,3);
 const supplier=(await owner.query("SELECT id FROM business_partners WHERE code='OPS-TEST-PARTNER'")).rows[0].id;
 const item=(await owner.query("SELECT id FROM items WHERE code='OPS-TEST-ITEM'")).rows[0].id;
 const location=(await owner.query("SELECT id FROM locations WHERE warehouse_id=$1 AND kind='RECEIVING'",[wh])).rows[0].id;
 await owner.query('ROLLBACK');
 const once=await snapshot(owner);await owner.query(sql);assert.deepEqual(await snapshot(owner),once,'Rerun must preserve every row');
 await owner.query("BEGIN; INSERT INTO public.pgmigrations(name,run_on) VALUES('unexpected-history',CURRENT_TIMESTAMP)");
 await assert.rejects(owner.query(sql),{code:'P0001'});await owner.query('ROLLBACK');assert.equal((await owner.query('SELECT count(*)::int n FROM pgmigrations')).rows[0].n,22);
 await assert.rejects(admin.query(sql),{code:'P0001'});await admin.query('ROLLBACK');
 await owner.query('ALTER ROLE wms_app LOGIN PASSWORD '+pg.escapeLiteral(password));const appUrl=new URL(ownerUrl);appUrl.username='wms_app';const app=await connect(appUrl);
 await assert.rejects(app.query('UPDATE v2_workflow_ledger SET delta=0'),{code:'42501'});assert.equal((await app.query('SELECT * FROM v2_workflow_stock')).rowCount,0);
 const socket=createServer();await new Promise(resolve=>socket.listen(0,'127.0.0.1',resolve));const webPort=socket.address().port;await new Promise(resolve=>socket.close(resolve));const origin='http://127.0.0.1:'+webPort;
 server=spawn(process.execPath,['.next/standalone/server.js'],{env:{PATH:process.env.PATH,NODE_ENV:'production',DATABASE_URL:String(appUrl),BETTER_AUTH_SECRET:randomBytes(32).toString('hex'),BETTER_AUTH_URL:origin,PORT:String(webPort),HOSTNAME:'127.0.0.1'},stdio:'ignore'});
 for(let n=0;n<100;n++){try{if((await fetch(origin+'/api/ready')).ok)break;}catch{}assert.equal(server.exitCode,null,'App exited');await delay(100);}
 api=await request.newContext({baseURL:origin,extraHTTPHeaders:{Origin:origin}});
 assert.equal((await api.post('/api/auth/sign-in/email',{data:{email:'admin@wms-demo.example.test',password:passwords.admin}})).status(),200,'Original login must still work');
 assert.equal((await api.get('/dashboard/v2')).status(),200);
 assert.equal((await api.get('/api/v2/identity/context')).status(),200);
 const send=async(command,payload)=>api.post('/api/v2/workflow',{data:{warehouse_id:wh,command,request_id:randomUUID(),payload}});
 const receipt=await send('receipt.create',{supplier_id:supplier,expected_at:new Date().toISOString(),lines:[{item_id:item,quantity:10}]});assert.equal(receipt.status(),200);const body=await receipt.json(),data=body.data??body;
 const receiptId=data.result.id,record=data.snapshot.receipts.find(r=>r.id===receiptId);
 const received=await send('receipt.receive',{receipt_id:receiptId,manual_entry_reason:'배포 연결 검증',lines:[{line_id:record.lines[0].id,location_id:location,quantity:10,input_mode:'search'}]});assert.equal(received.status(),200,'New workspace must accept real receiving');
 const receivedBody=await received.json(),receivedData=receivedBody.data??receivedBody;assert.equal(receivedData.snapshot.stock.find(row=>row.item_id===item&&row.location_id===location).Q,10);
 console.log('PASS: limited-owner 10→22 upgrade; original account/password/document/stock/ledger records preserved; rerun unchanged; restricted app; existing admin login; v2 workspace and receipt10 received. External Neon/Vercel execution is pending.');
}catch(error){console.error('Deployment check failed ('+(error.code??error.name)+'): '+String(error.message).slice(0,200));process.exitCode=1;}
finally{await api?.dispose();if(server&&server.exitCode===null){server.kill('SIGTERM');await Promise.race([new Promise(resolve=>server.once('exit',resolve)),delay(5000)]);if(server.exitCode===null)server.kill('SIGKILL');}for(const c of clients.reverse())await c.end().catch(()=>{});if(created)docker(['rm','-f',container]);}
