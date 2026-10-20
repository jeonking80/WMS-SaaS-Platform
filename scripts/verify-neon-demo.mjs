/** Verify the SQL Editor fixture with real PostgreSQL and the prebuilt app. */
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import pg from 'pg';
import { request } from '@playwright/test';
import { hashPassword } from 'better-auth/crypto';
import { renderNeonInit } from './generate-neon-sql.mjs';
import { renderNeonDemo } from './generate-neon-demo.mjs';

const container='wms-neon-demo-'+randomUUID().slice(0,8);
const databasePassword=randomBytes(24).toString('hex');
const roles=['viewer','worker','admin'];
const passwords=Object.fromEntries(roles.map(role=>[role,randomBytes(24).toString('hex')]));
const clients=[]; let created=false,server;
function docker(args,env=process.env) {
  const result=spawnSync('docker',args,{encoding:'utf8',env});
  if(result.status!==0)throw new Error('Docker test command failed.');
  return result.stdout.trim();
}
async function connect(url) {const client=new pg.Client({connectionString:url,connectionTimeoutMillis:2000});await client.connect();clients.push(client);return client;}
try {
  const hashes=Object.fromEntries(await Promise.all(roles.map(async role=>[role,await hashPassword(passwords[role])])));
  const sql=renderNeonDemo(hashes);
  for(const password of Object.values(passwords))assert(!sql.includes(password),'Plaintext password must not enter SQL.');
  docker(['run','-d','--name',container,'--tmpfs','/var/lib/postgresql/data','-e','POSTGRES_PASSWORD',
    '-p','127.0.0.1::5432','postgres:17.9-bookworm'],{...process.env,POSTGRES_PASSWORD:databasePassword});created=true;
  const port=docker(['port',container,'5432/tcp']).split(':').at(-1);
  const url=new URL('postgresql://postgres@127.0.0.1:'+port+'/postgres');url.password=databasePassword;
  let admin;
  for(let attempt=0;attempt<60;attempt++){try{admin=await connect(url.href);break;}catch{await delay(500);}}
  if(!admin)throw new Error('Temporary database unavailable.');
  await admin.query('CREATE ROLE neondb_owner LOGIN CREATEROLE PASSWORD '+pg.escapeLiteral(databasePassword));
  await admin.query('CREATE DATABASE wms_demo OWNER neondb_owner');
  const ownerUrl=new URL(url);ownerUrl.username='neondb_owner';ownerUrl.pathname='/wms_demo';
  const owner=await connect(ownerUrl.href);
  await owner.query(await renderNeonInit());
  const result=await owner.query(sql);
  const summary=result.findLast(entry=>entry.rows[0]?.ledger_entries);
  assert.deepEqual(summary.rows[0],{demo_users:'3',items:'3',documents:'6',ledger_entries:'6',balances:'4',audit_entries:'5'});
  assert.deepEqual(result.at(-1).rows[0],{demo_users:'3',credential_accounts:'3'});
  const before=(await owner.query('SELECT "userId",password FROM account ORDER BY "userId"')).rows;
  await assert.rejects(owner.query(sql),{code:'P0001'});await owner.query('ROLLBACK');
  assert.deepEqual((await owner.query('SELECT "userId",password FROM account ORDER BY "userId"')).rows,before);
  await owner.query('ALTER ROLE wms_migrator LOGIN PASSWORD '+pg.escapeLiteral(databasePassword));
  const migratorUrl=new URL(ownerUrl);migratorUrl.username='wms_migrator';
  const rerun=spawnSync(process.execPath,['scripts/demo-seed.mjs'],{encoding:'utf8',env:{...process.env,
    MIGRATION_DATABASE_URL:migratorUrl.href,WMS_DEMO_SEED:'synthetic-only',DEMO_DATABASE_NAME:'wms_demo',
    DEMO_VIEWER_PASSWORD:passwords.viewer,DEMO_WORKER_PASSWORD:passwords.worker,DEMO_ADMIN_PASSWORD:passwords.admin}});
  assert.equal(rerun.status,0,'Existing CLI seed must validate exported fixture.');
  assert.deepEqual((await owner.query('SELECT "userId",password FROM account ORDER BY "userId"')).rows,before);
  await owner.query('ALTER ROLE wms_app LOGIN PASSWORD '+pg.escapeLiteral(databasePassword));
  const appUrl=new URL(ownerUrl);appUrl.username='wms_app';
  const listener=createServer();await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));
  const webPort=listener.address().port;await new Promise(resolve=>listener.close(resolve));
  const origin='http://127.0.0.1:'+webPort;
  server=spawn(process.execPath,['node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','--port',String(webPort)],
    {env:{...process.env,NODE_ENV:'production',DATABASE_URL:appUrl.href,BETTER_AUTH_URL:origin,
      BETTER_AUTH_SECRET:randomBytes(24).toString('hex')},stdio:'ignore'});
  let ready=false;
  for(let attempt=0;attempt<120;attempt++){
    if(server.exitCode!==null)throw new Error('Owned app server exited.');
    try{if((await fetch(origin+'/api/ready')).ok){ready=true;break;}}catch{}
    await delay(500);
  }
  assert(ready,'Prebuilt app must become ready.');
  for(const role of roles){
    const context=await request.newContext({baseURL:origin});
    try{
      const login=await context.post('/api/auth/sign-in/email',{headers:{Origin:origin},data:{email:role+'@wms-demo.example.test',password:passwords[role]}});
      assert.equal(login.status(),200,'Generated credential must authenticate.');
      const me=await(await context.get('/api/me')).json();assert.equal(me.role,role);assert.equal(me.tenant.id,'70000000-0000-4000-8000-000000000001');
      assert.equal((await context.get('/api/documents')).status(),role==='viewer'?403:200);
      assert.equal((await context.get('/api/audit-logs')).status(),role==='admin'?200:403);
      const history=await(await context.get('/api/documents?view=history')).json();assert.equal(history.pagination.total,5);
      assert.equal((await(await context.get('/api/stock/reconcile')).json()).consistent,true);
    }finally{await context.dispose();}
  }
  console.log('PASS: SQL fixture counts and reconciliation; plaintext absent from SQL; repeat refusal; original seed compatibility; real admin/worker/viewer login and role restrictions.');
}catch(error){console.error('Neon demo verification failed ('+(error.code??error.name)+').');process.exitCode=1;}
finally{
  if(server&&server.exitCode===null){const exit=new Promise(resolve=>server.once('exit',resolve));server.kill('SIGTERM');await Promise.race([exit,delay(5000)]);if(server.exitCode===null){server.kill('SIGKILL');await exit;}}
  await Promise.all(clients.map(client=>client.end()));
  if(created){try{docker(['rm','-f',container]);}catch{console.error('Remove only this test container: '+container);process.exitCode=1;}}
}
