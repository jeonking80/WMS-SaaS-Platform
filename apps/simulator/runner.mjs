import { createHash,randomUUID } from 'node:crypto';
import { makePlan,validateConfig,resolveRefs,VERSION } from './planner.mjs';
import { reconcile } from './oracle.mjs';
import { nextWorkingTime } from './scheduling.mjs';
export class HttpFailure extends Error {constructor(status,code,retryAfter=0){super(code);this.status=status;this.retryAfter=retryAfter;}}
const terminal=op=>['done','expected_rejected'].includes(op.status);
export function retryAt(attempt,retryAfter=0,now=Date.now(),random=Math.random){return now+Math.max(retryAfter*1000,Math.min(30000,1000*2**Math.min(attempt,5))*(0.5+random()*0.5));}
export function createRunner(store,settings,fetcher=fetch){
  const running=new Set();let timer;
  const workerKeys=settings.workerKeys?.length?settings.workerKeys:[settings.workerKey].filter(Boolean);
  const keys={source:settings.sourceKey,process:settings.processKey,worker:workerKeys[0],supervisor:settings.supervisorKey,approver:settings.approverKey,prepare:settings.prepareKey,...Object.fromEntries(workerKeys.map((key,i)=>['worker:'+i,key]))};
  async function api(role,path,body,runId){
    if(!keys[role])throw new HttpFailure(401,'MISSING_'+role.toUpperCase()+'_KEY');
    if(runId){const current=store.run(runId);if(current?.context.outage_until>Date.now())throw new HttpFailure(503,'INJECTED_NETWORK_OUTAGE',Math.ceil((current.context.outage_until-Date.now())/1000));if(current?.context.outage_until&&!current.context.outage_recovered){store.updateRun(runId,{context:{...current.context,outage_recovered:true}});store.observe(runId,'injected_network_outage_ended',{at:new Date().toISOString(),duration_ms:Date.now()-current.context.outage_started});}}
    const started=Date.now();let response;try{response=await fetcher(new URL(path,settings.url),{method:body?'POST':'GET',headers:{authorization:'Bearer '+keys[role],'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(15000),redirect:'error'});}catch{if(runId)store.observe(runId,'api_call',{role,path:path.split('?')[0],method:body?'POST':'GET',status:0,latency_ms:Date.now()-started});throw new HttpFailure(503,'NETWORK_UNAVAILABLE');}
    let value;try{value=await response.json();}catch{throw new HttpFailure(503,'INVALID_SERVER_RESPONSE');}finally{if(runId)store.observe(runId,'api_call',{role,path:path.split('?')[0],method:body?'POST':'GET',status:response.status,latency_ms:Date.now()-started});}
    if(!response.ok){const raw=response.headers.get('retry-after');const seconds=raw?Number(raw):0;const retryAfter=Number.isFinite(seconds)?seconds:Math.max(0,(Date.parse(raw)-Date.now())/1000);throw new HttpFailure(response.status,/^[A-Z0-9_]{1,100}$/.test(value.error??'')?value.error:'HTTP_'+response.status,retryAfter);}
    return value;
  }
  async function connection(runId){
    const value=await api('source','/api/v2/integration/connection',undefined,runId);
    if(value.contract_version!=='2.0'||value.environment!=='test'||value.test_company!==true||value.company_id!==settings.companyId||value.kind!=='integration')throw new HttpFailure(403,'TEST_TARGET_REQUIRED');
    const target={url:new URL(settings.url).origin,company_id:value.company_id,environment:value.environment,source_system:value.source_system,warehouse_ids:[...value.warehouse_ids].sort(),contract_version:value.contract_version};
    return {...target,warehouses:value.warehouses??[],fingerprint:createHash('sha256').update(JSON.stringify(target)).digest('hex')};
  }
  async function ensureTarget(run){const current=await connection(run.id);if(current.fingerprint!==run.target.fingerprint)throw new HttpFailure(403,'TARGET_CHANGED_RESUME_BLOCKED');return current;}
  async function snapshot(run){return (await api('worker','/api/v2/workflow?warehouse_id='+run.config.warehouse_id,undefined,run.id)).snapshot;}
  async function ledgerAt(run,boundary){const rows=[];let cursor;for(let page=0;page<100000;page++){const response=await api('worker','/api/v2/workflow/ledger?warehouse_id='+run.config.warehouse_id+'&item_id='+run.config.item_id+'&boundary='+boundary+'&limit=100'+(cursor?'&cursor='+encodeURIComponent(cursor):''),undefined,run.id);rows.push(...response.rows);if(!response.has_more)return rows;if(!response.cursor||response.cursor===cursor)throw new HttpFailure(503,'LEDGER_CURSOR_STALLED');cursor=response.cursor;}throw new HttpFailure(503,'LEDGER_PAGE_LIMIT');}
  function refreshContext(run,snap,op,response){
    const context={...store.run(run.id).context};const command=op?.input.command??op?.input.event_type;const result=response?.result??response;
    if(command==='receipt.create')context.receipt_id=result?.id;
    if(command==='order.create')context.order_id=result?.id;
    if(command==='order.create'&&op?.label.includes('|'))context[op.label.split('|')[1]]=snap.orders.find(x=>x.id===result?.id);
    if(command==='return.request')context.return_id=result?.id;
    if(command==='shipment.create')context.shipment_id=result?.id;
    if(op?.input.bind)context[op.input.bind]={id:result?.id};
    for(const [name,collection]of [['receipt','receipts'],['order','orders'],['return','returns'],['shipment','shipments']]){
      const id=context[name+'_id'];if(id)context[name]=snap[collection]?.find(x=>x.id===id)??context[name];
    }
    store.updateRun(run.id,{context});return context;
  }
  async function create(config){
    const valid=validateConfig(config),target=await connection();
    if(!keys.process||!keys.worker)throw new HttpFailure(400,'PROCESS_AND_WORKER_KEYS_REQUIRED');
    if(!target.warehouse_ids.includes(valid.warehouse_id))throw new HttpFailure(403,'WAREHOUSE_FORBIDDEN');
    if(valid.mode==='auto'&&(valid.scenario==='damage'||valid.scenario==='mixed_pattern'&&valid.damage_ratio>0)&&!keys.approver)throw new HttpFailure(400,'SEPARATE_APPROVER_KEY_REQUIRED');
    if((valid.handover_after_ms||valid.worker_role==='supervisor')&&!keys.supervisor)throw new HttpFailure(400,'SEPARATE_SUPERVISOR_KEY_REQUIRED');
    const credentials=[keys.source,keys.process,...workerKeys,keys.approver,keys.prepare,keys.supervisor].filter(Boolean);if(new Set(credentials).size!==credentials.length)throw new HttpFailure(400,'SEPARATE_MACHINE_KEYS_REQUIRED');
    if(valid.worker_count>workerKeys.length)throw new HttpFailure(400,'CONFIGURE_DISTINCT_WORKER_KEYS');
    const initial=await api('worker','/api/v2/workflow?warehouse_id='+valid.warehouse_id);
    if(valid.scenario==='count'&&initial.snapshot.stock.some(x=>x.location_id===valid.storage_id&&['S','R','P','Q','B'].some(b=>x[b]!==0)))throw new HttpFailure(409,'DEDICATED_COUNT_LOCATION_REQUIRED');
    if(initial.snapshot.stock.some(x=>x.item_id===valid.item_id&&['S','R','P','Q','B'].some(b=>x[b]!==0))||initial.snapshot.ledger.some(x=>x.item_id===valid.item_id)||[...initial.snapshot.receipts,...initial.snapshot.orders].some(x=>x.lines.some(l=>l.item_id===valid.item_id)))throw new HttpFailure(409,'DEDICATED_UNUSED_ITEM_REQUIRED');
    const id=randomUUID(),plan=makePlan(id,valid,target.source_system);let workerIndex=0;for(const op of plan)if(op.kind==='command'&&op.role==='worker')op.role=valid.worker_role==='supervisor'&&!op.input.expect_error?'supervisor':'worker:'+(workerIndex++%valid.worker_count);
    store.create({id,config:{...valid,generator_version:VERSION,scenario_version:'1.1',contract_version:'2.0',baseline:'unused_item_zero'},target},plan);
    store.observe(id,'created',{generator_version:VERSION,seed:valid.seed,target:target.fingerprint});return store.run(id);
  }
  async function settleEvent(run,op){
    const query=await api('source','/api/v2/integration/events?warehouse_id='+run.config.warehouse_id+'&event_id='+op.input.event_id,undefined,run.id);
    const result=query.events[0];if(!result)return false;
    store.updateOp(op.id,{result});
    if(result.status==='applied'){
      store.updateOp(op.id,{status:'done',error:null});const snap=await snapshot(run);refreshContext(run,snap,op,result.result);store.observe(run.id,'event_applied',{operation_id:op.id,event_id:op.input.event_id,receipt_id:result.id});return true;
    }
    if(['business_rejected','quarantined'].includes(result.status)){store.updateOp(op.id,{status:result.status,error:result.reason});store.updateRun(run.id,{status:'blocked'});return true;}
    store.updateOp(op.id,{status:result.status==='dependency_wait'?'dependency_wait':'unconfirmed',next_at:Date.now()+run.config.delay_ms});return true;
  }
  async function settleCommand(run,op){
    try{const original=await api(op.role,'/api/v2/workflow?warehouse_id='+run.config.warehouse_id+'&request_id='+op.input.request_id,undefined,run.id);if(original?.result){store.updateOp(op.id,{status:'done',result:{result:original.result,version:original.version},error:null});refreshContext(run,original.snapshot,op,original);return true;}}catch(error){if(error.status!==404)throw error;}return false;
  }
  async function dispatch(run,op){
    // Resolve and persist the final immutable request before the first network call.
    const input=resolveRefs(op.input,run.context);const final={...op,input};
    if(op.status==='unsent'){store.observe(run.id,'initial_dispatch',{operation_id:op.id,role:op.role,kind:op.kind,at_ms:Date.now(),not_before:op.next_at??0,worker_not_before:op.kind==='command'?(store.run(run.id).context.worker_next_at??0):0});store.updateOp(op.id,{input,status:'unconfirmed'});if(op.kind==='command')store.saveIntent(run.id,final,input.payload);}
    if(op.kind==='event'){
      if(await settleEvent(run,final))return;
      const response=await api('source','/api/v2/integration/events',input,run.id);
      store.updateOp(op.id,{result:response,status:'unconfirmed',next_at:Date.now()+run.config.delay_ms});
      if(op.options?.duplicate??run.config.duplicate){const duplicate=await api('source','/api/v2/integration/events',input,run.id);if(duplicate.event.id!==response.event.id||!duplicate.replayed)throw new HttpFailure(409,'DUPLICATE_ACCEPTANCE_CHANGED');store.observe(run.id,'duplicate_verified',{event_id:input.event_id,receipt_id:response.event.id});}
      // Fault injection discards a successful response locally; recovery still polls the original key.
      if((op.options?.lose_response??run.config.lose_response)&&op.attempts===0){store.updateOp(op.id,{result:null});store.observe(run.id,'injected_response_loss',{operation_id:op.id});}
      if(run.config.outage_seconds&&!run.context.outage_until){const started=Date.now();store.updateRun(run.id,{context:{...run.context,outage_started:started,outage_until:started+run.config.outage_seconds*1000}});store.observe(run.id,'injected_network_outage_started',{seconds:run.config.outage_seconds,accepted_event_id:input.event_id});}
      return;
    }
    if(op.status!=='unsent'&&await settleCommand(run,final))return;
    const {bind,expect_error,parallel_group,allowed_error,...body}=input;void bind;void parallel_group;
    let response;try{response=await api(op.role,'/api/v2/workflow',body,run.id);}catch(error){if((expect_error||allowed_error)&&error.message===(expect_error??allowed_error)){store.updateOp(op.id,{status:'expected_rejected',result:{expected_error:error.message},error:null});store.observe(run.id,'expected_business_rejection',{operation_id:op.id,command:input.command,reason:error.message});return;}throw error;}
    if(expect_error)throw new HttpFailure(409,'EXPECTED_REJECTION_WAS_ACCEPTED');
    if((op.options?.lose_response??run.config.lose_response)&&op.attempts===0){store.observe(run.id,'injected_response_loss',{operation_id:op.id});store.updateOp(op.id,{status:'unconfirmed',next_at:Date.now()+run.config.delay_ms});return;}
    store.updateOp(op.id,{status:'done',result:{result:response.result,version:response.version},error:null});refreshContext(run,response.snapshot,final,response);store.observe(run.id,'command_applied',{operation_id:op.id,request_id:input.request_id,command:input.command});
  }
  async function tick(id){
    if(running.has(id))return;const run=store.run(id);if(!run||run.status!=='running')return;running.add(id);
    try{
      const scheduled=store.operations(id).find(x=>!terminal(x)&&x.status!=='dependency_wait')??store.operations(id).find(x=>x.status==='dependency_wait');
      if(scheduled&&scheduled.next_at>Date.now())return;
      await ensureTarget(run);
      if(store.operations(id).some(x=>x.kind==='event'&&!terminal(x)&&x.status!=='unsent'))await api('process','/api/v2/integration/process',{warehouse_id:run.config.warehouse_id,limit:50},run.id);
      const ops=store.operations(id);
      // Revision test intentionally dispatches the later event first and then sends its dependencies.
      let op=ops.find(x=>!terminal(x)&&x.status!=='dependency_wait');
      if(!op)op=ops.find(x=>x.status==='dependency_wait');
      if(!op){await finish(id);return;}
      if(op.next_at>Date.now())return;
      if(op.status==='unsent'){
        const now=Date.now(),current=store.run(id),context=current.context,done=ops.filter(terminal).length;
        if(run.config.interrupt_after_operations&&done>=run.config.interrupt_after_operations&&!context.interruption_done){store.updateRun(id,{status:'paused',context:{...context,interruption_done:true}});store.observe(id,'configured_interruption',{after_operations:done});return;}
        if(op.kind==='command'&&run.config.handover_after_ms&&now-context.started_at>=run.config.handover_after_ms&&!context.handover_completed&&(context.order_id||context.receipt_id)){store.updateRun(id,{status:'awaiting_handoff'});store.observe(id,'handover_due',{elapsed_ms:now-context.started_at});return;}
        const working=nextWorkingTime(now,run.config.working_start,run.config.working_end);
        if(working>now){store.updateOp(op.id,{next_at:working});store.observe(id,'working_hours_wait',{until:new Date(working).toISOString(),timezone:'Asia/Seoul'});return;}
        if(op.kind==='command'&&context.worker_next_at>now){store.updateOp(op.id,{next_at:context.worker_next_at});return;}
        if(op.kind==='event'&&op.options?.delayed&&!op.options.delay_scheduled){const until=now+run.config.event_delay_ms;store.updateOp(op.id,{options:{...op.options,delay_scheduled:true},next_at:until});store.observe(id,'configured_event_delay',{operation_id:op.id,delay_ms:run.config.event_delay_ms});if(until>now)return;}
      }
      if(op.kind==='command'&&!op.input.expect_error&&(run.config.mode==='human'||run.config.mode==='mixed'&&op.role==='approver')){store.updateRun(id,{status:'awaiting_human'});return;}
      if(op.input.parallel_group)await Promise.all(ops.filter(x=>x.input.parallel_group===op.input.parallel_group&&!terminal(x)).map(x=>dispatch(run,x)));else await dispatch(run,op);
      const current=store.run(id);store.updateRun(id,{checkpoint:store.operations(id).filter(x=>x.status==='done').length,context:{...current.context,...(op.kind==='command'&&terminal(store.operation(op.id))?{worker_next_at:Date.now()+(run.config.worker_interval_ms??0)}:{})}});
    }catch(error){
      const latest=store.operations(id).find(x=>!terminal(x)&&x.status!=='dependency_wait');
      const code=error instanceof HttpFailure?error.message:'LOCAL_DEPENDENCY_OR_STATE_ERROR';
      if(latest&&[408,425,429,500,502,503,504].includes(error.status)){
        const attempts=latest.attempts+1;
        store.updateOp(latest.id,{attempts,status:attempts>5?'quarantined':'unconfirmed',error:code,next_at:retryAt(attempts,error.retryAfter)});
        if(attempts>5)store.updateRun(id,{status:'blocked'});
      }else{store.updateRun(id,{status:'blocked'});if(latest)store.updateOp(latest.id,{error:code});}
      store.observe(id,'failure',{code,status:error.status??0});
    }finally{running.delete(id);}
  }
  async function finish(id){
    const run=store.run(id);await ensureTarget(run);
    const first=await snapshot(run),second=await snapshot(run);
    if(first.version!==second.version){store.updateRun(id,{status:'paused'});throw new HttpFailure(409,'ACTIVE_HUMAN_WRITES_STOP_BEFORE_RECONCILIATION');}
    // Snapshot only contains the recent ledger tail. Read every page at the same immutable
    // workflow version so >100-row runs cannot silently compare different boundaries.
    const ledger=await ledgerAt(run,second.version);
    const ops=store.operations(id);const judged=reconcile(run.config,ops,{...second,ledger});
    if(run.config.scenario==='concurrent'){const race=ops.filter(x=>x.input.parallel_group==='reservation_race');if(race.filter(x=>x.status==='done').length!==1||race.filter(x=>x.status==='expected_rejected').length!==1){judged.differences.push({kind:'race_outside_allowed_winner_set'});judged.passed=false;}}
    const unfinished=ops.filter(x=>!terminal(x)).map(x=>({id:x.id,status:x.status,error:x.error}));
    const calls=store.observations(id).filter(x=>x.kind==='api_call'),times=calls.map(x=>x.details.latency_ms).sort((a,b)=>a-b);const p95=times.length?times[Math.ceil(times.length*0.95)-1]:null;
    const evidence=store.observations(id),effects={configuration:run.config,selected_patterns:ops.filter(x=>x.options?.pattern).map(x=>x.options.pattern),delayed_events:evidence.filter(x=>x.kind==='configured_event_delay').length,duplicate_checks:evidence.filter(x=>x.kind==='duplicate_verified').length,response_losses:evidence.filter(x=>x.kind==='injected_response_loss').length,working_hours_waits:evidence.filter(x=>x.kind==='working_hours_wait').length,interruption_completed:!!run.context.interruption_done,handover:run.context.handover_completed??null};
    const missing=[];for(const entry of evidence.filter(x=>x.kind==='initial_dispatch')){const d=entry.details;if(d.at_ms<d.not_before||d.at_ms<d.worker_not_before||nextWorkingTime(d.at_ms,run.config.working_start,run.config.working_end)!==d.at_ms)missing.push('dispatch_outside_configured_schedule');}if(run.config.interrupt_after_operations&&!run.context.interruption_done)missing.push('configured_interruption_not_reached');if(run.config.handover_after_ms&&!run.context.handover_completed)missing.push('configured_handover_not_reached');if(missing.length){judged.passed=false;judged.differences.push(...missing.map(kind=>({kind})));}
    const report={run_id:id,configuration_effects:effects,requirements:['INT-01','INT-02','SIM-01','SIM-02','SIM-03'],scenario:run.config.scenario,scenario_version:run.config.scenario_version,generator_version:VERSION,contract_version:'2.0',seed:run.config.seed,mode:run.config.mode,target:run.target,created_at:run.created_at,generated_at:new Date().toISOString(),execution_status:unfinished.length?'incomplete':'finished',verdict:!unfinished.length&&judged.passed?'passed':'failed',...judged,unfinished,counts:{api_calls:calls.length,read_calls:calls.filter(x=>x.details.method==='GET').length,write_calls:calls.filter(x=>x.details.method==='POST').length,unique_external_events:ops.filter(x=>x.kind==='event').length,physical_commands:ops.filter(x=>x.kind==='command').length,expected_business_rejections:ops.filter(x=>x.status==='expected_rejected').length,confirmed:ops.filter(x=>x.status==='done').length,client_retries:ops.reduce((n,x)=>n+x.attempts,0),ledger_rows:ledger.length},latency:{sample_count:times.length,p95_ms:p95,scope:'local client request latency; no hosting or operational performance certification'},not_executed:['8-hour shift profile','5400-event congestion profile','1-million-row read profile','60-second network outage','live database restore','physical PC/tablet/scanner validation','five-day field operation'],cleanup:{status:'not_executed',reason:'이력보존. 실제취소·반품·승인조정만 허용; 자동 DB초기화 없음.'},reproduction:{command:'npm start',configuration:run.config},evidence:store.observations(id)};
    store.updateRun(id,{status:'finished',boundary:JSON.stringify(judged.boundary),report});return report;
  }
  async function resume(id){const run=store.run(id);if(!run)throw new HttpFailure(404,'RUN_NOT_FOUND');await ensureTarget(run);for(const op of store.operations(id))if(op.status==='quarantined')store.updateOp(op.id,{status:'unconfirmed',attempts:0,next_at:0,error:null});store.updateRun(id,{status:'running',context:{...run.context,started_at:run.context.started_at??Date.now()}});return store.run(id);}
  async function handover(id,{worker_index,reason}){
    let run=store.run(id);if(!run||run.status!=='awaiting_handoff')throw new HttpFailure(409,'NO_HANDOVER_STEP');await ensureTarget(run);
    if(!Number.isInteger(worker_index)||worker_index<0||worker_index>=run.config.worker_count||typeof reason!=='string'||reason.trim().length<3||reason.length>500)throw new HttpFailure(400,'HANDOVER_WORKER_AND_REASON_REQUIRED');
    const nextWorker=store.operations(id).find(x=>x.status==='unsent'&&x.role.startsWith('worker:'));if(!run.context.handover_pending&&nextWorker?.role==='worker:'+worker_index)throw new HttpFailure(400,'CHOOSE_DIFFERENT_HANDOVER_WORKER');
    const actor=workerKeys[worker_index]?.match(/^wms_[^.]+\.([^.]+)\./)?.[1];if(!actor||!keys.supervisor)throw new HttpFailure(400,'SEPARATE_SUPERVISOR_KEY_REQUIRED');
    if(!run.context.handover_pending){const tasks=[['order',run.context.order_id],['receipt',run.context.receipt_id]].filter(x=>x[1]).map(([object_type,object_id])=>({warehouse_id:run.config.warehouse_id,command:'task.assign',request_id:randomUUID(),payload:{object_type,object_id,assignee_id:'machine:'+actor,reason}}));store.updateRun(id,{context:{...run.context,handover_pending:{worker_index,reason,tasks}}});run=store.run(id);}
    const pending=run.context.handover_pending;if(pending.worker_index!==worker_index||pending.reason!==reason)throw new HttpFailure(409,'PRESERVE_PENDING_HANDOVER');
    const before=await snapshot(run),stock=s=>s.stock.filter(x=>x.item_id===run.config.item_id).map(x=>[x.location_id,x.S,x.R,x.P,x.Q,x.B]).sort((a,b)=>a[0].localeCompare(b[0]));
    for(const task of pending.tasks){let result;try{result=await api('supervisor','/api/v2/workflow?warehouse_id='+run.config.warehouse_id+'&request_id='+task.request_id,undefined,id);}catch(e){if(e.status!==404)throw e;}if(!result?.result)await api('supervisor','/api/v2/workflow',task,id);}
    const after=await snapshot(run);if(JSON.stringify(stock(before))!==JSON.stringify(stock(after)))throw new HttpFailure(409,'HANDOVER_CHANGED_PHYSICAL_STOCK');for(const task of pending.tasks)if([...after.tasks].reverse().find(x=>x.object_id===task.payload.object_id)?.assignee_id!==task.payload.assignee_id)throw new HttpFailure(409,'HANDOVER_ASSIGNMENT_NOT_PERSISTED');
    for(const op of store.operations(id))if(op.status==='unsent'&&(op.role.startsWith('worker')||op.role==='supervisor'))store.updateOp(op.id,{role:'worker:'+worker_index,options:{...op.options,previous_role:op.role}});
    const completed={...pending,stock_unchanged:true,assignment_verified:true,completed_at:new Date().toISOString(),assignee_id:'machine:'+actor};store.updateRun(id,{status:'running',context:{...store.run(id).context,handover_completed:completed}});store.observe(id,'handover_completed',completed);return store.run(id);
  }
  async function humanComplete(id,evidence){
    const run=store.run(id);if(!run||run.status!=='awaiting_human')throw new HttpFailure(409,'NO_HUMAN_STEP');await ensureTarget(run);
    const op=store.operations(id).find(x=>!terminal(x));if(!op||op.kind!=='command')throw new HttpFailure(409,'NO_HUMAN_STEP');
    if(typeof evidence.actor!=='string'||!evidence.actor.trim()||typeof evidence.request_id!=='string'||!/^[a-f0-9-]{36}$/i.test(evidence.request_id))throw new HttpFailure(400,'HUMAN_ACTOR_AND_WMS_REQUEST_REQUIRED');
    const input=resolveRefs(op.input,run.context);const response=await api('worker','/api/v2/workflow?warehouse_id='+run.config.warehouse_id+'&request_id='+evidence.request_id);
    const commandSnapshot=response.snapshot;const observed=await snapshot(run);
    if(commandSnapshot.version!==observed.version)throw new HttpFailure(409,'HUMAN_RESULT_BOUNDARY_CHANGED');
    // The human request must have exactly the planned physical effect, checked independently.
    const hypothetical=store.operations(id).map(x=>x.id===op.id?{...x,input,status:'done',result:response}:x);
    const judged=reconcile(run.config,hypothetical,{...observed,ledger:await ledgerAt(run,observed.version)});if(!judged.passed)throw new HttpFailure(409,'HUMAN_INTENT_QUANTITY_MISMATCH');
    store.updateOp(op.id,{input,status:'done',result:{result:response.result,version:response.version}});store.saveIntent(id,{...op,input},input.payload);refreshContext(run,observed,{...op,input},response);store.observe(id,'human_confirmation',{operation_id:op.id,actor:evidence.actor,request_id:evidence.request_id});store.updateRun(id,{status:'running'});return store.run(id);
  }
  return {api,connection,create,resume,handover,humanComplete,finish,tick,
    pause(id){store.updateRun(id,{status:'paused'});store.observe(id,'paused',{in_flight:running.has(id),human_stopped:'must_confirm_before_final_boundary'});},
    start(){if(timer)return;for(const run of store.list())if(run.status==='running')store.updateRun(run.id,{status:'paused'});timer=setInterval(()=>{for(const run of store.list())if(run.status==='running')void tick(run.id);},250);},
    stop(){clearInterval(timer);timer=undefined;}
  };
}
