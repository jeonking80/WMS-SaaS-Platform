import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { openStore } from '../store.mjs';
import { profilePlan } from '../profile-plan.mjs';
import { SHIFT_DURATION_MS,validateShiftConfiguration,evaluateShiftJournal,reconcileShiftBoundary,reconcileShiftRuntime,shiftPolicy,shiftWorkAllowed,shiftWorkerIndex,performShiftMilestones,baselineDeltas } from '../shift-profile.mjs';

function configuration(full=true) {
  const environment={DATABASE_URL:'must-not-be-used'},targets=[];
  for(let company=0;company<2;company++){
    const slots=Array.from({length:20},randomUUID),catalog=Array.from({length:full?100:2},(_,index)=>({item_id:randomUUID(),receiving_id:slots[index%5],storage_id:slots[5+index%5],staging_id:slots[10+index%5],hold_id:slots[15+index%5]}));
    const bindings=Array.from({length:(full?10:2)+3},(_,index)=>`C${company}_KEY_${index}`);
    for(const binding of bindings)environment[binding]='synthetic-'+binding;
    targets.push({url:'http://127.0.0.1:3000',company_id:randomUUID(),warehouse_id:randomUUID(),supplier_id:randomUUID(),customer_id:randomUUID(),destination_id:randomUUID(),expected_at:'2027-01-01T00:00:00Z',due_at:'2027-01-02T00:00:00Z',source_key_env:bindings[0],process_key_env:bindings[1],supervisor_key_env:bindings[2],worker_key_envs:bindings.slice(3),smoke_duration_ms:15000,catalog});
  }
  return {config:{targets,seed:5},environment};
}
function journal(mode='smoke') {
  const {config}=configuration(mode==='full'),target=config.targets[0],operations=[],orders=mode==='full'?1000:4,receipts=mode==='full'?100:2;
  const stage=(command,payload,result)=>operations.push({kind:'command',status:'done',role:String(operations.length%target.worker_key_envs.length),input:{command,payload,oracle_deltas:[]},result:{result:{id:result??randomUUID()}}});
  for(let index=0;index<receipts;index++){
    const id=randomUUID();operations.push({kind:'event',status:'done',input:{phase:'measured',event:{event_id:randomUUID(),event_type:'receipt.create',payload:{lines:[{item_id:target.catalog[0].item_id,quantity:1}]}}},result:{result:{id}}});
    for(const command of ['receipt.receive','receipt.inspect','receipt.putaway'])stage(command,{receipt_id:id});
  }
  for(let index=0;index<orders;index++){
    const id=randomUUID(),pack=randomUUID();operations.push({kind:'event',status:'done',input:{phase:'measured',event:{event_id:randomUUID(),event_type:'order.create',payload:{lines:[{item_id:target.catalog[0].item_id,quantity:1}]}}},result:{result:{id}}});
    for(const command of ['order.reserve','order.pick','package.create'])stage(command,{order_id:id},command==='package.create'?pack:undefined);
    stage('shipment.create',{package_ids:[pack]});
  }
  const duration=mode==='full'?SHIFT_DURATION_MS:15000,start=1700000000000;
  return {mode,target,run:{context:{measured_start:start,shift:{initial_assignment_completed_at:start+1,long_reservation_observed_at:start+duration/4,handover_completed_at:start+duration/2,reservation_age_at_warning_ms:duration/4,initial_assignee:'worker-old',final_assignee:'worker-new'}},config:{duration_ms:duration}},operations,runtimeReport:{verdict:'passed',quality_targets:{qualification:mode==='full',met:true},profile_quality:{qualification:mode==='full',met:true},delivered_unique_events:orders+receipts,incomplete:[],differences:[]},observedAt:start+duration};
}

