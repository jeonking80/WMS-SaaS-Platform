import {randomBytes} from 'node:crypto';
import {fork,type ChildProcess} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import pg from 'pg';
import {it,expect} from 'vitest';
import {migrate} from '../../scripts/db-migrate.mjs';

const databaseUrl=process.env.TEST_DATABASE_URL;
if(!databaseUrl||!decodeURIComponent(new URL(databaseUrl).pathname).endsWith('_test'))throw Error('Dedicated _test database required');
it('atomically shares login limits across independent processes and retains them after restart',async()=>{
 const suffix=randomBytes(12).toString('hex'),schema='auth_limit_'+suffix,role='auth_limit_app_'+suffix;
 const owner=new pg.Pool({connectionString:databaseUrl}),secret=randomBytes(48).toString('hex'),password=randomBytes(24).toString('hex');
 const binding=new URL(databaseUrl);binding.username=role;binding.password=password;
 const workers:ChildProcess[]=[];let created=false;
 function worker(){
  const child=fork(fileURLToPath(new URL('../fixtures/auth-rate-limit-worker.mjs',import.meta.url)),[],{
   execArgv:[],stdio:['ignore','ignore','ignore','ipc'],env:{...process.env,AUTH_LIMIT_TEST_SCHEMA:schema,AUTH_LIMIT_TEST_DATABASE_URL:binding.href,AUTH_LIMIT_TEST_SECRET:secret},
  });workers.push(child);
  let readyResolve!:()=>void,readyReject!:(error:Error)=>void,resultResolve!:(statuses:number[])=>void,fail!:(error:Error)=>void;
  const ready=new Promise<void>((resolve,reject)=>{readyResolve=resolve;readyReject=reject;child.once('error',()=>reject(Error('Authentication fixture process unavailable')));});
  const result=new Promise<number[]>((resolve,reject)=>{resultResolve=resolve;fail=reject;});
  // Readiness may fail before run() attaches its consumer.
  void result.catch(()=>{});
  // A startup failure must reject readiness too, rather than hang to timeout.
  child.on('message',(message:unknown)=>{const value=message as {ready?:boolean;statuses?:number[];failed?:boolean};if(value.ready)readyResolve();if(value.statuses)resultResolve(value.statuses);if(value.failed){readyReject(Error('Authentication fixture failed'));fail(Error('Authentication fixture failed'));}});
  child.on('exit',code=>{if(code){readyReject(Error('Authentication fixture exited unsuccessfully'));fail(Error('Authentication fixture exited unsuccessfully'));}});
  return{ready,run:(count:number)=>{child.send({count});return result;}};
 }
 try{
  await owner.query(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD ${pg.escapeLiteral(password)}`);created=true;
  await migrate(databaseUrl,{schema,migrationsSchema:schema,createSchema:true,createMigrationsSchema:true,log:()=>{}});
  await owner.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${role}"`);
  for(const table of ['user','account','session','verification','rateLimit'])await owner.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON "${schema}".${pg.escapeIdentifier(table)} TO "${role}"`);
  const a=worker(),b=worker();await Promise.all([a.ready,b.ready]);
  const statuses=(await Promise.all([a.run(4),b.run(4)])).flat();
  // Installed BetterAuth's sign-in rule is three attempts per ten seconds.
  expect(statuses.filter(status=>status===401)).toHaveLength(3);
  expect(statuses.filter(status=>status===429)).toHaveLength(5);
  expect((await owner.query(`SELECT count FROM "${schema}"."rateLimit"`)).rows).toEqual([{count:3}]);
  const restarted=worker();await restarted.ready;expect(await restarted.run(1)).toEqual([429]);
  // Expiration fixture avoids wall-clock sleeps while exercising real handlers.
  await owner.query(`UPDATE "${schema}"."rateLimit" SET "lastRequest"=$1`,[Date.now()-60000]);
  const expired=worker();await expired.ready;expect(await expired.run(1)).toEqual([401]);
  expect((await owner.query(`SELECT count FROM "${schema}"."rateLimit"`)).rows).toEqual([{count:1}]);
 }finally{
  for(const child of workers)if(child.exitCode===null)child.kill();
  await Promise.all(workers.map(child=>child.exitCode!==null?Promise.resolve():new Promise<void>(resolve=>child.once('exit',()=>resolve()))));
  await owner.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);if(created)await owner.query(`DROP ROLE "${role}"`);await owner.end();
 }
},30000);
