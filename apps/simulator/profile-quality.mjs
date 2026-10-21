// Pure next-report evidence. Existing whole-window measurements remain separate.
// All times are epoch milliseconds; event ownership uses its planned offset.
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const expectedStatuses=new Set(['business_rejected','dependency_wait','awaiting_approval']);
export function percentile95(values){const sorted=values.filter(value=>finite(value)&&value>=0).sort((a,b)=>a-b);return sorted.length?sorted[Math.ceil(sorted.length*.95)-1]:null;}
export function profileWindows(kind,duration_ms){
 if(!finite(duration_ms)||duration_ms<=0)throw Error('INVALID_PROFILE_DURATION');
 return kind==='congestion'?[{name:'normal_before_peak',start_ms:0,end_ms:600000,normal:true},{name:'peak',start_ms:600000,end_ms:900000,normal:false},{name:'normal_after_peak',start_ms:900000,end_ms:1500000,normal:true}]:[{name:'normal_shift',start_ms:0,end_ms:duration_ms,normal:true}];
}
export function profileWindow(kind,offset_ms,duration_ms){return profileWindows(kind,duration_ms).find(window=>finite(offset_ms)&&offset_ms>=window.start_ms&&offset_ms<window.end_ms)?.name??null;}
function validateEvents(events){const ids=new Set();for(const event of events){if(typeof event.id!=='string'||!event.id||ids.has(event.id)||!finite(event.scheduled_offset_ms)||event.scheduled_offset_ms<0)throw Error('INVALID_OR_DUPLICATE_QUALITY_EVENT');ids.add(event.id);}}
function allowed(event,expected_outcomes){return expected_outcomes.find(rule=>rule.event_id===event.id&&rule.status===event.status&&rule.reason===event.reason&&expectedStatuses.has(rule.status)&&typeof rule.reason==='string'&&rule.reason.length&&typeof rule.owner==='string'&&rule.owner.length&&typeof rule.follow_up==='string'&&rule.follow_up.length);}
function terminalTime(event,expected_outcomes){
 if(event.status!=='applied'&&!allowed(event,expected_outcomes))return null;
 // Server processing time is authoritative; first observation is a conservative fallback.
 return finite(event.processed_at_ms)?event.processed_at_ms:finite(event.completion_observed_at_ms)?event.completion_observed_at_ms:null;
}
function latency(values,maximum_ms){const valid=values.filter(value=>finite(value)&&value>=0),p95_ms=percentile95(valid);return {p95_ms,maximum_ms,samples:valid.length,met:p95_ms!==null&&p95_ms<=maximum_ms};}
function unique(values){return [...new Set(values)];}

/** Freeze once, at the peak boundary. Future normal input must never extend it.
 * A = received server backlog; B = planned pre-boundary events not yet received.
 * Invalid/missing timestamps remain visible as backlog, never assumed completed.
 */
export function freezePeakBacklog({kind='congestion',start_ms,events,observed_at_ms,expected_outcomes=[]}){
 validateEvents(events);if(kind!=='congestion')return {applicable:false,reason:'NO_CONGESTION_PEAK'};
 const peak_end_ms=start_ms+900000;if(!finite(start_ms)||!finite(observed_at_ms)||observed_at_ms<peak_end_ms)throw Error('PEAK_BOUNDARY_NOT_OBSERVED');
 const received_ids=[],source_ids=[],excluded=[],completed_before_peak_ids=[];
 for(const event of events.filter(row=>row.scheduled_offset_ms<900000)){
  const permitted=allowed(event,expected_outcomes),completed=terminalTime(event,expected_outcomes);
  if(finite(completed)&&completed<=peak_end_ms){completed_before_peak_ids.push(event.id);continue;}
  if(permitted&&event.status!=='business_rejected'){excluded.push({id:event.id,status:event.status,reason:event.reason,owner:permitted.owner,follow_up:permitted.follow_up});continue;}
  (finite(event.accepted_at_ms)&&event.accepted_at_ms<=peak_end_ms?received_ids:source_ids).push(event.id);
 }
 return {applicable:true,peak_end_ms,deadline_ms:peak_end_ms+600000,frozen_at_ms:observed_at_ms,planned_pre_peak_ids:events.filter(event=>event.scheduled_offset_ms<900000).map(event=>event.id),received_ids,source_ids,excluded,completed_before_peak_ids,definition:'Unique planned pre-peak-end event IDs; A received but unfinished, B not received by peak end. Post-peak events do not enlarge either cohort.'};
}

