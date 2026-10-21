// Two-company long-running operational profiles. Secrets are selected by environment
// variable name from a non-secret target file. No database driver is imported.
import {readFile,writeFile,mkdir,rename} from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {openStore} from './store.mjs';
import {stableId,profilePlan} from './profile-plan.mjs';
import {firstBy,workIndex,seedsComplete,physicalComplete,EXPECTED_REVISION_REASONS,expectedRevisionOutcomes,qualityEvents,rejectedRevisionDetails} from './profile-index.mjs';
import {freezePeakBacklog,evaluateProfileQuality} from './profile-quality.mjs';
import {PROFILE_SCHEDULER_VERSION,PROFILE_SOURCE_LANE_LIMIT,assertSchedulerResume,createSourceScheduler} from './profile-scheduler.mjs';
import {PROFILE_RECOVERY_VERSION,controlAttempt,boundedRead,recoveryDeadline,errorEvidence,unverifiedCompanyReport,retryAfterSeconds,settleProfileTasks} from './profile-recovery.mjs';
import {retryAt,HttpFailure} from './runner.mjs';
import {shiftPolicy,shiftWorkerIndex,shiftWorkAllowed,performShiftMilestones,baselineDeltas,reconcileShiftBoundary} from './shift-profile.mjs';
const configPath=process.argv[2];if(!configPath)throw Error('Usage: node profile.mjs targets.json [congestion|shift|smoke] [resume-run-id]');
const config=JSON.parse(await readFile(configPath,'utf8')),kind=process.argv[3]??'smoke',resumeId=process.argv[4],rootId=resumeId??randomUUID();
if(!Array.isArray(config.targets)||config.targets.length!==2)throw Error('A profile requires exactly two registered test companies.');
const output=resolve(config.output??'data/profile');await mkdir(output,{recursive:true});const store=openStore(output+'/profile.sqlite');
const reportFile=output+'/'+rootId+'.json';let stopping=false;for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{stopping=true;});
const qualityReportingVersion='scheduled-windows-peak-cohort-v1';
const allowedFinal=new Set(['done','expected_business_rejected','superseded']);const runtime=[];
async function delay(ms){await new Promise(resolve=>setTimeout(resolve,ms));}
function keyFrom(name){if(typeof name!=='string'||!process.env[name])throw Error('Missing machine key environment binding');return process.env[name];}
for(const [index,t]of config.targets.entries()){
 if(!t.catalog?.length||!kind.endsWith('smoke')&&(t.catalog.length!==100||t.worker_key_envs?.length!==10||new Set(t.catalog.flatMap(x=>[x.receiving_id,x.storage_id,x.staging_id,x.hold_id,...(x.shipping_id?[x.shipping_id]:[])])).size!==20))throw Error('Full profiles require 100 dedicated SKUs, 20 locations, and 10 distinct worker keys per company.');
 const keys={source:keyFrom(t.source_key_env),process:keyFrom(t.process_key_env),...(['shift','shift-smoke'].includes(kind)?{supervisor:keyFrom(t.supervisor_key_env??t.approver_key_env)}:{})},workers=t.worker_key_envs.map(keyFrom);if(new Set([...Object.values(keys),...workers]).size!==Object.keys(keys).length+workers.length)throw Error('Source, processor and all workers must have distinct keys.');
 const origin=new URL(t.url);if(origin.username||origin.password||!['http:','https:'].includes(origin.protocol))throw Error('Invalid target URL');
 const id=rootId+':'+index;const r={id,target:t,keys,workers,origin,active:new Set(),inFlight:new Set(),calls:0,errors:0,lastSnapshot:null,phase:'seed',shiftPolicy:shiftPolicy(kind,t),workerActorIds:workers.map(token=>'machine:'+token.split('.')[1])};r.recoverCommand=op=>command(r,op);
 r.api=async(role,path,payload,meta)=>{
  const token=typeof role==='number'?workers[role]:keys[role],started=Date.now();let response;
  const observe=details=>{const exists=store.hasRun(id),completed=Date.now(),record={role,path:path.split('?')[0],method:payload?'POST':'GET',...details,started_at_ms:started,completed_at_ms:completed,latency_ms:completed-started,...(meta?{operation_id:meta.operation_id,event_id:meta.event_id,scheduled_offset_ms:meta.scheduled_offset_ms,phase:meta.phase}:{})};if(meta)meta.timing=record;if(exists)store.observe(id,'api_call',record);};
  try{response=await fetch(new URL(path,origin),{method:payload?'POST':'GET',headers:{authorization:'Bearer '+token,'content-type':'application/json'},...(payload?{body:JSON.stringify(payload)}:{}),signal:AbortSignal.timeout(Math.max(1,Math.min(15000,meta?.timeout_ms??15000))),redirect:'error'});}catch{observe({status:0,response_body_complete:false});throw new HttpFailure(503,'NETWORK_UNAVAILABLE');}
  let value;try{value=await response.json();}catch{observe({status:503,http_status:response.status,response_body_complete:false});throw new HttpFailure(503,'INVALID_SERVER_RESPONSE');}
  observe({status:response.status,response_body_complete:true});r.calls++;if(!response.ok)throw new HttpFailure(response.status,/^[A-Z0-9_]{1,100}$/.test(value.error??'')?value.error:'HTTP_'+response.status,retryAfterSeconds(response.headers.get('retry-after')));return value;
 };
 r.connection=async()=>{const info=await r.api('source','/api/v2/integration/connection');if(info.environment!=='test'||info.test_company!==true||info.company_id!==t.company_id||!info.warehouse_ids.includes(t.warehouse_id)||info.kind!=='integration')throw Error('Registered test target required');return {url:origin.origin,company_id:info.company_id,environment:info.environment,source_system:info.source_system,warehouse_id:t.warehouse_id,contract_version:info.contract_version};};
 if(resumeId){const prior=store.run(id);if(prior)assertSchedulerResume(prior.config);}
 const metadata=await r.connection(),fingerprint=createHash('sha256').update(JSON.stringify(metadata)).digest('hex');
 if(resumeId){const saved=store.run(id);if(!saved||saved.target.fingerprint!==fingerprint)throw Error('Target changed; profile resume blocked');if(saved.config.kind!==kind||saved.config.seed!==(config.seed??20261020)||JSON.stringify(saved.config.catalog)!==JSON.stringify(t.catalog)||JSON.stringify(saved.config.baseline??null)!==JSON.stringify(t.baseline??null)||saved.config.worker_actor_ids&&JSON.stringify(saved.config.worker_actor_ids)!==JSON.stringify(r.workerActorIds))throw Error('Profile configuration or worker ownership changed; resume blocked');}
 else{
  const snap=(await r.api(0,'/api/v2/workflow?warehouse_id='+t.warehouse_id)).snapshot;
  const items=new Set(t.catalog.map(x=>x.item_id));if(t.baseline){const checked=await reconcileShiftBoundary(t,[],(_role,path)=>r.api(0,path),snap.version);if(!checked.passed)throw Error('Independent initial baseline does not match the live stock and full ledger');}if((!t.baseline&&snap.stock.some(x=>items.has(x.item_id)&&['S','R','P','Q','B'].some(b=>x[b]!==0)))||[...snap.receipts,...snap.orders].some(x=>x.lines.some(l=>items.has(l.item_id))))throw Error('A new profile requires dedicated unused catalog items.');
  const plan=profilePlan(rootId+':'+index,kind,t.catalog,metadata.source_system,t.warehouse_id,Number(config.seed??20261020)+index,t);
  store.create({id,config:{kind,seed:config.seed??20261020,duration_ms:plan.duration_ms,unique_measured:plan.unique_measured,profile_version:'1.1',generator_version:'2.0.0',scheduler_version:PROFILE_SCHEDULER_VERSION,recovery_version:PROFILE_RECOVERY_VERSION,quality_reporting_version:qualityReportingVersion,expected_outcomes:expectedRevisionOutcomes(plan.events),catalog:t.catalog,baseline:t.baseline??null,worker_actor_ids:r.workerActorIds},target:{...metadata,fingerprint}},plan.events.map(op=>({...op,input:{event:op.input,offset_ms:op.offset_ms,phase:op.phase}})));
  store.updateRun(id,{context:{ordinal:plan.events.length,seed_start:Date.now()}});
 }
 // Config/target and seed bodies cannot be changed by updateRun or this profile.
 // Rebuild these references only after the existing resume/fingerprint checks.
 const journal=store.run(id),journalOps=store.operations(id);r.sourceSystem=journal.target.source_system;r.durationMs=journal.config.duration_ms;
 if(journal.config.recovery_version!==PROFILE_RECOVERY_VERSION)throw Error('Profile recovery contract changed; resume blocked');
 if(journal.config.quality_reporting_version!==qualityReportingVersion||JSON.stringify(journal.config.expected_outcomes)!==JSON.stringify(expectedRevisionOutcomes(journalOps)))throw Error('Profile quality contract or expected outcomes changed; resume blocked');
 r.expectedOutcomes=journal.config.expected_outcomes;r.catalogById=firstBy(r.target.catalog,row=>row.item_id);
 r.seedDefinitions=journalOps.filter(op=>op.kind==='event'&&op.input.phase==='seed');
 store.updateRun(id,{status:'running'});runtime.push(r);
}
if(new Set(runtime.map(r=>r.target.company_id)).size!==2)throw Error('Two different companies are required.');
function appendCommand(r,entity,stage,payload,deltas){
 const id=stableId(r.id+':'+entity+':'+stage);const existing=store.operation(id);if(existing)return existing;
 const ordinal=Number(store.db.prepare('SELECT coalesce(max(ordinal),-1)+1 AS n FROM operations WHERE run_id=?').get(r.id).n);
 const owner=payload.order_id??payload.receipt_id??r.lastSnapshot?.packages.find(pack=>payload.package_ids?.includes(pack.id))?.order_id??entity;const actor=r.shiftPolicy?shiftWorkerIndex(r,owner):ordinal%r.workers.length;
 const input={warehouse_id:r.target.warehouse_id,command:stage,request_id:id,payload:{...payload,execution_mode:'automated'},oracle_deltas:deltas};
 store.db.prepare('INSERT INTO operations(id,run_id,ordinal,kind,label,role,input) VALUES(?,?,?,?,?,?,?)').run(id,r.id,ordinal,'command',stage,String(actor),JSON.stringify(input));return store.operation(id);
}
async function command(r,op){
 if(!r.controlReadHealthy||stopping||op.status==='done'||op.status==='quarantined'||op.next_at>Date.now())return;
 const trace={operation_id:op.id};let worker=Number(op.role);try{
  if(op.status!=='unsent')try{const saved=await r.api(worker,'/api/v2/workflow?warehouse_id='+r.target.warehouse_id+'&request_id='+op.input.request_id,undefined,trace);store.updateOp(op.id,{status:'done',result:{result:saved.result},error:null});return;}catch(e){if(e.status!==404)throw e;}
  if(!r.controlReadHealthy||stopping)return;
  if(r.shiftPolicy){const p=op.input.payload,entity=p.order_id??p.receipt_id??r.lastSnapshot?.packages.find(pack=>p.package_ids?.includes(pack.id))?.order_id;if(entity){const next=shiftWorkerIndex(r,entity);if(next!==worker){store.db.prepare('UPDATE operations SET role=? WHERE id=?').run(String(next),op.id);store.observe(r.id,'command_actor_handover',{request_id:op.input.request_id,previous_worker:worker,next_worker:next,body_unchanged:true});worker=next;}}}
  store.updateOp(op.id,{status:'unconfirmed'});const {oracle_deltas,...input}=op.input;void oracle_deltas;
  const applied=await r.api(worker,'/api/v2/workflow',input,trace);store.updateOp(op.id,{status:'done',result:{result:applied.result},error:null});
 }catch(error){if(error.message==='INSUFFICIENT_STOCK'){store.updateOp(op.id,{status:'waiting_stock',next_at:Date.now()+1000,error:'EXPECTED_STOCK_WAIT'});return;}const attempts=op.attempts+1;store.updateOp(op.id,{status:attempts>5||error.status<500&&error.status!==429?'quarantined':'unconfirmed',attempts,next_at:retryAt(attempts,error.retryAfter),error:error.message});}
}
function itemDefinition(r,item){const entry=r.catalogById.get(item);if(!entry)throw Error('Item outside profile catalog');return entry;}
const delta=(item,loc,b,q)=>({item_id:item,location_id:loc,bucket:b,delta:q});
async function work(r,snapshot){
 const ops=store.operations(r.id),{byId:opById,definitions,reservationsByOrder}=workIndex(ops);
 const tasks=[];
 for(const receipt of snapshot.receipts){const external=receipt.external_id?.slice(String(r.sourceSystem).length+1),e=definitions.get(external);if(!e||e.event_type!=='receipt.create'||r.active.has(receipt.id))continue;const stageIds=new Map(['receipt.receive','receipt.inspect','receipt.putaway'].map(stage=>[stage,stableId(r.id+':'+receipt.id+':'+stage)]));if([...stageIds.values()].every(id=>opById.get(id)?.status==='done'))continue;const expected=e.payload.lines;const rows=expected.map((x,i)=>({...x,line_id:receipt.lines.find(l=>l.id===x.id)?.id??receipt.lines[i].id,...itemDefinition(r,x.item_id)}));
  const stages=[['receipt.receive',{receipt_id:receipt.id,receiving_id:stableId(r.id+':physical:'+receipt.id),lines:rows.map(x=>({line_id:x.line_id,quantity:x.quantity,location_id:x.receiving_id}))},rows.map(x=>delta(x.item_id,x.receiving_id,'Q',x.quantity))],['receipt.inspect',{receipt_id:receipt.id,lines:rows.map(x=>({lot_id:receipt.lots.find(l=>l.line_id===x.line_id)?.id,quantity:x.quantity,outcome:'normal'}))},[]],['receipt.putaway',{receipt_id:receipt.id,lines:rows.map(x=>({lot_id:receipt.lots.find(l=>l.line_id===x.line_id)?.id,quantity:x.quantity,location_id:x.storage_id}))},rows.flatMap(x=>[delta(x.item_id,x.receiving_id,'Q',-x.quantity),delta(x.item_id,x.storage_id,'S',x.quantity)])]];
  for(const [stage,payload,deltas]of stages){const id=stageIds.get(stage),saved=opById.get(id);if(saved?.status==='done')continue;if(stage!=='receipt.receive'&&payload.lines.some(x=>!x.lot_id))break;if(saved&&saved.next_at>Date.now())break;tasks.push({entity:receipt.id,op:saved??appendCommand(r,receipt.id,stage,payload,deltas)});break;}
 }
 for(const order of snapshot.orders){const external=order.external_id?.slice(String(r.sourceSystem).length+1),e=definitions.get(external);if(!e||e.event_type!=='order.create'||r.active.has(order.id))continue;const entity=e.revision===1?order.id:order.id+':revision:'+e.revision;
  const reservationId=stableId(r.id+':'+entity+':order.reserve');
  for(const old of (reservationsByOrder.get(order.id)??[]).filter(x=>x.id!==reservationId)){store.updateOp(old.id,{status:'superseded',error:null});store.observe(r.id,'intent_superseded',{request_id:old.input.request_id,new_revision:e.revision,reason:'Accepted external revision changed the unreserved intent; original request and body retained.'});}
  const stageIds=new Map(['order.reserve','order.pick','package.create','shipment.create'].map(stage=>[stage,stage==='order.reserve'?reservationId:stableId(r.id+':'+entity+':'+stage)]));
  if([...stageIds.values()].every(id=>opById.get(id)?.status==='done'))continue;
  const rows=e.payload.lines.map((x,i)=>({...x,line_id:order.lines.find(l=>l.id===x.id)?.id??order.lines[i].id,...itemDefinition(r,x.item_id)}));
  const packageOp=opById.get(stageIds.get('package.create'));
  const stages=[['order.reserve',{order_id:order.id,partial:false,lines:rows.map(x=>({line_id:x.line_id,quantity:x.quantity,location_id:x.storage_id}))},rows.map(x=>delta(x.item_id,x.storage_id,'R',x.quantity))],['order.pick',{order_id:order.id,lines:rows.map(x=>({reservation_id:order.reservations.find(z=>z.line_id===x.line_id)?.id,quantity:x.quantity,location_id:x.staging_id,scanned_item_id:x.item_id,scanned_location_id:x.storage_id}))},rows.flatMap(x=>[delta(x.item_id,x.storage_id,'R',-x.quantity),delta(x.item_id,x.storage_id,'S',-x.quantity),delta(x.item_id,x.staging_id,'P',x.quantity)])],['package.create',{order_id:order.id,lines:rows.map(x=>({pick_id:order.picks.find(z=>z.line_id===x.line_id)?.id,quantity:x.quantity}))},[]],['shipment.create',{package_ids:[packageOp?.result?.result?.id],handover_by:'Simulated warehouse worker',carrier:'SIM-PROFILE'},rows.map(x=>delta(x.item_id,x.staging_id,'P',-x.quantity))]];
  for(const [stage,payload,deltas]of stages){const id=stageIds.get(stage),saved=opById.get(id);if(saved?.status==='done')continue;if(stage==='order.pick'&&payload.lines.some(x=>!x.reservation_id)||stage==='package.create'&&payload.lines.some(x=>!x.pick_id)||stage==='shipment.create'&&!payload.package_ids[0])break;if(saved&&saved.next_at>Date.now())break;tasks.push({entity:order.id,op:saved??appendCommand(r,entity,stage,payload,deltas)});break;}
 }
 const shift=r.shiftPolicy?(store.context(r.id)?.shift??{}):undefined;
 for(const task of tasks.filter(task=>shiftWorkAllowed(r,task.op,store,shift)).slice(0,Math.max(0,r.workers.length-r.active.size))){r.active.add(task.entity);const promise=command(r,task.op).finally(()=>{r.active.delete(task.entity);r.inFlight.delete(promise);});r.inFlight.add(promise);}
}
function eventEvidence(op,item,timing){
 const options={...op.options,last_server_status:item.status,last_server_reason:item.reason??null};
 const received=Date.parse(item.received_at),processed=Date.parse(item.processed_at);
 if(Number.isFinite(received))options.accepted_at_ms=received;
 if(Number.isFinite(processed))options.processed_at_ms=processed;
 if(['applied','business_rejected','quarantined'].includes(item.status)&&options.completion_observed_at_ms===undefined)options.completion_observed_at_ms=timing.completed_at_ms;
 if(timing.status===202&&options.acceptance_latency_ms===undefined){options.acceptance_latency_ms=timing.latency_ms;options.accepted_response_complete_at_ms=timing.completed_at_ms;}
 return options;
}
async function dispatch(r,op){
 if(op.next_at>Date.now())return;const e=op.input.event,trace={operation_id:op.id,event_id:e.event_id,scheduled_offset_ms:op.input.offset_ms,phase:op.input.phase};try{
  if(op.status!=='unsent'){
   const polled=await r.api('source','/api/v2/integration/events?warehouse_id='+r.target.warehouse_id+'&event_id='+e.event_id,undefined,trace),item=polled.events[0];
   if(item){
    const options=eventEvidence(op,item,trace.timing);
    if(item.status==='applied'){store.updateOp(op.id,{status:'done',result:{id:item.id,result:item.result,received_at:item.received_at,processed_at:item.processed_at},options,error:null});return;}
    if(item.status==='business_rejected'){const expected=e.event_type==='order.update'&&EXPECTED_REVISION_REASONS.includes(item.reason);store.updateOp(op.id,{status:expected?'expected_business_rejected':'quarantined',result:item,options,error:item.reason});return;}
    store.updateOp(op.id,{status:item.status==='quarantined'?'quarantined':'unconfirmed',next_at:Date.now()+250,options,error:item.reason});return;
   }
  }
  op.options={...op.options,first_sent_at_ms:op.options.first_sent_at_ms??Date.now()};
  store.updateOp(op.id,{status:'unconfirmed',options:op.options});
  const accepted=await r.api('source','/api/v2/integration/events',e,trace);
  store.updateOp(op.id,{result:{id:accepted.event.id},options:eventEvidence(op,accepted.event,trace.timing),next_at:Date.now()+250});
  store.observe(r.id,'delivery',{event_id:e.event_id,phase:op.input.phase,scheduled_offset_ms:op.input.offset_ms,delivered_at:Date.now()});
 }catch(error){const attempts=op.attempts+1;store.updateOp(op.id,{attempts,status:attempts>5||error.status<500&&error.status!==429?'quarantined':'unconfirmed',next_at:retryAt(attempts,error.retryAfter),error:error.message});}
}

