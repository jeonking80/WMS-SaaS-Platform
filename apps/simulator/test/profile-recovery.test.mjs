import {test} from 'node:test';
import assert from 'node:assert/strict';
import {controlAttempt,boundedRead,recoveryDeadline,CONTROL_ATTEMPT_LIMIT} from '../profile-recovery.mjs';
const failed=(status,code='SERVICE_UNAVAILABLE',retryAfter=0)=>Object.assign(new Error(code),{status,retryAfter});

test('transient control failures retain the next retry time and do not invoke a stale work callback',async()=>{
 let clock=1000,reads=0,work=0;
 const operation=async()=>{reads++;if(reads===1)throw failed(503);work++;return {version:2};};
 let result=await controlAttempt({operation,now:()=>clock,random:()=>0});assert.equal(result.status,'retrying');assert.equal(work,0);assert.equal(result.state.total_failures,1);
 result=await controlAttempt({state:result.state,operation,now:()=>clock,random:()=>0});assert.equal(result.status,'waiting');assert.equal(reads,1);
 clock=result.state.next_at;result=await controlAttempt({state:result.state,operation,now:()=>clock});assert.equal(result.status,'ready');assert.equal(work,1);assert.equal(result.value.version,2);assert.equal(result.state.total_failures,1);assert.equal(result.state.attempts,0);
});

test('429 honors Retry-After, permanent 403 is not retried, and exhausted state is preserved across resume',async()=>{
 const retry=await controlAttempt({operation:async()=>{throw failed(429,'RATE_LIMITED',120);},now:()=>1000,random:()=>0});assert.equal(retry.state.next_at,121000);
 let calls=0,state={};for(let i=0;i<CONTROL_ATTEMPT_LIMIT;i++){const result=await controlAttempt({state,operation:async()=>{calls++;throw failed(503);},now:()=>state.next_at??0,random:()=>0});state=result.state;}
 assert.equal(state.status,'exhausted');assert.equal(calls,CONTROL_ATTEMPT_LIMIT);
 const resumed=await controlAttempt({state:JSON.parse(JSON.stringify(state)),operation:async()=>{calls++;},now:()=>1e9});assert.equal(resumed.status,'failed');assert.equal(calls,CONTROL_ATTEMPT_LIMIT);
 const permanent=await controlAttempt({operation:async()=>{throw failed(403,'WAREHOUSE_FORBIDDEN');}});assert.equal(permanent.status,'failed');assert.equal(permanent.state.status,'permanent_failure');
});

test('final snapshot/ledger reads retry a 503 with the same request and retain each failed attempt for accounting',async()=>{
 let clock=1000,attempts=0;const retries=[],paths=[];
 const result=await boundedRead(async({remaining_ms})=>{paths.push('/ledger?boundary=7&cursor=original');assert(remaining_ms>0);if(++attempts===1)throw failed(503);return {boundary:7};},{now:()=>clock,wait:async ms=>{clock+=ms;},random:()=>0,onRetry:row=>retries.push(row)});
 assert.equal(result.boundary,7);assert.equal(attempts,2);assert.equal(retries.length,1);assert.equal(retries[0].last_failure.status,503);assert.equal(new Set(paths).size,1);
});

test('persistent final read failure and a retry exceeding the budget fail explicitly with bounded attempts',async()=>{
 let clock=1000,calls=0;
 await assert.rejects(boundedRead(async()=>{calls++;throw failed(503);},{now:()=>clock,wait:async ms=>{clock+=ms;},random:()=>0}),error=>error.code==='FINAL_READ_RETRY_EXHAUSTED'&&error.attempts===3&&error.last_failure.status===503);assert.equal(calls,3);
 calls=0;await assert.rejects(boundedRead(async()=>{calls++;throw failed(429,'RATE_LIMITED',120);},{now:()=>clock,budgetMs:60000}),/FINAL_READ_RETRY_EXHAUSTED/);assert.equal(calls,1);
 calls=0;await assert.rejects(boundedRead(async()=>{calls++;throw failed(403,'WAREHOUSE_FORBIDDEN');}),/FINAL_READ_PERMANENT_FAILURE/);assert.equal(calls,1);
 assert.equal(recoveryDeadline(1000,1500000),2101000);assert.equal(recoveryDeadline(undefined,1500000),null);
});

