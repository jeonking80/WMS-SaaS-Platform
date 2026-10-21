import {retryAt} from './runner.mjs';
import {qualityEvents,rejectedRevisionDetails} from './profile-index.mjs';
import {evaluateProfileQuality} from './profile-quality.mjs';
export const PROFILE_RECOVERY_VERSION='bounded-control-and-final-read-v1';
export const CONTROL_ATTEMPT_LIMIT=6;
export const FINAL_READ_ATTEMPT_LIMIT=3;
export const FINAL_READ_BUDGET_MS=60000;
export function errorEvidence(error){return {status:Number.isInteger(error?.status)?error.status:0,code:/^[A-Z0-9_]{1,100}$/.test(error?.code??error?.message??'')?error.code??error.message:'PROFILE_OPERATION_FAILED'};}
export function retryableRead(error){return error?.status===429||error?.status>=500&&error?.status<600;}
export function recoveryDeadline(start,duration){return Number.isFinite(start)&&start>0?start+duration+600000:null;}
export async function controlAttempt({state={},operation,now=Date.now,random=Math.random}){
 if(state.status==='exhausted'||state.status==='permanent_failure')return {status:'failed',state};
 if((state.next_at??0)>now())return {status:'waiting',state};
 try{
  const value=await operation();
  return {status:'ready',value,state:{...state,status:'ready',attempts:0,next_at:0,...(state.attempts?{recovered_at_ms:now()}:{} )}};
 }catch(error){
  const attempts=(state.attempts??0)+1,evidence=errorEvidence(error),retryable=retryableRead(error),at=now();
  return {status:retryable&&attempts<CONTROL_ATTEMPT_LIMIT?'retrying':'failed',state:{...state,status:!retryable?'permanent_failure':attempts>=CONTROL_ATTEMPT_LIMIT?'exhausted':'retry_wait',attempts,next_at:retryable&&attempts<CONTROL_ATTEMPT_LIMIT?retryAt(attempts,error.retryAfter,at,random):0,total_failures:(state.total_failures??0)+1,last_failure_at_ms:at,last_failure:evidence}};
 }
}
export async function boundedRead(operation,{now=Date.now,wait=ms=>new Promise(resolve=>setTimeout(resolve,ms)),random=Math.random,onRetry=()=>{},attemptLimit=FINAL_READ_ATTEMPT_LIMIT,budgetMs=FINAL_READ_BUDGET_MS}={}){
 const deadline=now()+budgetMs;let last;
 for(let attempt=1;attempt<=attemptLimit;attempt++){
  const remaining=deadline-now();if(remaining<=0)break;
  try{return await operation({attempt,remaining_ms:remaining});}catch(error){
   last=error;const next=retryAt(attempt,error.retryAfter,now(),random);
   if(!retryableRead(error)||attempt>=attemptLimit||next>=deadline)throw Object.assign(new Error(!retryableRead(error)?'FINAL_READ_PERMANENT_FAILURE':'FINAL_READ_RETRY_EXHAUSTED'),{code:!retryableRead(error)?'FINAL_READ_PERMANENT_FAILURE':'FINAL_READ_RETRY_EXHAUSTED',status:error?.status??0,attempts:attempt,last_failure:errorEvidence(error)});
   onRetry({attempt,next_at:next,last_failure:errorEvidence(error)});await wait(Math.max(0,next-now()));
  }
 }
 throw Object.assign(new Error('FINAL_READ_BUDGET_EXHAUSTED'),{code:'FINAL_READ_BUDGET_EXHAUSTED',status:last?.status??0,last_failure:errorEvidence(last)});
}

export function unverifiedCompanyReport({run,operations,calls,company_id,kind,stage,error,runtime_failure=null,expected_outcomes=[],scheduler_version,last_observed_boundary=null,now_ms=Date.now()}){
 const allowedFinal=new Set(['done','expected_business_rejected','superseded']),start=run.context.measured_start,started=Number.isFinite(start)&&start>0;
 const end=started?Math.min(now_ms,start+run.config.duration_ms):null,failure=errorEvidence(error);
 const normal=calls.filter(row=>started&&Date.parse(row.at)>=start&&Date.parse(row.at)<=end),technical=rows=>rows.filter(row=>row.details.status===0||row.details.status>=500).length;
 const report={company_id,scheduler_version,recovery_version:PROFILE_RECOVERY_VERSION,measurement:{status:started?'started':'not_started',started_at_ms:started?start:null,elapsed_ms:started?now_ms-start:null,preparation_started_at_ms:run.context.seed_start??null},planned_unique_events:run.config.unique_measured,delivered_unique_events:operations.filter(op=>op.kind==='event'&&op.input.phase==='measured'&&op.result?.id).length,boundary:null,last_observed_boundary,integrity_passed:false,verdict:'failed',final_reconciliation:{status:'unverified',stage,http_status:failure.status,code:failure.code,attempts:error?.attempts??null,last_failure:error?.last_failure??null},runtime_failure,incomplete:operations.filter(op=>!allowedFinal.has(op.status)).map(op=>({id:op.id,kind:op.kind,status:op.status,error:op.error})),differences:null,api_calls:calls.length,technical_error_count:technical(calls),normal_window_attempts:{denominator:normal.length,technical_failures:technical(normal),http_429:normal.filter(row=>row.details.status===429).length,window_start_ms:started?start:null,window_end_ms:end},quality_targets:{qualification:started&&!kind.endsWith('smoke'),met:false,reason:started?'FINAL_RECONCILIATION_UNVERIFIED':'MEASUREMENT_NOT_STARTED'},expected_outcome_policy:expected_outcomes,expected_revision_rejections:rejectedRevisionDetails(operations)};
 try{report.profile_quality=started?evaluateProfileQuality({kind,start_ms:start,duration_ms:run.config.duration_ms,observed_at_ms:now_ms,events:qualityEvents(operations),calls:calls.map(row=>row.details),peak_cohort:run.context.peak_cohort,expected_outcomes}):{qualification:false,met:false,reason:'MEASUREMENT_NOT_STARTED'};}catch(error){report.profile_quality={met:false,error:errorEvidence(error)};}
 return report;
}
export function retryAfterSeconds(value,now_ms=Date.now()){
 if(!value)return 0;const seconds=Number(value);return Number.isFinite(seconds)?Math.max(0,seconds):Math.max(0,(Date.parse(value)-now_ms)/1000)||0;
}
export async function settleProfileTasks({source,physical=[],processing}){
 const settled=await Promise.allSettled([...(source?[source]:[]),...physical,...(processing?[processing]:[])]);
 return settled.flatMap(row=>row.status==='fulfilled'&&Array.isArray(row.value)?row.value:[row]).filter(row=>row.status==='rejected').map(row=>errorEvidence(row.reason));
}