// External transmission must not wait behind a large accumulated-stock snapshot.
// Each company has an independent durable outbound lane and a separate processor lane.
const outboundTimers=runtime.flatMap(r=>{
 const scheduler=createSourceScheduler({
  select:(lane,limit,excluded)=>store.readyEvents(r.id,Date.now(),store.context(r.id).measured_start,limit,lane,excluded),
  dispatch:op=>dispatch(r,op),onError:error=>store.observe(r.id,'external_pulse_error',{code:error.code??'SIMULATOR_FAILURE'}),
 });
 r.sourceScheduler=scheduler;Object.defineProperty(r,'deliveryActive',{get:()=>scheduler.activeCount>0});
 const sourcePulse=lane=>()=>{if(stopping)return;try{scheduler.pulse(lane);}catch(error){store.observe(r.id,'external_pulse_error',{code:error.code??'SIMULATOR_FAILURE'});}};
 const processPulse=()=>{if(stopping||r.processActive||!store.hasUnconfirmedEvents(r.id))return;r.processActive=true;r.processing=r.api('process','/api/v2/integration/process',{warehouse_id:r.target.warehouse_id,limit:50}).catch(()=>{}).finally(()=>{r.processActive=false;});};
 // Independent 10-slot lanes share an active-ID set: old polls cannot consume new
 // transmission slots, and no operation can be polled while its POST is in flight.
 return [setInterval(sourcePulse('new'),50),setInterval(sourcePulse('poll'),50),setInterval(processPulse,50)];
});
console.log(JSON.stringify({run_id:rootId,profile:kind,scheduler_version:PROFILE_SCHEDULER_VERSION,companies:2,resumed:!!resumeId,status:'running',note:'Reports describe observed execution; no field certification.'}));
function checkRecoveryDeadline(r,start){
 const deadline=recoveryDeadline(start,r.durationMs);if(deadline===null||Date.now()<deadline)return false;
 if(!r.deadlineReported){store.observe(r.id,'recovery_deadline_exceeded',{deadline_ms:deadline,observed_at_ms:Date.now()});r.deadlineReported=true;}
 r.controlReadHealthy=false;r.runtimeFailure={stage:'recovery_deadline',code:'RECOVERY_DEADLINE_EXCEEDED',deadline_ms:deadline};stopping=true;return true;
}
async function finalRead(r,stage,path){
 return boundedRead(({remaining_ms})=>r.api(0,path,undefined,{timeout_ms:remaining_ms}),{onRetry:retry=>{r.finalReadRetries=(r.finalReadRetries??0)+1;store.observe(r.id,'final_read_retry',{stage,...retry});}});
}
function failedCompany(r,error,stage){
 const report=unverifiedCompanyReport({run:store.run(r.id),operations:store.operations(r.id),calls:store.observations(r.id).filter(row=>row.kind==='api_call'),company_id:r.target.company_id,kind,stage,error,runtime_failure:r.runtimeFailure??null,expected_outcomes:r.expectedOutcomes,scheduler_version:PROFILE_SCHEDULER_VERSION,last_observed_boundary:r.lastObservedBoundary??null});
 report.shutdown_failures=r.shutdownFailures??[];store.updateRun(r.id,{status:'paused',report});return report;
}
let shutdownPromise;
async function settleRuntime(){
 if(shutdownPromise)return shutdownPromise;
 stopping=true;for(const timer of outboundTimers)clearInterval(timer);
 shutdownPromise=Promise.all(runtime.map(async r=>{
  r.shutdownFailures=await settleProfileTasks({source:r.sourceScheduler?.settle(),physical:[...r.inFlight],processing:r.processing});
  if(r.shutdownFailures.length){r.runtimeFailure??={stage:'shutdown',code:'SHUTDOWN_SETTLE_FAILED'};try{store.observe(r.id,'shutdown_settle_failure',{failures:r.shutdownFailures});}catch(error){r.shutdownFailures.push(errorEvidence(error));}}
 }));
 return shutdownPromise;
}