test('seed-stage permanent and exhausted failures serialize failed unverified evidence without inventing a measured start',async()=>{
 const {unverifiedCompanyReport}=await import('../profile-recovery.mjs');
 const run={config:{duration_ms:1500000,unique_measured:2700},context:{seed_start:1000}},calls=[{at:new Date(1100).toISOString(),details:{status:503,method:'GET',path:'/api/v2/workflow',latency_ms:100}}];
 for(const error of [failed(403,'WAREHOUSE_FORBIDDEN'),Object.assign(failed(503),{code:'FINAL_READ_RETRY_EXHAUSTED',attempts:3})]){
  const report=unverifiedCompanyReport({run,operations:[],calls,company_id:'company',kind:'congestion',stage:'preparation',error,now_ms:2000});
  assert.equal(report.verdict,'failed');assert.equal(report.integrity_passed,false);assert.equal(report.final_reconciliation.status,'unverified');assert.equal(report.final_reconciliation.http_status,error.status);assert.equal(report.measurement.status,'not_started');assert.equal(report.measurement.started_at_ms,null);assert.equal(report.measurement.elapsed_ms,null);assert.equal(report.quality_targets.qualification,false);assert.equal(report.technical_error_count,1);assert.equal(report.api_calls,1);assert.equal(JSON.parse(JSON.stringify(report)).measurement.status,'not_started');
 }
});

test('unverified final reports preserve failed-read technical numerator and all observed HTTP attempts in the normal denominator',async()=>{
 const {unverifiedCompanyReport}=await import('../profile-recovery.mjs');
 const run={config:{duration_ms:1500000,unique_measured:0},context:{measured_start:1000}},calls=[503,429,403,200].map(status=>({at:new Date(1100).toISOString(),details:{status,started_at_ms:1050,completed_at_ms:1100,latency_ms:50,path:'/api/v2/workflow',method:'GET'}}));
 const report=unverifiedCompanyReport({run,operations:[],calls,company_id:'company',kind:'congestion',stage:'final_reconciliation',error:failed(503),now_ms:2000});
 assert.equal(report.normal_window_attempts.denominator,4);assert.equal(report.normal_window_attempts.technical_failures,1);assert.equal(report.normal_window_attempts.http_429,1);assert.equal(report.api_calls,4);assert.equal(report.technical_error_count,1);assert.equal(report.verdict,'failed');assert.equal(report.differences,null);
});

test('all physical/source/process callbacks settle before the journal may close, and rejected callbacks remain visible',async()=>{
 const {settleProfileTasks}=await import('../profile-recovery.mjs');let finishPhysical,finishSource,closed=false,physicalPersisted=false;
 const physical=new Promise(resolve=>{finishPhysical=()=>{assert.equal(closed,false);physicalPersisted=true;resolve();};});
 const source=new Promise(resolve=>{finishSource=()=>resolve([{status:'rejected',reason:failed(503,'NETWORK_UNAVAILABLE')}]);});
 let settled=false;const completing=settleProfileTasks({source,physical:[physical],processing:Promise.resolve()}).then(errors=>{closed=true;settled=true;return errors;});
 finishSource();await Promise.resolve();assert.equal(settled,false);finishPhysical();const errors=await completing;
 assert.equal(physicalPersisted,true);assert.equal(closed,true);assert.deepEqual(errors,[{status:503,code:'NETWORK_UNAVAILABLE'}]);
});

test('Retry-After supports HTTP seconds and HTTP dates without treating an expired or malformed date as extra delay',async()=>{
 const {retryAfterSeconds}=await import('../profile-recovery.mjs');
 assert.equal(retryAfterSeconds('120',1000),120);assert.equal(retryAfterSeconds('Thu, 01 Jan 1970 00:02:01 GMT',1000),120);assert.equal(retryAfterSeconds('Thu, 01 Jan 1970 00:00:00 GMT',1000),0);assert.equal(retryAfterSeconds('invalid',1000),0);
});
