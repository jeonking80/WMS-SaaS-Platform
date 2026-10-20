// Real process termination and retry protocol exercise against a registered test WMS.
// The proxy deliberately injects failures; WMS business handling remains the real API.
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {openStore} from './store.mjs';
import {createRunner} from './runner.mjs';
const self=fileURLToPath(import.meta.url),sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const key=name=>{if(typeof name!=='string'||!process.env[name])throw Error('Missing scoped key binding');return process.env[name];};
function client(store,t){return createRunner(store,{url:t.url,companyId:t.company_id,sourceKey:key(t.source_key_env),processKey:key(t.process_key_env),workerKeys:t.worker_key_envs.map(key),approverKey:t.approver_key_env?key(t.approver_key_env):undefined,prepareKey:key(t.prepare_key_env)});}
if(process.argv[2]==='--child'){
 const config=JSON.parse(await readFile(process.argv[3],'utf8')),store=openStore(process.argv[4]),runner=client(store,config.target);let id=process.argv[5];
 try{
  if(!id){const c=config.target;const run=await runner.create({scenario:'partial',mode:'auto',seed:20261020,delay_ms:100,warehouse_id:c.warehouse_id,...c.catalog[0],supplier_id:c.supplier_id,customer_id:c.customer_id,destination_id:c.destination_id,expected_at:c.expected_at,due_at:c.due_at});id=run.id;process.send?.({type:'created',run_id:id});}
  await runner.resume(id);const deadline=Date.now()+120000;
  while(Date.now()<deadline&&store.run(id).status==='running'){
   await runner.tick(id);const event=store.operations(id).find(x=>x.kind==='event');if(event?.status==='unconfirmed'&&event.attempts){process.send?.({type:'durable_checkpoint',run_id:id,attempts:event.attempts,next_at:event.next_at,event_id:event.input.event_id,body_sha256:createHash('sha256').update(JSON.stringify(event.input)).digest('hex')});}
   await sleep(50);
  }
  const run=store.run(id);process.send?.({type:'finished',run_id:id,status:run.status,verdict:run.report?.verdict});if(run.status!=='finished'||run.report?.verdict!=='passed')process.exitCode=1;
 }finally{store.close();}
}else{
 const configPath=process.argv[2];if(!configPath)throw Error('Usage: node t09-resilience.mjs targets.json');const settings=JSON.parse(await readFile(configPath,'utf8')),t=settings.targets[0];
 const output=resolve(settings.resilience_output??(settings.output?settings.output+'/t09':'data/t09')),port=Number(process.env.SIM_T09_PROXY_PORT??3022);await mkdir(output,{recursive:true});const storePath=output+'/simulator.sqlite',childConfig=output+'/target.json',reportPath=output+'/report.json';
 const prepareStore=openStore(':memory:'),prepare=client(prepareStore,t);await prepare.connection();const item=(await prepare.api('prepare','/api/v2/masters/items?warehouse_id='+t.warehouse_id,{code:'T09-'+Date.now(),name:'Dedicated process resilience SKU'})).row;prepareStore.close();
 const target={...t,url:'http://127.0.0.1:'+port,catalog:[{...t.catalog[0],item_id:item.id}]};await writeFile(childConfig,JSON.stringify({target},null,2));
 const requests=[],kills=[],checkpoints=[],processExits=[];let committedReceipt,runId,finished,child;
 const proxy=createServer(async(req,res)=>{try{
  let body='';for await(const data of req)body+=data;
  if(req.method==='POST'&&req.url==='/api/v2/integration/events'){
   const input=JSON.parse(body),n=requests.length+1;requests.push({attempt:n,at:Date.now(),event_id:input.event_id,body_sha256:createHash('sha256').update(body).digest('hex')});
   if(n<=2){res.writeHead(n===1?429:503,{'content-type':'application/json','retry-after':String(n===1?2:3)});res.end(JSON.stringify({error:n===1?'INTEGRATION_BACKPRESSURE':'RETRYABLE_TRANSACTION'}));return;}
  }
  const headers={'content-type':'application/json'};if(req.headers.authorization)headers.authorization=req.headers.authorization;
  const upstream=await fetch(new URL(req.url,t.url),{method:req.method,headers,...(body?{body}:{}),signal:AbortSignal.timeout(15000),redirect:'error'}),text=await upstream.text();
  if(req.method==='POST'&&req.url==='/api/v2/integration/events'&&requests.length===3){if(upstream.status!==202)throw Error('Expected durable upstream acceptance');committedReceipt=JSON.parse(text).event.id;res.destroy();return;}
  const outHeaders={'content-type':upstream.headers.get('content-type')??'application/json'};if(upstream.headers.has('retry-after'))outHeaders['retry-after']=upstream.headers.get('retry-after');res.writeHead(upstream.status,outHeaders);res.end(text);
 }catch{if(!res.destroyed){res.writeHead(503,{'content-type':'application/json'});res.end('{"error":"SERVICE_UNAVAILABLE"}');}}});
 await new Promise(resolve=>proxy.listen(port,'127.0.0.1',resolve));
 const env={PATH:process.env.PATH,NODE_ENV:'test'};for(const name of [t.source_key_env,t.process_key_env,...t.worker_key_envs,t.approver_key_env,t.prepare_key_env].filter(Boolean))env[name]=key(name);
 const runChild=()=>new Promise((resolve,reject)=>{
  child=spawn(process.execPath,[self,'--child',childConfig,storePath,...(runId?[runId]:[])],{env,stdio:['ignore','ignore','pipe','ipc']});let killPhase;
  child.stderr.on('data',()=>{});child.on('error',reject);child.on('message',message=>{
   if(message.type==='created')runId=message.run_id;
   if(message.type==='durable_checkpoint'){
    checkpoints.push({...message,at:Date.now()});const phase=message.attempts===1&&requests.length===1?'after_429':message.attempts===3&&committedReceipt?'after_commit_response_loss':null;
    if(phase&&!kills.some(x=>x.phase===phase)){killPhase=phase;kills.push({phase,pid:child.pid,at:Date.now(),next_at:message.next_at,event_id:message.event_id,body_sha256:message.body_sha256});child.kill('SIGKILL');}
   }
   if(message.type==='finished')finished=message;
  });child.on('exit',(code,signal)=>{const exit={pid:child.pid,code,signal,kill_phase:killPhase??null};processExits.push(exit);resolve(exit);});
 });
 try{
  for(let n=0;n<3&&!finished;n++){const exit=await runChild();if(exit.signal!=='SIGKILL'&&exit.code!==0)throw Error('Simulator child failed outside the expected termination point');}
  const store=openStore(storePath),run=store.run(runId),op=store.operations(runId).find(x=>x.kind==='event');
  const checks={two_real_sigkill_restarts:kills.length===2&&processExits.filter(x=>x.signal==='SIGKILL').length===2,same_event_id:new Set(requests.map(x=>x.event_id)).size===1,same_exact_body:new Set(requests.map(x=>x.body_sha256)).size===1,only_three_posts:requests.length===3,first_retry_after_observed:requests.length>=2&&requests[1].at-requests[0].at>=2000,second_retry_after_observed:requests.length>=3&&requests[2].at-requests[1].at>=3000,original_receipt_polled:op?.result?.id===committedReceipt,run_finished:run.status==='finished',independent_reconciliation_passed:run.report?.verdict==='passed'&&run.report?.differences.length===0,unconfirmed_zero:store.operations(runId).every(x=>['done','expected_rejected'].includes(x.status))};
  const report={scenario:'T09',run_id:runId,scenario_version:'1.1',generator_version:'2.0.0',generated_at:new Date().toISOString(),verdict:Object.values(checks).every(Boolean)?'passed':'failed',checks,kills,process_exits:processExits,requests,checkpoints,committed_receipt_id:committedReceipt,final_counts:run.report?.counts,reconciliation:run.report?{boundary:run.report.boundary,expected:run.report.expected,actual:run.report.actual,differences:run.report.differences}:null,limitations:['429/503 and response loss are deliberately injected by an HTTP transport proxy.','The simulator process is actually terminated with SIGKILL twice and reopened from SQLite.','WMS durable acceptance, workflow and final ledger are real HTTP API effects.']};
  await writeFile(reportPath,JSON.stringify(report,null,2));store.close();console.log(JSON.stringify({scenario:'T09',run_id:runId,verdict:report.verdict,report:reportPath,checks}));if(report.verdict!=='passed')process.exitCode=1;
 }finally{if(child?.exitCode===null)child.kill('SIGKILL');await new Promise(resolve=>proxy.close(resolve));}
}