async function persistReport(report){
 try{const temporary=reportFile+'.tmp';await writeFile(temporary,JSON.stringify(report,null,2));await rename(temporary,reportFile);if(report.verdict==='failed')process.exitCode=1;return true;}
 catch(error){process.exitCode=1;console.error(JSON.stringify({run_id:rootId,status:'failed',code:'PROFILE_REPORT_WRITE_FAILED',filesystem_code:errorEvidence(error).code,report:reportFile}));return false;}
}
let lastPoll=0,finished=false;
try{
 while(!stopping){
  const now=Date.now();let allComplete=true;
  for(const r of runtime){
   const context=store.context(r.id);
   r.seedReady=seedsComplete(r.id,r.sourceSystem,r.lastSnapshot,r.seedDefinitions,r.seedDefinitions.length?store.operationStates(r.id):[]);
   const start=context.measured_start;
   if(checkRecoveryDeadline(r,start))break;
   if(now-lastPoll>=500){
    const previous=store.context(r.id).control_retry??{};
    const attempted=await controlAttempt({state:previous,operation:async()=>{
     const deadline=recoveryDeadline(start,r.durationMs);
     const api=async(role,path,payload,meta)=>{try{if(stopping||deadline!==null&&Date.now()>=deadline)throw Object.assign(new Error('PROFILE_CONTROL_DEADLINE'),{code:'PROFILE_CONTROL_DEADLINE'});return await r.api(role,path,payload,{...meta,timeout_ms:deadline===null?15000:deadline-Date.now()});}catch(error){r.controlReadHealthy=false;r.lastSnapshot=null;throw error;}};
     const snapshot=(await api(0,'/api/v2/workflow?warehouse_id='+r.target.warehouse_id)).snapshot;
     r.lastSnapshot=snapshot;r.lastObservedBoundary=snapshot.version;r.controlReadHealthy=true;
     if(checkRecoveryDeadline(r,start)||stopping)return;
     const control=await performShiftMilestones({...r,api},snapshot,store);r.lastSnapshot=control.snapshot;
     if(!checkRecoveryDeadline(r,start)&&!stopping&&!control.pauseWork)await work(r,r.lastSnapshot);
    }});
    if(attempted.status!=='waiting'&&(attempted.status!=='ready'||previous.attempts)){const fresh=store.context(r.id);store.updateRun(r.id,{context:{...fresh,control_retry:attempted.state}});}
    if(attempted.status==='retrying'||attempted.status==='failed'){r.controlReadHealthy=false;r.lastSnapshot=null;store.observe(r.id,'control_read_failure',{...attempted.state.last_failure,retry_status:attempted.status,attempts:attempted.state.attempts,next_at:attempted.state.next_at});if(attempted.status==='failed'){r.runtimeFailure={stage:'control',...attempted.state};stopping=true;}}
   }
   if(checkRecoveryDeadline(r,start)||stopping)break;
   // Fresh status after awaits: outbound and command lanes may have persisted results.
   const currentStates=store.operationStates(r.id),pending=currentStates.some(x=>!allowedFinal.has(x.status));
   if(pending||r.active.size||r.deliveryActive||r.processActive||!start||now<start+r.durationMs||!physicalComplete(r.id,store.operations(r.id)))allComplete=false;
   if(kind==='congestion'&&start&&Date.now()>=start+900000&&!store.context(r.id).peak_cohort){const observed=Date.now(),cohort=freezePeakBacklog({kind,start_ms:start,events:qualityEvents(store.operations(r.id)),observed_at_ms:observed,expected_outcomes:r.expectedOutcomes}),fresh=store.context(r.id);store.updateRun(r.id,{context:{...fresh,peak_cohort:cohort}});store.observe(r.id,'peak_backlog_frozen',{peak_end_ms:cohort.peak_end_ms,deadline_ms:cohort.deadline_ms,frozen_at_ms:observed,received_count:cohort.received_ids.length,source_count:cohort.source_ids.length,excluded_count:cohort.excluded.length});}
  }
  if(stopping)break;
  if(runtime.every(r=>r.seedReady)&&runtime.some(r=>!store.context(r.id).measured_start)){const existing=runtime.map(r=>store.context(r.id).measured_start).filter(Boolean),start=existing[0]??Date.now();for(const r of runtime){const current=store.context(r.id);if(!current.measured_start)store.updateRun(r.id,{context:{...current,measured_start:start}});}}
  if(now-lastPoll>=500)lastPoll=now;if(allComplete){finished=true;break;}await delay(50);
 }
 const workFinishedAt=Date.now();await settleRuntime();
 const companies=[];
 for(const r of runtime){try{const run=store.run(r.id);if(!Number.isFinite(run.context.measured_start)||run.context.measured_start<=0){companies.push(failedCompany(r,{code:'PROFILE_MEASUREMENT_NOT_STARTED'},'preparation'));continue;}const snapshot=(await finalRead(r,'snapshot','/api/v2/workflow?warehouse_id='+r.target.warehouse_id)).snapshot,ops=store.operations(r.id);let cursor;const ledger=[];do{const page=await finalRead(r,'ledger','/api/v2/workflow/ledger?warehouse_id='+r.target.warehouse_id+'&boundary='+snapshot.version+'&limit=500'+(cursor?'&cursor='+encodeURIComponent(cursor):''));if(page.boundary!==snapshot.version)throw Object.assign(new Error('FINAL_LEDGER_BOUNDARY_CHANGED'),{code:'FINAL_LEDGER_BOUNDARY_CHANGED'});if(page.has_more&&(!page.cursor||page.cursor===cursor))throw Object.assign(new Error('FINAL_LEDGER_CURSOR_STALLED'),{code:'FINAL_LEDGER_CURSOR_STALLED'});ledger.push(...page.rows);cursor=page.has_more?page.cursor:null;}while(cursor);
  const wanted=new Map(),actual=new Map(),book=new Map(),items=new Set(r.target.catalog.map(x=>x.item_id));const add=(map,k,q)=>map.set(k,(map.get(k)??0)+q);for(const d of baselineDeltas(r.target))add(wanted,[d.item_id,d.location_id,d.bucket].join(':'),d.delta);for(const op of ops.filter(x=>x.kind==='command'&&x.status==='done'))for(const d of op.input.oracle_deltas)add(wanted,[d.item_id,d.location_id,d.bucket].join(':'),d.delta);
  for(const row of snapshot.stock.filter(x=>items.has(x.item_id)))for(const b of ['S','R','P','Q','B'])add(actual,[row.item_id,row.location_id,b].join(':'),row[b]);for(const row of ledger.filter(x=>items.has(x.item_id)))add(book,[row.item_id,row.location_id,row.bucket].join(':'),row.delta);
  const differences=[];for(const k of new Set([...wanted.keys(),...actual.keys(),...book.keys()]))if((wanted.get(k)??0)!==(actual.get(k)??0)||(wanted.get(k)??0)!==(book.get(k)??0))differences.push({key:k,expected:wanted.get(k)??0,actual:actual.get(k)??0,ledger:book.get(k)??0});
  // Bind original source quantities independently of stock/ledger agreement.
  const originals=new Map();for(const op of ops.filter(x=>x.kind==='event'&&x.status==='done')){const event=op.input.event;if(['receipt.create','order.create'].includes(event.event_type))originals.set(event.external_entity_id,{event,object_id:op.result?.result?.id});else if(event.event_type==='order.update'&&originals.has(event.external_entity_id)){const prior=originals.get(event.external_entity_id);originals.set(event.external_entity_id,{...prior,event:{...prior.event,payload:event.payload,revision:event.revision}});}}
  for(const [external,planned]of originals){const receipt=planned.event.event_type==='receipt.create',object=(receipt?snapshot.receipts:snapshot.orders).find(row=>row.external_id===run.target.source_system+':'+external),lines=planned.event.payload.lines;if(!object||object.id!==planned.object_id){differences.push({kind:'original_binding',external_id:external});continue;}if(object.lines.length!==lines.length)differences.push({kind:'original_line_count',object_id:object.id,expected:lines.length,actual:object.lines.length});for(const line of lines){const actual=line.id?object.lines.find(row=>row.id===line.id):object.lines.find(row=>row.item_id===line.item_id),field=receipt?'received':'shipped';if(!actual||actual.item_id!==line.item_id||actual.quantity!==line.quantity||actual.cancelled!==0||actual[field]!==line.quantity)differences.push({kind:'original_quantity',object_id:object.id,item_id:line.item_id,expected:line.quantity,actual:actual?.quantity??null,completed:actual?.[field]??null});}}
  const incomplete=ops.filter(x=>!allowedFinal.has(x.status)).map(x=>({id:x.id,kind:x.kind,status:x.status,error:x.error}));const observations=store.observations(r.id),deliveries=observations.filter(x=>x.kind==='delivery'&&x.details.phase==='measured');const last=deliveries.at(-1);const lateness=deliveries.map(x=>Math.max(0,x.details.delivered_at-run.context.measured_start-x.details.scheduled_offset_ms));
  const calls=observations.filter(x=>x.kind==='api_call'),normalCalls=calls.filter(x=>Date.parse(x.at)>=run.context.measured_start&&Date.parse(x.at)<=Math.min(workFinishedAt,run.context.measured_start+run.config.duration_ms)),p95=values=>{const sorted=values.filter(Number.isFinite).sort((a,b)=>a-b);return sorted.length?sorted[Math.ceil(sorted.length*.95)-1]:null;};
  const accepted=ops.filter(x=>x.kind==='event'&&x.input.phase==='measured'&&x.result?.id),seedEvents=ops.filter(x=>x.kind==='event'&&x.input.phase==='seed'),seedObjects=new Set(seedEvents.map(x=>x.result?.result?.id));
  const metrics={scheduler_version:PROFILE_SCHEDULER_VERSION,shift_evidence:run.context.shift??null,company_id:r.target.company_id,boundary:snapshot.version,planned_unique_events:run.config.unique_measured,delivered_unique_events:accepted.length,measured_orders:accepted.filter(x=>x.input.event.event_type==='order.create').length,measured_receipts:accepted.filter(x=>x.input.event.event_type==='receipt.create').length,measured_updates:accepted.filter(x=>x.input.event.event_type==='order.update').length,initial_seed_events:seedEvents.length,completed_measured_receipts:ops.filter(x=>x.kind==='command'&&x.status==='done'&&x.input.command==='receipt.putaway'&&!seedObjects.has(x.input.payload.receipt_id)).length,completed_shipments:ops.filter(x=>x.kind==='command'&&x.status==='done'&&x.input.command==='shipment.create').length,maximum_delivery_lateness_ms:Math.max(0,...lateness),first_delivery_at:deliveries[0]?.at,last_delivery_at:last?.at,elapsed_ms:Date.now()-run.context.measured_start,worker_accounts:r.workers.length,api_calls:calls.length,read_calls:calls.filter(x=>x.details.method==='GET').length,write_calls:calls.filter(x=>x.details.method==='POST').length,latency:{sample_count:calls.length,all_p95_ms:p95(calls.map(x=>x.details.latency_ms)),external_acceptance_p95_ms:p95(calls.filter(x=>x.details.path==='/api/v2/integration/events'&&x.details.method==='POST'&&x.details.status===202).map(x=>x.details.latency_ms)),physical_command_p95_ms:p95(calls.filter(x=>x.details.path==='/api/v2/workflow'&&x.details.method==='POST'&&x.details.status===200).map(x=>x.details.latency_ms)),queue_application_p95_ms:p95(accepted.map(x=>Date.parse(x.result.processed_at)-Date.parse(x.result.received_at)))},technical_error_count:calls.filter(x=>x.details.status===0||x.details.status>=500).length,successful_physical_commands:ops.filter(x=>x.kind==='command'&&x.status==='done').length,expected_business_rejections:ops.filter(x=>x.status==='expected_business_rejected').length,ledger_rows:ledger.filter(x=>items.has(x.item_id)).length,differences,incomplete};
  const physical=normalCalls.filter(x=>x.details.path==='/api/v2/workflow'&&x.details.method==='POST'&&x.details.status===200),acceptance=normalCalls.filter(x=>x.details.path==='/api/v2/integration/events'&&x.details.method==='POST'&&x.details.status===202),technical=normalCalls.filter(x=>x.details.status===0||x.details.status>=500),application=accepted.filter(x=>x.status==='done').map(x=>Date.parse(x.result.processed_at)-Date.parse(x.result.received_at)).filter(Number.isFinite);
  const qualityChecks={physical_confirmation_p95:{observed_ms:p95(physical.map(x=>x.details.latency_ms)),maximum_ms:1500,samples:physical.length},external_acceptance_p95:{observed_ms:p95(acceptance.map(x=>x.details.latency_ms)),maximum_ms:1000,samples:acceptance.length},external_application_p95:{observed_ms:p95(application),maximum_ms:5000,samples:application.length},technical_failure_rate:{numerator:technical.length,denominator:normalCalls.length,observed:normalCalls.length?technical.length/normalCalls.length:null,strict_maximum:0.001},recovery:{observed_ms:Math.max(0,workFinishedAt-run.context.measured_start-run.config.duration_ms),maximum_ms:600000,unresolved:incomplete.length}};
  const qualityMet=Object.values(qualityChecks).every(check=>check.strict_maximum!==undefined?check.observed!==null&&check.observed<check.strict_maximum:check.unresolved!==undefined?check.unresolved===0&&check.observed_ms<=check.maximum_ms:check.samples>0&&check.observed_ms<=check.maximum_ms);
  metrics.quality_targets={qualification:!kind.endsWith('smoke'),met:qualityMet,window_start:new Date(run.context.measured_start).toISOString(),window_end:new Date(Math.min(workFinishedAt,run.context.measured_start+run.config.duration_ms)).toISOString(),baseline_seed_and_final_reconciliation_excluded:true,latency_definition:'Client request start through complete response body and JSON decoding.',checks:qualityChecks,limitations:['Successful HTTP workflow responses measure automated command confirmation, not real scanner hardware latency.','Browser display and real-device requirements need their separate evidence.']};
  metrics.profile_quality=evaluateProfileQuality({kind,start_ms:run.context.measured_start,duration_ms:run.config.duration_ms,observed_at_ms:workFinishedAt,events:qualityEvents(ops),calls:calls.map(call=>call.details),peak_cohort:run.context.peak_cohort,expected_outcomes:r.expectedOutcomes});
  metrics.expected_outcome_policy=r.expectedOutcomes;metrics.expected_revision_rejections=rejectedRevisionDetails(ops);
  metrics.control_read_recovery=run.context.control_retry??null;metrics.runtime_failure=r.runtimeFailure??null;metrics.shutdown_failures=r.shutdownFailures??[];metrics.final_reconciliation={status:'completed',boundary:snapshot.version,independent_match:differences.length===0,read_retries:r.finalReadRetries??0};
  metrics.integrity_passed=!r.runtimeFailure&&finished&&!incomplete.length&&!differences.length&&accepted.length===run.config.unique_measured&&metrics.completed_shipments===metrics.measured_orders&&metrics.completed_measured_receipts===metrics.measured_receipts;
  metrics.verdict=!r.runtimeFailure&&finished&&!incomplete.length&&!differences.length&&accepted.length===run.config.unique_measured&&metrics.completed_shipments===metrics.measured_orders&&metrics.completed_measured_receipts===metrics.measured_receipts&&metrics.maximum_delivery_lateness_ms<1000&&(kind.endsWith('smoke')||qualityMet&&metrics.profile_quality.met)?'passed':'failed';store.updateRun(r.id,{status:finished?'finished':'paused',report:metrics});companies.push(metrics);
 }catch(error){companies.push(failedCompany(r,error,'final_reconciliation'));}}
 const report={run_id:rootId,profile:kind,scenario_version:'1.1',generator_version:'2.0.0',scheduler_version:PROFILE_SCHEDULER_VERSION,recovery_version:PROFILE_RECOVERY_VERSION,quality_reporting_version:qualityReportingVersion,source_lanes:{new_transmissions:PROFILE_SOURCE_LANE_LIMIT,result_polls:PROFILE_SOURCE_LANE_LIMIT,total_source_requests:2*PROFILE_SOURCE_LANE_LIMIT,pulse_ms:50,processor_requests:1,physical_workers_per_company:10},seed:config.seed??20261020,generated_at:new Date().toISOString(),execution:finished?'finished':'interrupted',verdict:companies.every(x=>x.verdict==='passed')?'passed':'failed',companies,limitations:['Local profile execution is separate from deployed hosting or real device/field approval.','Transport fault and restore need their dedicated evidence; shift profiles persist real reservation age, ownership changes and shift-close evidence.']};const reportSaved=await persistReport(report);console.log(JSON.stringify({run_id:rootId,status:report.execution,verdict:report.verdict,report_saved:reportSaved,report:reportFile}));
}catch(error){await settleRuntime();const failures=runtime.map(r=>failedCompany(r,error,'runtime'));await persistReport({run_id:rootId,profile:kind,scheduler_version:PROFILE_SCHEDULER_VERSION,recovery_version:PROFILE_RECOVERY_VERSION,execution:'interrupted',verdict:'failed',generated_at:new Date().toISOString(),runtime_failure:errorEvidence(error),companies:failures});
}finally{await settleRuntime();store.close();}
