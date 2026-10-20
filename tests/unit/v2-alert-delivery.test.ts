import {describe,it,expect} from 'vitest';
import {createServer,type Server,type RequestListener} from 'node:http';
import {mkdtemp,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {MonitorReport} from '../../scripts/v2-monitor-lib.mjs';
import {webhookConfiguration,openAlertOutbox,enqueueAlertReport,deliverAlerts,safeAlertEnvelope,cachedFailureReport} from '../../scripts/v2-alert-delivery.mjs';
const tenant='aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',warehouse='bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb',request='cccccccc-cccc-4ccc-cccc-cccccccccccc';
function report():MonitorReport{return {status:'warning',checked_at:'2026-10-20T00:00:00Z',tenant_id:tenant,warehouse_ids:[warehouse],checks:[],notifications:{status:'configured',recipient_configured:true,delivery:'webhook',sent:false},alerts:[{code:'LONG_RESERVATIONS',severity:'warning',status:'warning',observed_at:'2026-10-20T00:00:00Z',tenant:{id:tenant,name:'Synthetic company'},warehouses:[{id:warehouse,code:'TEST',name:'Synthetic warehouse'}],references:[{kind:'order',business_id:request,business_number:request,request_id:request}],action:{path:`/dashboard/v2?warehouse_id=${warehouse}&tab=orders&object_id=${request}`,authorization:'server rechecks'}}]};}
const configuration=()=>webhookConfiguration({WMS_ALERT_WEBHOOK_URL:'https://receiver.invalid/wms-alerts'})!;
async function fixture(){const dir=await mkdtemp(join(tmpdir(),'wms-alert-test-'));const file=join(dir,'outbox.sqlite');return {dir,file,db:await openAlertOutbox(file)};}
async function receiver(callback:RequestListener){const server=createServer(callback);await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();if(!address||typeof address==='string')throw new Error('local receiver unavailable');return {server,url:`http://127.0.0.1:${address.port}`};}
const close=(server:Server)=>new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
describe('operator alert outbox',()=>{
 it('requires private storage and HTTPS configuration without credentials/query secrets',async()=>{for(const url of ['http://receiver.invalid/','https://user:password@receiver.invalid/','https://receiver.invalid/?token=secret','https://receiver.invalid/#secret'])expect(()=>webhookConfiguration({WMS_ALERT_WEBHOOK_URL:url})).toThrow();const f=await fixture();try{expect((await stat(f.file)).mode&0o777).toBe(0o600);f.db.close();}finally{await rm(f.dir,{recursive:true,force:true});}});
 it('persists retry across restart, sends same receiver dedup key, and suppresses an unchanged active incident',async()=>{
  const f=await fixture(),seen:{key:string|undefined;body:string}[]=[];let attempts=0;
  const local=await receiver((req,res)=>{let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{seen.push({key:req.headers['idempotency-key'] as string|undefined,body});res.writeHead(++attempts===1?503:202);res.end();});});
  const config=configuration(),localFetch:typeof fetch=(_url,init)=>fetch(local.url,init);
  try{
   expect(enqueueAlertReport(f.db,report(),config,{now:1000}).enqueued).toBe(1);
   expect(await deliverAlerts(f.db,config,{now:1000,fetchImpl:localFetch})).toMatchObject({sent:0,retained_for_retry:1,retried:1});
   f.db.close();f.db=await openAlertOutbox(f.file);
   expect(await deliverAlerts(f.db,config,{now:30999,fetchImpl:localFetch})).toMatchObject({sent:0,retained_for_retry:1});
   expect(await deliverAlerts(f.db,config,{now:31000,fetchImpl:localFetch})).toMatchObject({sent:1,retained_for_retry:0});
   expect(seen).toHaveLength(2);expect(seen[0].key).toBe(seen[1].key);expect(JSON.parse(seen[1].body)).toMatchObject({dedup_key:seen[0].key,tenant:{id:tenant},references:[{request_id:request}]});
   const repeated=report();repeated.alerts[0].observed_at='2026-10-20T01:00:00Z';expect(enqueueAlertReport(f.db,repeated,config).enqueued).toBe(0);
   expect(await deliverAlerts(f.db,config,{now:100000,fetchImpl:localFetch})).toMatchObject({sent:0});
   enqueueAlertReport(f.db,{...report(),alerts:[]},config);expect(enqueueAlertReport(f.db,report(),config).enqueued).toBe(1);
  }finally{f.db.close();await close(local.server);await rm(f.dir,{recursive:true,force:true});}
 });
 it('never follows redirects and retains a failed delivery for operator recovery',async()=>{
  const f=await fixture();let redirected=0;const local=await receiver((req,res)=>{if(req.url==='/redirected')redirected++;res.writeHead(302,{location:'/redirected'});res.end();});
  try{const config=configuration();enqueueAlertReport(f.db,report(),config,{now:1});await deliverAlerts(f.db,config,{now:1,fetchImpl:(_url,init)=>fetch(local.url,init)});expect(redirected).toBe(0);expect(f.db.prepare('SELECT status,last_error FROM deliveries').get()).toMatchObject({status:'pending',last_error:'NETWORK_OR_TIMEOUT'});
   for(let i=1;i<8;i++)await deliverAlerts(f.db,config,{now:1+i*4000000,fetchImpl:async()=>new Response('',{status:503})});
   expect(f.db.prepare('SELECT status,attempts FROM deliveries').get()).toMatchObject({status:'failed',attempts:8});
   expect(await deliverAlerts(f.db,config,{now:40000000,fetchImpl:async()=>new Response('',{status:202}),requeueFailed:true})).toMatchObject({sent:1,failed:0});
  }finally{f.db.close();await close(local.server);await rm(f.dir,{recursive:true,force:true});}
 });
 it('allowlists the envelope and refuses injected links without persisting raw data',()=>{const alert=Object.assign(report().alerts[0],{payload:{password:'never persist'},token:'never persist',details:{raw:'never persist'}});expect(JSON.stringify(safeAlertEnvelope(alert))).not.toContain('never persist');alert.action.path='https://evil.invalid/dashboard/v2?warehouse_id='+warehouse;expect(()=>safeAlertEnvelope(alert)).toThrow();});
 it('recovers an in-flight lease after restart and alerts DB outage only for an exact previously observed scope',async()=>{
  const f=await fixture(),config=configuration();try{
   expect(cachedFailureReport(f.db,config,tenant,[warehouse])).toBeNull();enqueueAlertReport(f.db,report(),config,{now:1});
   f.db.prepare("UPDATE deliveries SET status='sending',lease_until=1000").run();f.db.close();f.db=await openAlertOutbox(f.file);
   expect(await deliverAlerts(f.db,config,{now:999,fetchImpl:async()=>new Response('',{status:202})})).toMatchObject({sent:0,retained_for_retry:1});
   expect(await deliverAlerts(f.db,config,{now:1000,fetchImpl:async()=>new Response('',{status:202})})).toMatchObject({sent:1});
   expect(cachedFailureReport(f.db,config,tenant,[request])).toBeNull();const failure=cachedFailureReport(f.db,config,tenant,[warehouse])!;expect(failure.alerts[0]).toMatchObject({code:'MONITOR_DATABASE_UNAVAILABLE',references:[],tenant:{id:tenant},warehouses:[{id:warehouse}]});
   enqueueAlertReport(f.db,failure,config,{resolveMissing:false});expect(enqueueAlertReport(f.db,report(),config).enqueued).toBe(0);
  }finally{f.db.close();await rm(f.dir,{recursive:true,force:true});}
 });
});