/** Evaluate the same immutable IDs using later evidence, including missing rows. */
export function judgePeakRecovery(cohort,events,{observed_at_ms,expected_outcomes=[]}={}){
 if(!cohort?.applicable)return {applicable:false,met:null,reason:'NO_CONGESTION_PEAK'};
 validateEvents(events);const byId=new Map(events.map(event=>[event.id,event]));
 if(!finite(observed_at_ms)||!finite(cohort.peak_end_ms)||cohort.deadline_ms!==cohort.peak_end_ms+600000||!Array.isArray(cohort.received_ids)||!Array.isArray(cohort.source_ids)||unique([...cohort.received_ids,...cohort.source_ids]).length!==cohort.received_ids.length+cohort.source_ids.length)throw Error('INVALID_RECOVERY_OBSERVATION');
 const groups={};
 for(const [name,ids]of [['received_backlog',cohort.received_ids],['source_backlog',cohort.source_ids]]){
  if(!Array.isArray(ids)||unique(ids).length!==ids.length)throw Error('INVALID_RECOVERY_COHORT');
  const unresolved=[],completed=[],late=[];
  for(const id of ids){const event=byId.get(id),at=event?terminalTime(event,expected_outcomes):null;
   if(!finite(at)||at>observed_at_ms)unresolved.push({id,status:event?.status??'missing',reason:event?.reason??null});
   else {completed.push({id,completed_at_ms:at,basis:finite(event.processed_at_ms)?'server_processed_at':'first_completion_observation'});if(at>cohort.deadline_ms)late.push(id);}
  }
  const recovered_at_ms=unresolved.length?null:Math.max(cohort.peak_end_ms,...completed.map(row=>row.completed_at_ms));
  groups[name]={ids:[...ids],count:ids.length,empty:ids.length===0,completed,unresolved,late_ids:late,recovered_at_ms,recovery_ms:recovered_at_ms===null?null:recovered_at_ms-cohort.peak_end_ms,met:unresolved.length===0&&late.length===0};
 }
 const post_peak_outstanding=events.filter(event=>event.scheduled_offset_ms>=900000&&startDue(event,cohort.peak_end_ms-900000,observed_at_ms)&&!finite(terminalTime(event,expected_outcomes))).map(event=>({id:event.id,status:event.status,reason:event.reason??null}));
 const invalidated_exclusions=(cohort.excluded??[]).filter(row=>{const event=byId.get(row.id);return !event||!allowed(event,expected_outcomes)&&!(event.status==='applied'&&finite(terminalTime(event,expected_outcomes)));}).map(row=>({id:row.id,status:byId.get(row.id)?.status??'missing'}));
 const planned=new Set(cohort.planned_pre_peak_ids??[]),covered=[...cohort.received_ids,...cohort.source_ids,...(cohort.excluded??[]).map(row=>row.id),...(cohort.completed_before_peak_ids??[])],coveredSet=new Set(covered),finalPrePeak=events.filter(event=>event.scheduled_offset_ms<900000).map(event=>event.id);
 const cohort_regressions={missing_final_ids:[...planned].filter(id=>!byId.has(id)),unexpected_pre_peak_ids:finalPrePeak.filter(id=>!planned.has(id)),uncovered_ids:[...planned].filter(id=>!coveredSet.has(id)),duplicate_coverage:covered.length!==coveredSet.size,coverage_changed:covered.some(id=>!planned.has(id))};
 const coherent=!cohort_regressions.missing_final_ids.length&&!cohort_regressions.unexpected_pre_peak_ids.length&&!cohort_regressions.uncovered_ids.length&&!cohort_regressions.duplicate_coverage&&!cohort_regressions.coverage_changed;
 return {applicable:true,peak_end_ms:cohort.peak_end_ms,deadline_ms:cohort.deadline_ms,frozen_at_ms:cohort.frozen_at_ms,observed_at_ms,...groups,excluded:cohort.excluded??[],invalidated_exclusions,cohort_regressions,post_peak_outstanding,met:coherent&&groups.received_backlog.met&&groups.source_backlog.met&&invalidated_exclusions.length===0,not_yet_observed_through_deadline:observed_at_ms<cohort.deadline_ms};
}
function startDue(event,start_ms,at){return start_ms+event.scheduled_offset_ms<=at;}

/** Normal external calls follow planned event windows. Physical/API attempts use
 * actual request start. HTTP-success p95 is unchanged; retry lead time is extra.
 * Caller supplies one company's complete planned measured events, no seed rows.
 */
