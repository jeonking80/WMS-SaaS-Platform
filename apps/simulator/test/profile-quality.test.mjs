import test from 'node:test';
import assert from 'node:assert/strict';
import {profileWindow,freezePeakBacklog,judgePeakRecovery,evaluateProfileQuality} from '../profile-quality.mjs';

const start=10000000,peakEnd=start+900000,deadline=peakEnd+600000;
const event=(id,offset,extra={})=>({id,scheduled_offset_ms:offset,first_sent_at_ms:start+offset,accepted_at_ms:start+offset+100,acceptance_latency_ms:100,processed_at_ms:start+offset+300,completion_observed_at_ms:start+offset+350,status:'applied',...extra});
const call=(offset,extra={})=>({started_at_ms:start+offset,completed_at_ms:start+offset+100,status:200,path:'/api/v2/workflow',method:'POST',latency_ms:100,...extra});
const evidence=(events,calls=[call(100),call(900100)],extra={})=>evaluateProfileQuality({kind:'congestion',start_ms:start,duration_ms:1500000,observed_at_ms:deadline,events,calls,peak_cohort:freezePeakBacklog({start_ms:start,events,observed_at_ms:peakEnd}),...extra});

test('external normal windows follow planned offset and slow peak does not change normal p95',()=>{
 const events=[event('before',599999,{accepted_at_ms:start+600100}),event('peak',899999,{first_sent_at_ms:start+900500,accepted_at_ms:start+908500,acceptance_latency_ms:8000,processed_at_ms:start+916500}),event('after',900000)];
 const result=evidence(events);
 assert.equal(profileWindow('congestion',599999,1500000),'normal_before_peak');
 assert.equal(profileWindow('congestion',600000,1500000),'peak');
 assert.equal(profileWindow('congestion',900000,1500000),'normal_after_peak');
 assert.equal(profileWindow('congestion',1500000,1500000),null);
 assert.equal(result.windows[0].accepted_events,1);assert.equal(result.windows[1].external_acceptance.p95_ms,8000);
 assert.equal(result.normal.external_acceptance.p95_ms,100);assert.equal(result.normal.met,true);
 assert.equal(result.met,true);
});

test('physical attempts use actual request start, independent of planned event ownership',()=>{
 const result=evidence([event('a',100),event('b',900100)],[call(599999,{latency_ms:1700}),call(600000,{latency_ms:9000}),call(900000)]);
 assert.equal(result.windows[0].physical_confirmation.p95_ms,1700);assert.equal(result.windows[1].physical_confirmation.p95_ms,9000);
 assert.equal(result.physical_confirmation.qualification,false);
 assert.equal(result.met,true); // The 1.5s criterion is for shift; congestion evidence remains visible.
});

test('peak cohort freezes received and source backlog and applies exact 10-minute boundary',()=>{
 const atPeak=[event('received',700000,{status:'accepted',processed_at_ms:undefined,completion_observed_at_ms:undefined}),event('source',800000,{status:'unsent',accepted_at_ms:undefined,processed_at_ms:undefined,completion_observed_at_ms:undefined}),event('new-after',1000000)];
 const cohort=freezePeakBacklog({start_ms:start,events:atPeak,observed_at_ms:peakEnd});
 assert.deepEqual(cohort.received_ids,['received']);assert.deepEqual(cohort.source_ids,['source']);assert.equal(cohort.deadline_ms,deadline);
 const final=[event('received',700000,{processed_at_ms:deadline-1}),event('source',800000,{processed_at_ms:deadline}),event('new-after',1000000,{processed_at_ms:deadline+10000})];
 const onTime=judgePeakRecovery(cohort,final,{observed_at_ms:deadline+20000});
 assert.equal(onTime.met,true);assert.equal(onTime.received_backlog.recovery_ms,599999);assert.equal(onTime.source_backlog.recovery_ms,600000);
 final[1].processed_at_ms=deadline+1;
 const late=judgePeakRecovery(cohort,final,{observed_at_ms:deadline+20000});assert.equal(late.met,false);assert.deepEqual(late.source_backlog.late_ids,['source']);
 assert.deepEqual(cohort.received_ids,['received']); // Later observations never mutate the fixed cohort.
});

test('empty backlog is zero but missing cohort, missing result, and quarantine cannot pass',()=>{
 const events=[event('a',100),event('b',900100)],empty=freezePeakBacklog({start_ms:start,events,observed_at_ms:peakEnd});
 const cleared=judgePeakRecovery(empty,events,{observed_at_ms:deadline});assert.equal(cleared.received_backlog.recovery_ms,0);assert.equal(cleared.received_backlog.empty,true);
 assert.equal(evidence(events,undefined,{peak_cohort:undefined}).recovery.met,false);
 const pending=freezePeakBacklog({start_ms:start,events:[event('lost',500000,{status:'accepted',processed_at_ms:undefined,completion_observed_at_ms:undefined})],observed_at_ms:peakEnd});
 assert.equal(judgePeakRecovery(pending,[],{observed_at_ms:deadline}).met,false);
 const bad=event('lost',500000,{status:'quarantined',reason:'SERVER_ERROR',processed_at_ms:peakEnd+10});
 assert.equal(judgePeakRecovery(pending,[bad],{observed_at_ms:deadline,expected_outcomes:[{event_id:'lost',status:'quarantined',reason:'SERVER_ERROR',owner:'ops',follow_up:'retry'}]}).met,false);
 assert.throws(()=>freezePeakBacklog({start_ms:start,events,observed_at_ms:peakEnd-1}),/PEAK_BOUNDARY_NOT_OBSERVED/);
});

