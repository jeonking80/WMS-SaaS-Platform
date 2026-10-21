import {AsyncLocalStorage} from 'node:async_hooks';

// Test-copy diagnosis only. The ordinary application and public API stay unchanged.
const labels=[
 'request.handler','http.json_response','http.body_parse','request.telemetry',
 'db.pool_acquire','db.connection_held','db.begin','db.context','db.operation','db.commit','db.rollback',
 'telemetry.pool_acquire','telemetry.connection_held','telemetry.begin','telemetry.context','telemetry.insert','telemetry.commit','telemetry.rollback',
 'workflow.request_lock','workflow.request_hash','workflow.warehouse_lock','workflow.state_initialize','workflow.state_lock_read','workflow.state_clone','workflow.state_compare_baseline','workflow.references','workflow.scans','workflow.stock_read','workflow.snapshot_sql',
 'workflow.engine','workflow.reconcile','workflow.persist_json','workflow.persist_sql','workflow.snapshot','workflow.snapshot_clone',
 'workflow.snapshot_reconcile','workflow.persisted_reconcile','workflow.aggregate_match','workflow.actor_names','workflow.legacy_hydrate','integration.batch','integration.event',
 'integration.source_authorization','integration.resolve','integration.queue_sql','integration.entity_sql','integration.entity_lock','integration.status_sql',
] as const;
export type TimingLabel=typeof labels[number];
const safeLabels=new Set<string>(labels);
const operations=new Set(['v2.workflow.read','v2.workflow.command','v2.integration.process','v2.integration.events','v2.integration.accept','v2.integration.retry']);
const countLabels=new Set(['http.status','http.error_responses','state.stock_rows','state.orders','state.receipts','state.returns','state.reservations','state.picks','state.tasks','state.packages','state.shipments','sql.rows','integration.events','integration.applied','integration.business_rejected','integration.dependency_wait','integration.retry_wait','integration.quarantined']);
const byteLabels=new Set(['workflow.state_json','workflow.state_parse_json','http.response_body']);
type Span={count:number;failed_count:number;inclusive_ms:number;max_ms:number};
type PoolCount={samples:number;max_total:number;max_idle:number;max_waiting:number};
type Collected={operation:string;started:number;spans:Map<TimingLabel,Span>;counts:Map<string,{samples:number;total:number;max:number}>;bytes:Map<string,{samples:number;total:number;max:number}>;pools:Map<string,PoolCount>;timer_calls:number;bookkeeping_ms:number};
const diagnostics=new AsyncLocalStorage<Collected>();
const noop=()=>{};
export function timingDiagnosticsEnabled():boolean{return process.env.WMS_TIMING_DIAGNOSTICS==='1'&&process.env.WMS_ENVIRONMENT==='test';}

/** Never accepts error details, SQL, identifiers, request/response bodies or headers. */
export function beginTiming(label:TimingLabel):(failed?:boolean)=>void {
 const collector=diagnostics.getStore();if(!collector||!safeLabels.has(label))return noop;
 const started=performance.now();collector.timer_calls++;let ended=false;
 return(failed=false)=>{if(ended)return;ended=true;const endedAt=performance.now(),elapsed=endedAt-started;
  const current=collector.spans.get(label)??{count:0,failed_count:0,inclusive_ms:0,max_ms:0};current.count++;current.failed_count+=failed?1:0;current.inclusive_ms+=elapsed;current.max_ms=Math.max(current.max_ms,elapsed);collector.spans.set(label,current);collector.bookkeeping_ms+=performance.now()-endedAt;
 };
}
export function timeSync<T>(label:TimingLabel,operation:()=>T):T {if(!diagnostics.getStore())return operation();const end=beginTiming(label);try{const result=operation();end();return result;}catch(error){end(true);throw error;}}
export function timeAsync<T>(label:TimingLabel,operation:()=>Promise<T>):Promise<T> {if(!diagnostics.getStore())return operation();const end=beginTiming(label);try{return operation().then(result=>{end();return result;},error=>{end(true);throw error;});}catch(error){end(true);throw error;}}
function observeValues(kind:'counts'|'bytes',label:string,value:number){const collector=diagnostics.getStore();if(!collector||!(kind==='counts'?countLabels:byteLabels).has(label)||!Number.isSafeInteger(value)||value<0)return;const started=performance.now(),entry=collector[kind].get(label)??{samples:0,total:0,max:0};entry.samples++;entry.total+=value;entry.max=Math.max(entry.max,value);collector[kind].set(label,entry);collector.bookkeeping_ms+=performance.now()-started;}
export function observeTimingCount(label:string,value:number):void{observeValues('counts',label,value);}
/** Size must come from an existing string/buffer, never a second serialization. */
export function observeTimingBytes(label:string,value:number):void{observeValues('bytes',label,value);}
export function observeTimingPool(kind:'business'|'telemetry',pool:{totalCount:number;idleCount:number;waitingCount:number}):void {
 const collector=diagnostics.getStore();if(!collector||!['business','telemetry'].includes(kind))return;const started=performance.now(),entry=collector.pools.get(kind)??{samples:0,max_total:0,max_idle:0,max_waiting:0};entry.samples++;entry.max_total=Math.max(entry.max_total,pool.totalCount);entry.max_idle=Math.max(entry.max_idle,pool.idleCount);entry.max_waiting=Math.max(entry.max_waiting,pool.waitingCount);collector.pools.set(kind,entry);collector.bookkeeping_ms+=performance.now()-started;
}
export function timingDiagnosticsActive():boolean{return!!diagnostics.getStore();}
export function withTimingDiagnostics<T>(operation:string,handler:()=>Promise<T>):Promise<T>{
 if(!timingDiagnosticsEnabled())return handler();
 const collector:Collected={operation:operations.has(operation)?operation:'other',started:performance.now(),spans:new Map(),counts:new Map(),bytes:new Map(),pools:new Map(),timer_calls:0,bookkeeping_ms:0};
 return diagnostics.run(collector,async()=>{let failed=false;try{return await handler();}catch(error){failed=true;throw error;}finally{
  // Diagnostic output failure cannot alter the business response/error.
  try{const finalizeStarted=performance.now(),record={event:'wms_timing_diagnostic',schema_version:1,operation:collector.operation,request_failed_count:failed?1:0,request_elapsed_ms:performance.now()-collector.started,spans:Object.fromEntries(collector.spans),counts:Object.fromEntries(collector.counts),bytes:Object.fromEntries(collector.bytes),pool_counts:Object.fromEntries(collector.pools),overhead:{timer_calls:collector.timer_calls,bookkeeping_ms:collector.bookkeeping_ms,collector_finalize_ms:0,logging_overhead_measured:false,extra_db_queries:0,extra_business_payload_serializations:0},interpretation:'Span times are inclusive and may overlap; do not sum nested spans. Request time ends before diagnostic output and HTTP body transport. Instrumentation overhead is not subtracted.'};record.overhead.collector_finalize_ms=performance.now()-finalizeStarted;console.info(JSON.stringify(record));}catch{/* Preserve the original business outcome. */}
 }});
}