test('full profile requires exactly two companies, 100 distinct SKUs, 20 locations and ten distinct worker identities',()=>{
  const {config,environment}=configuration();assert.equal(validateShiftConfiguration(config,'full',environment).duration_ms,SHIFT_DURATION_MS);
  config.targets[0].worker_key_envs.pop();assert.throws(()=>validateShiftConfiguration(config,'full',environment),/TEN_WORKERS_REQUIRED/);
});
test('a smoke duration never satisfies the eight-hour requirement, even with successful physical stages',()=>{
  const input=journal();const result=evaluateShiftJournal(input);assert.equal(result.verdict,'smoke_passed');assert.equal(result.eight_hour_requirement_passed,false);
  input.mode='full';assert.equal(evaluateShiftJournal(input).eight_hour_requirement_passed,false);
});
test('completed full work does not pass before eight real hours and cannot collapse two external orders into one object',()=>{
  const input=journal('full');assert.equal(evaluateShiftJournal(input).eight_hour_requirement_passed,true);
  input.observedAt--;assert(evaluateShiftJournal(input).failures.includes('DURATION_NOT_COMPLETED'));input.observedAt++;
  const orders=input.operations.filter(op=>op.kind==='event'&&op.input.event.event_type==='order.create');orders[1].result.result.id=orders[0].result.result.id;
  assert(evaluateShiftJournal(input).failures.includes('OBJECT_BINDING_DUPLICATE'));
});
test('a missing physical handover cannot pass by relying on a successful runtime report alone',()=>{
  const input=journal();input.operations.find(op=>op.kind==='command'&&op.input.command==='shipment.create').status='unconfirmed';const result=evaluateShiftJournal(input);
  assert.equal(result.verdict,'failed');assert(result.failures.includes('PHYSICAL_STAGE_INCOMPLETE:shipment.create'));
});
test('independent boundary reconciliation catches equal stock and ledger corruption across multiple ledger pages',async()=>{
  const target={warehouse_id:randomUUID(),catalog:[{item_id:randomUUID()}]},item=target.catalog[0].item_id,location=randomUUID();let pages=0;
  const api=async(_role,path)=>{
    if(path.includes('/workflow?'))return {snapshot:{version:5,stock:[{item_id:item,location_id:location,S:11,R:0,P:0,Q:0,B:0,H:11}],orders:[]}};
    pages++;return pages===1?{boundary:5,rows:[{item_id:item,location_id:location,bucket:'S',delta:5}],has_more:true,cursor:'next'}:{boundary:5,rows:[{item_id:item,location_id:location,bucket:'S',delta:6}],has_more:false,cursor:null};
  };
  const result=await reconcileShiftBoundary(target,[{kind:'command',status:'done',input:{oracle_deltas:[{item_id:item,location_id:location,bucket:'S',delta:10}]}}],api,5);
  assert.equal(result.full_ledger_pages,2);assert.equal(result.passed,false);assert.deepEqual(result.differences,[{key:[item,location,'S'].join(':'),expected:10,actual:11,ledger:11}]);
});
test('a changed processing boundary is refused instead of reconciling against a later stock snapshot',async()=>{
  const target={warehouse_id:randomUUID(),catalog:[]};await assert.rejects(reconcileShiftBoundary(target,[],async()=>({snapshot:{version:6}}),5),/SHIFT_BOUNDARY_CHANGED/);
});