export function evaluateProfileQuality({kind,start_ms,duration_ms,observed_at_ms,events,calls=[],peak_cohort,expected_outcomes=[]}){
 validateEvents(events);if(!finite(start_ms)||!finite(observed_at_ms))throw Error('INVALID_QUALITY_CLOCK');
 const windows=profileWindows(kind,duration_ms),normalNames=new Set(windows.filter(window=>window.normal).map(window=>window.name));
 const windowOfEvent=event=>profileWindow(kind,event.scheduled_offset_ms,duration_ms),windowOfCall=call=>profileWindow(kind,call.started_at_ms-start_ms,duration_ms);
 function measure(name,selectedEvents,selectedCalls){
  const expected=selectedEvents.filter(event=>allowed(event,expected_outcomes)),automatic=selectedEvents.filter(event=>!allowed(event,expected_outcomes));
  const accepted=selectedEvents.filter(event=>finite(event.accepted_at_ms)),applied=automatic.filter(event=>event.status==='applied'&&finite(event.processed_at_ms)&&finite(event.accepted_at_ms)&&event.processed_at_ms>=event.accepted_at_ms);
  const acceptance=latency(accepted.map(event=>event.acceptance_latency_ms),1000),application=latency(applied.map(event=>event.processed_at_ms-event.accepted_at_ms),5000);
  const appliedIds=new Set(applied.map(event=>event.id)),unresolved=automatic.filter(event=>!appliedIds.has(event.id)).map(event=>({id:event.id,status:event.status,reason:event.reason??null}));
  const technical=selectedCalls.filter(call=>call.status===0||call.status>=500),business=selectedCalls.filter(call=>call.status>=400&&call.status<500),rate=selectedCalls.length?technical.length/selectedCalls.length:null;
  const physical=latency(selectedCalls.filter(call=>call.path==='/api/v2/workflow'&&call.method==='POST'&&call.status===200).map(call=>call.latency_ms),1500);
  return {name,planned_events:selectedEvents.length,accepted_events:accepted.length,automatic_events:automatic.length,applied_automatic_events:applied.length,expected_outcomes:expected.map(event=>({id:event.id,status:event.status,reason:event.reason,owner:allowed(event,expected_outcomes).owner,follow_up:allowed(event,expected_outcomes).follow_up})),external_acceptance:acceptance,external_application:application,physical_confirmation:physical,retry_inclusive_lead_time:{...latency(accepted.map(event=>finite(event.first_sent_at_ms)?event.accepted_at_ms-event.first_sent_at_ms:null),1000),qualification:false,reason:'Additional first-send-to-receipt evidence; does not replace successful-HTTP acceptance p95.'},technical_failures:{numerator:technical.length,denominator:selectedCalls.length,rate,strict_maximum:.001,met:rate!==null&&rate<.001},business_rejection_http_attempts:business.length,missing_acceptance_latency_ids:accepted.filter(event=>!finite(event.acceptance_latency_ms)).map(event=>event.id),unresolved,met:selectedEvents.length>0&&accepted.length===selectedEvents.length&&acceptance.samples===accepted.length&&acceptance.met&&application.samples===automatic.length&&application.met&&unresolved.length===0&&rate!==null&&rate<.001};
 }
 const measuredWindows=windows.map(window=>({...window,...measure(window.name,events.filter(event=>windowOfEvent(event)===window.name),calls.filter(call=>windowOfCall(call)===window.name))}));
 const normal=measure('normal_combined',events.filter(event=>normalNames.has(windowOfEvent(event))),calls.filter(call=>normalNames.has(windowOfCall(call))));
 const recovery=kind==='congestion'?(peak_cohort?judgePeakRecovery(peak_cohort,events,{observed_at_ms,expected_outcomes}):{applicable:true,met:false,reason:'PEAK_COHORT_NOT_CAPTURED'}):{applicable:false,met:null,reason:'NO_CONGESTION_PEAK'};
 const physicalQualification=kind==='shift',physical={...normal.physical_confirmation,qualification:physicalQualification,reason:physicalQualification?'Normal eight-hour shift HTTP confirmation.':'Congestion physical latency is evidence; the 1.5s requirement belongs to the normal shift profile.'};
 const unexpected_outcomes=events.filter(event=>!allowed(event,expected_outcomes)&&!(event.status==='applied'&&finite(event.processed_at_ms)&&finite(event.accepted_at_ms)&&event.processed_at_ms>=event.accepted_at_ms)).map(event=>({id:event.id,status:event.status,reason:event.reason??null}));
 return {profile:kind,qualification:kind==='congestion'||kind==='shift',start_ms,duration_ms,observed_at_ms,window_basis:{external:'Planned event offset, including events transmitted late.',physical_and_api_attempts:'Actual request start.',latency:'Successful HTTP request start through complete response body and JSON decoding.',recovery:'Frozen pre-peak-end identities; deadline is peak end plus 600000ms.'},windows:measuredWindows,normal,physical_confirmation:physical,recovery,unexpected_outcomes,met:normal.met&&measuredWindows.filter(window=>window.normal).every(window=>window.met)&&unexpected_outcomes.length===0&&(!physicalQualification||physical.met)&&(!recovery.applicable||recovery.met)};
}