test('later normal input never extends the frozen pre-peak recovery interval',()=>{
 const pending=event('old',800000,{status:'accepted',processed_at_ms:undefined,completion_observed_at_ms:undefined});
 const cohort=freezePeakBacklog({start_ms:start,events:[pending,event('later',1200000)],observed_at_ms:peakEnd});
 const result=judgePeakRecovery(cohort,[event('old',800000,{processed_at_ms:peakEnd+120000}),event('later',1200000,{processed_at_ms:peakEnd+480000})],{observed_at_ms:deadline});
 assert.equal(result.received_backlog.recovery_ms,120000);assert.deepEqual(result.received_backlog.ids,['old']);assert.equal(result.met,true);
});

test('only exact predeclared expected waits are excluded, with owner and follow-up',()=>{
 const waiting=event('approval',800000,{status:'awaiting_approval',reason:'APPROVAL_REQUIRED',processed_at_ms:undefined,completion_observed_at_ms:undefined}),rule={event_id:'approval',status:'awaiting_approval',reason:'APPROVAL_REQUIRED',owner:'supervisor',follow_up:'review /approvals/approval'};
 const permitted=freezePeakBacklog({start_ms:start,events:[waiting],observed_at_ms:peakEnd,expected_outcomes:[rule]});assert.equal(permitted.excluded.length,1);assert.equal(permitted.received_ids.length,0);
 const notPermitted=freezePeakBacklog({start_ms:start,events:[waiting],observed_at_ms:peakEnd,expected_outcomes:[{...rule,follow_up:''}]});assert.deepEqual(notPermitted.received_ids,['approval']);
 const laterQuarantine=judgePeakRecovery(permitted,[{...waiting,status:'quarantined',reason:'TECHNICAL_ERROR'}],{observed_at_ms:deadline,expected_outcomes:[rule]});assert.equal(laterQuarantine.met,false);assert.deepEqual(laterQuarantine.invalidated_exclusions,[{id:'approval',status:'quarantined'}]);
});

test('fast HTTP rejection cannot lower acceptance p95 and missing latency cannot disappear',()=>{
 const slow=event('slow',100,{acceptance_latency_ms:1001}),events=[slow,event('after',900100)];
 const result=evidence(events,[call(100,{path:'/api/v2/integration/events',status:400,latency_ms:1}),call(900100)]);
 assert.equal(result.normal.external_acceptance.p95_ms,1001);assert.equal(result.normal.business_rejection_http_attempts,1);assert.equal(result.met,false);
 slow.acceptance_latency_ms=undefined;const missing=evidence(events);assert.deepEqual(missing.normal.missing_acceptance_latency_ids,['slow']);assert.equal(missing.met,false);
});

test('retry-inclusive lead time is explicit extra evidence and does not replace HTTP p95',()=>{
 const result=evidence([event('retry',100,{first_sent_at_ms:start-1000,accepted_at_ms:start+200,acceptance_latency_ms:900}),event('after',900100)]);
 assert.equal(result.normal.external_acceptance.p95_ms,900);assert.equal(result.normal.retry_inclusive_lead_time.p95_ms,1200);assert.equal(result.normal.retry_inclusive_lead_time.qualification,false);assert.equal(result.met,true);
});

test('company and post-peak degradation cannot hide inside a combined p95',()=>{
 const good=evidence([event('a',100),event('b',900100)]),bad=evidence([event('a',100),event('b',900100,{acceptance_latency_ms:1001})]);
 assert.equal(good.met,true);assert.equal(bad.met,false);assert.equal(bad.windows.find(row=>row.name==='normal_after_peak').external_acceptance.met,false);
 const many=Array.from({length:100},(_,i)=>event('pre'+i,i*1000));const masked=evidence([...many,event('post',900100,{acceptance_latency_ms:1001})]);
 assert.equal(masked.normal.external_acceptance.met,true);assert.equal(masked.met,false);
});

test('normal technical failure denominator includes failed attempts with strict threshold',()=>{
 const events=[event('a',100),event('b',900100)],calls=Array.from({length:1000},(_,i)=>call(i?900100:100,{status:i===999?503:200}));
 const result=evidence(events,calls);assert.equal(result.normal.technical_failures.rate,.001);assert.equal(result.normal.technical_failures.met,false);assert.equal(result.met,false);
});

test('shift has one complete normal window and no fabricated congestion recovery',()=>{
 const events=[event('shift',100)],result=evaluateProfileQuality({kind:'shift',start_ms:start,duration_ms:28800000,observed_at_ms:start+28800000,events,calls:[call(100,{latency_ms:1500})]});
 assert.equal(result.windows.length,1);assert.equal(result.physical_confirmation.qualification,true);assert.equal(result.physical_confirmation.met,true);assert.equal(result.recovery.applicable,false);assert.equal(result.recovery.met,null);assert.equal(result.met,true);
 assert.equal(evaluateProfileQuality({kind:'shift',start_ms:start,duration_ms:28800000,observed_at_ms:start+28800000,events,calls:[call(100,{latency_ms:1501})]}).met,false);
});

test('invalid duplicate events and altered recovery deadlines are rejected',()=>{
 assert.throws(()=>freezePeakBacklog({start_ms:start,observed_at_ms:peakEnd,events:[event('same',1),event('same',2)]}),/DUPLICATE/);
 const cohort=freezePeakBacklog({start_ms:start,events:[],observed_at_ms:peakEnd});
 assert.throws(()=>judgePeakRecovery({...cohort,deadline_ms:deadline+600000},[],{observed_at_ms:deadline}),/INVALID_RECOVERY/);
 const other=judgePeakRecovery(cohort,[event('unrelated-company-event',100)],{observed_at_ms:deadline});assert.equal(other.met,false);assert.deepEqual(other.cohort_regressions.unexpected_pre_peak_ids,['unrelated-company-event']);
});