test('real milestone controller pauses a held order, observes elapsed reservation age, drains uncertainty and persists a new owner without changing stock',async()=>{
 const directory=await mkdtemp(tmpdir()+'/shift-hooks-'),store=openStore(directory+'/journal.sqlite');
 try{
  const id=randomUUID(),order=randomUUID(),start=Date.now()-20000;
  store.create({id,config:{},target:{}},[{id:randomUUID(),kind:'event',label:'order.create',role:'source',input:{phase:'measured',event:{event_type:'order.create'}}}]);
  const event=store.operations(id)[0];store.updateOp(event.id,{status:'done',result:{result:{id:order}}});store.updateRun(id,{context:{measured_start:start}});
  let snapshot={version:1,orders:[{id:order,lines:[{quantity:1,cancelled:0,shipped:0}],reservations:[]}],receipts:[],returns:[],tasks:[],approvals:[],stock:[{S:5,R:1}]},recoveries=0;
  const runtime={id,target:{warehouse_id:randomUUID()},shiftPolicy:shiftPolicy('shift-smoke',{smoke_duration_ms:15000}),workerActorIds:['machine:a','machine:b'],workers:['a','b'],active:new Set(),recoverCommand:async op=>{recoveries++;store.updateOp(op.id,{status:'done'});},api:async(_role,_path,input)=>{
   if(!input)return {snapshot};
   if(input.command==='task.assign')snapshot={...snapshot,version:2,tasks:[{object_id:order,assignee_id:input.payload.assignee_id}]};
   if(input.command==='shift.close')snapshot={...snapshot,version:3,tasks:[...snapshot.tasks,...input.payload.handover.map(row=>({object_id:row.object_id,assignee_id:row.assignee_id}))]};
   return {result:{id:input.request_id}};
  }};
  let control=await performShiftMilestones(runtime,snapshot,store,start+100);assert.equal(control.pauseWork,true);runtime.lastSnapshot=control.snapshot;
  const pick={input:{command:'order.pick',payload:{order_id:order}}};assert.equal(shiftWorkAllowed(runtime,pick,store),false);
  snapshot={...snapshot,orders:[{...snapshot.orders[0],reservations:[{quantity:1,reserved_at:new Date(start+200).toISOString()}]}]};
  await performShiftMilestones(runtime,snapshot,store,start+4000);
  const uncertain=randomUUID();store.db.prepare('INSERT INTO operations(id,run_id,ordinal,kind,label,role,input,status) VALUES(?,?,?,?,?,?,?,?)').run(uncertain,id,99,'command','order.reserve','0',JSON.stringify({command:'order.reserve',payload:{order_id:order}}),'unconfirmed');
  runtime.active.add(order);control=await performShiftMilestones(runtime,snapshot,store,start+8000);assert.equal(control.pauseWork,true);assert.equal(recoveries,0);runtime.active.clear();
  control=await performShiftMilestones(runtime,snapshot,store,start+8000);assert.equal(recoveries,1);assert.deepEqual(control.snapshot.stock,snapshot.stock);
  runtime.lastSnapshot=control.snapshot;const evidence=store.run(id).context.shift;assert.notEqual(evidence.final_assignee,evidence.initial_assignee);assert(evidence.reservation_age_at_warning_ms>=3750);assert.equal(shiftWorkAllowed(runtime,pick,store),true);assert.equal(runtime.workerActorIds[shiftWorkerIndex(runtime,order)],evidence.final_assignee);
 }finally{store.close();await rm(directory,{recursive:true,force:true});}
});

test('baseline comes from local generator positions and cannot be replaced with equally corrupt live stock and ledger',async()=>{
 const item=randomUUID(),location=randomUUID(),target={warehouse_id:randomUUID(),catalog:[{item_id:item,storage_id:location}],baseline:{source_run_id:randomUUID(),expected_positions:[{item_id:item,location_id:location,S:312,R:0,P:0,Q:0,B:0}]}};
 assert.equal(baselineDeltas(target)[0].delta,312);
 const api=async(_role,path)=>path.includes('/workflow?')?{snapshot:{version:1,stock:[{item_id:item,location_id:location,S:313,R:0,P:0,Q:0,B:0}],orders:[]}}:{boundary:1,rows:[{item_id:item,location_id:location,bucket:'S',delta:313}],has_more:false};
 const result=await reconcileShiftBoundary(target,[],api,1);assert.equal(result.passed,false);assert.equal(result.differences[0].expected,312);
 const plan=profilePlan(randomUUID(),'shift',target.catalog,'test',target.warehouse_id,1,target);assert.equal(plan.events.filter(row=>row.phase==='seed').length,0);assert.equal(plan.unique_measured,1100);
 target.baseline.expected_positions[0].item_id=randomUUID();assert.throws(()=>baselineDeltas(target),/BASELINE_POSITION_SCOPE_INVALID/);
});

test('full functional and T11 completion remains distinguishable when a performance threshold fails',()=>{const input=journal('full');input.runtimeReport.integrity_passed=true;input.runtimeReport.verdict='failed';input.runtimeReport.quality_targets={qualification:true,met:false};const result=evaluateShiftJournal(input);assert.equal(result.functional_passed,true);assert.equal(result.eight_hour_requirement_passed,false);assert(result.failures.includes('PERFORMANCE_TARGETS_NOT_MET'));});

test('unverified raw final read and unstarted measurement preserve failed shift evidence without more HTTP calls',async()=>{
 let calls=0;const api=async()=>{calls++;throw Error('NO_EXTRA_HTTP_ALLOWED');};
 for(const raw of [{boundary:null,final_reconciliation:{status:'unverified'}},{boundary:5,measurement:{status:'not_started'}},{boundary:5,final_reconciliation:{status:'unverified'}},{boundary:undefined}]){
  const result=await reconcileShiftRuntime({target:{},operations:[],api,runtimeReport:raw,verify:api});
  assert.equal(result.passed,false);assert.equal(result.status,'unverified');assert.equal(result.reason,'FINAL_RECONCILIATION_UNVERIFIED');
 }
 assert.equal(calls,0);
 const input=journal();input.run.context.measured_start=undefined;input.runtimeReport={verdict:'failed',integrity_passed:false,boundary:null,measurement:{status:'not_started'},final_reconciliation:{status:'unverified'},delivered_unique_events:0};
 const judged=evaluateShiftJournal(input);assert.equal(judged.verdict,'failed');assert.equal(judged.eight_hour_requirement_passed,false);assert.equal(judged.measured_start,null);assert(judged.failures.includes('DURATION_NOT_COMPLETED'));
});

test('a second independent final read failure remains unverified rather than preventing the shift summary',async()=>{
 const result=await reconcileShiftRuntime({target:{warehouse_id:randomUUID(),catalog:[]},operations:[],runtimeReport:{boundary:5,final_reconciliation:{status:'completed'}},api:async()=>{throw Object.assign(new Error('private database information'),{code:'SHIFT_HTTP_FAILED'});}});
 assert.equal(result.passed,false);assert.equal(result.status,'unverified');assert.equal(result.code,'SHIFT_HTTP_FAILED');assert(!JSON.stringify(result).includes('private database information'));
});

test('full shift never overrides a failed scheduled-window quality report with legacy passing metrics',()=>{
 const input=journal('full');input.runtimeReport.integrity_passed=true;input.runtimeReport.verdict='failed';input.runtimeReport.profile_quality={qualification:true,met:false};
 const result=evaluateShiftJournal(input);assert.equal(result.functional_passed,true);assert.equal(result.performance_targets.met,true);assert.equal(result.scheduled_window_targets.met,false);assert.equal(result.eight_hour_requirement_passed,false);assert.equal(result.verdict,'failed');assert(result.failures.includes('SCHEDULED_WINDOW_TARGETS_NOT_MET'));
});

test('full shift requires qualified scheduled-window evidence while smoke remains a functional check',()=>{
 for(const evidence of [undefined,{qualification:false,met:true}]){
  const full=journal('full');full.runtimeReport.profile_quality=evidence;assert.equal(evaluateShiftJournal(full).eight_hour_requirement_passed,false);
 }
 const smoke=journal();smoke.runtimeReport.integrity_passed=true;smoke.runtimeReport.verdict='failed';smoke.runtimeReport.profile_quality={qualification:false,met:false};
 const result=evaluateShiftJournal(smoke);assert.equal(result.verdict,'smoke_passed');assert.equal(result.functional_passed,true);assert.equal(result.eight_hour_requirement_passed,false);
});

test('full shift requires the raw runtime verdict even when both quality reports and integrity pass',()=>{
 const input=journal('full');input.runtimeReport.integrity_passed=true;input.runtimeReport.verdict='failed';
 const result=evaluateShiftJournal(input);assert.equal(result.functional_passed,true);assert.equal(result.performance_targets.met,true);assert.equal(result.scheduled_window_targets.met,true);assert.equal(result.runtime_verdict,'failed');assert.equal(result.eight_hour_requirement_passed,false);assert.equal(result.verdict,'failed');assert(result.failures.includes('RUNTIME_FINAL_VERDICT_FAILED'));
});
