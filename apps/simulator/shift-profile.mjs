// Strict eight-hour coordinator. The shared runtime talks only to WMS HTTP APIs;
// this module reads only the simulator's own SQLite journal and immutable HTTP evidence.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { openStore } from './store.mjs';
import { stableId } from './profile-plan.mjs';

export const SHIFT_DURATION_MS = 8 * 60 * 60 * 1000;
const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function requireValue(ok, code) { if (!ok) throw Object.assign(new Error(code), { code }); }
const sourceTypes = ['order.create', 'receipt.create'];

export function shiftPolicy(kind,target){
 if(!['shift','shift-smoke'].includes(kind))return null;
 const full=kind==='shift',duration=full?SHIFT_DURATION_MS:Number(target.smoke_duration_ms??15000);
 return {full,duration_ms:duration,reservation_warning_ms:full?2*60*60*1000:Math.floor(duration/4),handover_at_ms:full?4*60*60*1000:Math.floor(duration/2)};
}
export function shiftWorkerIndex(runtime,entity,snapshot=runtime.lastSnapshot){
 const task=[...(snapshot?.tasks??[])].reverse().find(task=>task.object_id===entity);
 if(task){const index=runtime.workerActorIds.indexOf(task.assignee_id);requireValue(index>=0,'SHIFT_ASSIGNEE_OUTSIDE_WORKERS');return index;}
 return Number.parseInt(hash(entity).slice(0,8),16)%runtime.workers.length;
}
export function shiftWorkAllowed(runtime,operation,store){
 const policy=runtime.shiftPolicy;if(!policy)return true;
 const shift=store.run(runtime.id).context.shift??{};
 return !(operation.input.command==='order.pick'&&operation.input.payload.order_id===shift.pinned_order_id&&!shift.handover_completed_at);
}
function controlOperation(runtime,store,stage,command,payload){
 const id=stableId(runtime.id+':control:'+stage),existing=store.operation(id);if(existing)return existing;
 const ordinal=Number(store.db.prepare('SELECT coalesce(max(ordinal),-1)+1 AS n FROM operations WHERE run_id=?').get(runtime.id).n);
 const input={warehouse_id:runtime.target.warehouse_id,request_id:id,command,payload};
 store.db.prepare('INSERT INTO operations(id,run_id,ordinal,kind,label,role,input) VALUES(?,?,?,?,?,?,?)').run(id,runtime.id,ordinal,'control',command,'supervisor',JSON.stringify(input));return store.operation(id);
}
async function executeControl(runtime,store,op){
 if(op.status==='done')return op.result;
 // A saved uncertain request is looked up before any retransmission or re-planning.
 if(op.status!=='unsent')try{const old=await runtime.api('supervisor','/api/v2/workflow?warehouse_id='+runtime.target.warehouse_id+'&request_id='+op.input.request_id);store.updateOp(op.id,{status:'done',result:{result:old.result},error:null});return {result:old.result};}catch(error){if(error.status!==404)throw error;}
 store.updateOp(op.id,{status:'unconfirmed'});
 try{const value=await runtime.api('supervisor','/api/v2/workflow',op.input);store.updateOp(op.id,{status:'done',result:{result:value.result},error:null});return {result:value.result};}catch(error){
  store.updateOp(op.id,{attempts:op.attempts+1,error:error.message});
  if(error.message==='HANDOVER_REQUIRED'){store.updateOp(op.id,{status:'superseded',error:null});return null;}
  throw error;
 }
}
export async function performShiftMilestones(runtime,snapshot,store,now=Date.now()){
 const policy=runtime.shiftPolicy,run=store.run(runtime.id);if(!policy||!run.context.measured_start)return {snapshot};
 let shift=run.context.shift??{};
 const save=patch=>{const current=store.run(runtime.id);shift={...(current.context.shift??{}),...patch};store.updateRun(runtime.id,{context:{...current.context,shift}});};
 if(!shift.pinned_order_id){
  const first=store.operations(runtime.id).find(op=>op.kind==='event'&&op.input.phase==='measured'&&op.input.event.event_type==='order.create'&&op.status==='done');
  const order=snapshot.orders.find(order=>order.id===first?.result?.result?.id);if(!order)return {snapshot};
  const owner=shiftWorkerIndex(runtime,order.id,snapshot);save({pinned_order_id:order.id,initial_worker_index:owner,initial_assignee:runtime.workerActorIds[owner]});
 }
 if(!shift.initial_assignment_completed_at){
  const op=controlOperation(runtime,store,'initial-assignment','task.assign',{object_type:'order',object_id:shift.pinned_order_id,assignee_id:shift.initial_assignee,reason:'T11 initial ownership before a deliberately held reservation'});
  await executeControl(runtime,store,op);save({initial_assignment_completed_at:now});store.observe(runtime.id,'shift_initial_assignment',{order_id:shift.pinned_order_id,assignee_id:shift.initial_assignee,at:now});
  return {snapshot:(await runtime.api(0,'/api/v2/workflow?warehouse_id='+runtime.target.warehouse_id)).snapshot,pauseWork:true};
 }
 const order=snapshot.orders.find(order=>order.id===shift.pinned_order_id),reserved=order?.reservations.filter(row=>row.quantity>0)??[];
 if(reserved.length){
  const times=reserved.map(row=>Date.parse(row.reserved_at));requireValue(times.every(Number.isFinite),'SHIFT_RESERVED_TIMESTAMP_MISSING');const reservedAt=Math.min(...times),age=now-reservedAt;
  if(age>=policy.reservation_warning_ms&&!shift.long_reservation_observed_at){save({long_reservation_observed_at:now,reserved_at:reservedAt,reservation_age_at_warning_ms:age});store.observe(runtime.id,'shift_long_reservation',{order_id:order.id,reserved_at:reservedAt,observed_at:now,age_ms:age,threshold_ms:policy.reservation_warning_ms,profile_threshold:true,production_24_hour_warning_claimed:false,quantity:reserved.reduce((sum,row)=>sum+row.quantity,0)});}
 }
 if(!shift.handover_completed_at&&now-run.context.measured_start>=policy.handover_at_ms){
  if(runtime.active.size)return {snapshot,pauseWork:true};
  requireValue(shift.long_reservation_observed_at,'SHIFT_LONG_RESERVATION_NOT_OBSERVED');
  const uncertain=store.operations(runtime.id).filter(op=>op.kind==='command'&&op.status==='unconfirmed');for(const op of uncertain)await runtime.recoverCommand(op);
  if(store.operations(runtime.id).some(op=>op.kind==='command'&&op.status==='unconfirmed'))return {snapshot,pauseWork:true};
  requireValue(!store.operations(runtime.id).some(op=>op.status==='quarantined'),'SHIFT_UNRESOLVED_RESULTS');
  const fresh=(await runtime.api(0,'/api/v2/workflow?warehouse_id='+runtime.target.warehouse_id)).snapshot;
  requireValue(!(fresh.approvals??[]).some(a=>a.status==='pending'),'SHIFT_UNEXPECTED_APPROVAL');
  const pending=[...fresh.receipts.filter(r=>r.lines.some(l=>l.quantity>l.received+l.cancelled)||r.lots.some(l=>l.pending+l.normal+l.hold>0)).map(r=>({object_type:'receipt',object_id:r.id})),...fresh.orders.filter(o=>o.lines.some(l=>l.quantity>l.cancelled+l.shipped)).map(o=>({object_type:'order',object_id:o.id})),...fresh.returns.filter(r=>!r.closed||r.lots.some(l=>l.pending+l.normal>0)).map(r=>({object_type:'return',object_id:r.id}))];
  const handover=pending.map(row=>({...row,assignee_id:runtime.workerActorIds[(shiftWorkerIndex(runtime,row.object_id,fresh)+1)%runtime.workers.length],reason:'T11 actual shift handover; preserve completed work and continue the remaining quantity'}));
  const pinned=handover.find(row=>row.object_id===shift.pinned_order_id);requireValue(pinned&&pinned.assignee_id!==shift.initial_assignee,'SHIFT_HELD_ORDER_HANDOVER_MISSING');
  const operation=controlOperation(runtime,store,'handover-version-'+fresh.version,'shift.close',{handover,unconfirmed_request_ids:[]});
  const result=await executeControl(runtime,store,operation);if(!result)return {snapshot:fresh,pauseWork:true};
  const after=(await runtime.api(0,'/api/v2/workflow?warehouse_id='+runtime.target.warehouse_id)).snapshot;
  requireValue(JSON.stringify(fresh.stock)===JSON.stringify(after.stock),'SHIFT_HANDOVER_CHANGED_PHYSICAL_STOCK');
  requireValue([...after.tasks].reverse().find(t=>t.object_id===shift.pinned_order_id)?.assignee_id===pinned.assignee_id,'SHIFT_HANDOVER_ASSIGNMENT_NOT_PERSISTED');
  save({handover_completed_at:now,final_assignee:pinned.assignee_id,shift_report_id:result.result.id});
  store.observe(runtime.id,'shift_handover',{order_id:shift.pinned_order_id,from:shift.initial_assignee,to:pinned.assignee_id,at:now,elapsed_ms:now-run.context.measured_start,report_id:result.result.id,stock_unchanged:true,handed_over_objects:handover.length});
  return {snapshot:after,pauseWork:true};
 }
 return {snapshot};
}

export function validateShiftConfiguration(config, mode = 'full', environment = process.env) {
  requireValue(['full', 'smoke'].includes(mode), 'INVALID_SHIFT_MODE');
  requireValue(Array.isArray(config.targets) && config.targets.length === 2, 'TWO_TEST_COMPANIES_REQUIRED');
  requireValue(Number.isSafeInteger(config.seed ?? 20261020), 'INTEGER_SEED_REQUIRED');
  const allKeys = [];
  for (const target of config.targets) {
    requireValue(ID.test(target.company_id) && ID.test(target.warehouse_id), 'INVALID_TARGET_SCOPE');
    const url = new URL(target.url);
    requireValue(!url.username && !url.password && !url.search && !url.hash && url.pathname === '/' &&
      (url.protocol === 'https:' || url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)), 'SECURE_TEST_TARGET_REQUIRED');
    const catalog = target.catalog;
    requireValue(Array.isArray(catalog) && catalog.length === (mode === 'full' ? 100 : catalog.length) && catalog.length >= 1, 'SHIFT_CATALOG_REQUIRED');
    requireValue(new Set(catalog.map(row => row.item_id)).size === catalog.length && catalog.every(row => ID.test(row.item_id)), 'UNIQUE_ITEM_CATALOG_REQUIRED');
    const locations = catalog.flatMap(row => ['receiving_id', 'storage_id', 'staging_id', 'hold_id','shipping_id'].filter(key=>row[key]!==undefined).map(key => row[key]));
    requireValue(locations.every(value => ID.test(value)) && (mode !== 'full' || new Set(locations).size === 20), 'TWENTY_LOCATIONS_REQUIRED');
    baselineDeltas(target);
    for (const field of ['supplier_id', 'customer_id', 'destination_id']) requireValue(ID.test(target[field]), 'BUSINESS_REFERENCES_REQUIRED');
    for (const field of ['expected_at', 'due_at']) requireValue(typeof target[field] === 'string' && Number.isFinite(Date.parse(target[field])), 'BUSINESS_DATES_REQUIRED');
    requireValue(Array.isArray(target.worker_key_envs) && target.worker_key_envs.length === (mode === 'full' ? 10 : target.worker_key_envs.length) && target.worker_key_envs.length >= 1, 'TEN_WORKERS_REQUIRED');
    const bindings = [target.source_key_env, target.process_key_env, target.supervisor_key_env??target.approver_key_env, ...target.worker_key_envs];
    requireValue(new Set(bindings).size === bindings.length, 'SEPARATE_KEY_BINDINGS_REQUIRED');
    for (const name of bindings) {
      requireValue(typeof name === 'string' && /^[A-Z][A-Z0-9_]*$/.test(name) && typeof environment[name] === 'string' && environment[name].length > 0, 'MACHINE_KEY_BINDING_REQUIRED');
      allKeys.push(environment[name]);
    }
    if (mode === 'smoke') requireValue(Number.isInteger(target.smoke_duration_ms ?? 15000) && (target.smoke_duration_ms ?? 15000) >= 1000 && (target.smoke_duration_ms ?? 15000) < SHIFT_DURATION_MS, 'SMOKE_DURATION_REQUIRED');
  }
  requireValue(config.targets[0].company_id !== config.targets[1].company_id, 'DISTINCT_COMPANIES_REQUIRED');
  requireValue(new Set(allKeys).size === allKeys.length, 'DISTINCT_MACHINE_IDENTITIES_REQUIRED');
  return { mode, duration_ms: mode === 'full' ? SHIFT_DURATION_MS : null, required_orders_per_company: mode === 'full' ? 1000 : 4, required_receipts_per_company: mode === 'full' ? 100 : 2 };
}

export function evaluateShiftJournal({ mode, target, run, operations, runtimeReport, observedAt = Date.now() }) {
  const failures = [], requiredOrders = mode === 'full' ? 1000 : 4, requiredReceipts = mode === 'full' ? 100 : 2;
  const events = operations.filter(op => op.kind === 'event' && op.input.phase === 'measured');
  const count = type => events.filter(op => op.input.event.event_type === type).length;
  if (count('order.create') !== requiredOrders || count('receipt.create') !== requiredReceipts || events.some(op => !sourceTypes.includes(op.input.event.event_type))) failures.push('PLANNED_COUNTS_MISMATCH');
  if (events.some(op => op.status !== 'done')) failures.push('UNRESOLVED_EXTERNAL_EVENTS');
  const expectedDuration = mode === 'full' ? SHIFT_DURATION_MS : target.smoke_duration_ms ?? 15000;
  const measuredStart = Number(run.context.measured_start), elapsed = observedAt - measuredStart;
  if (!Number.isFinite(measuredStart) || measuredStart <= 0 || elapsed < expectedDuration || run.config.duration_ms !== expectedDuration) failures.push('DURATION_NOT_COMPLETED');
  if (!(runtimeReport.integrity_passed??runtimeReport.verdict==='passed') || runtimeReport.incomplete?.length || runtimeReport.differences?.length) failures.push('RUNTIME_RECONCILIATION_FAILED');
  if (runtimeReport.delivered_unique_events !== requiredOrders + requiredReceipts) failures.push('DELIVERY_COUNTS_MISMATCH');
  const objects = new Map(events.filter(op => op.status === 'done').map(op => [op.result?.result?.id, op.input.event.event_type]));
  const measuredOrders = new Set([...objects].filter(([, type]) => type === 'order.create').map(([id]) => id));
  const measuredReceipts = new Set([...objects].filter(([, type]) => type === 'receipt.create').map(([id]) => id));
  if (measuredOrders.has(undefined) || measuredReceipts.has(undefined)) failures.push('OBJECT_BINDING_MISSING');
  if(measuredOrders.size!==requiredOrders||measuredReceipts.size!==requiredReceipts)failures.push('OBJECT_BINDING_DUPLICATE');
  if(new Set(events.map(op=>op.input.event.event_id)).size!==events.length)failures.push('DUPLICATE_EVENT_IDENTIFIERS');
  const commands = operations.filter(op => op.kind === 'command');
  const packages = new Map(commands.filter(op => op.input.command === 'package.create' && op.status === 'done').map(op => [op.result?.result?.id, op.input.payload.order_id]));
  const belongs = op => measuredReceipts.has(op.input.payload.receipt_id) || measuredOrders.has(op.input.payload.order_id) ||
    op.input.command === 'shipment.create' && op.input.payload.package_ids?.every(id => measuredOrders.has(packages.get(id)));
  const measuredCommands = commands.filter(belongs), done = measuredCommands.filter(op => op.status === 'done');
  const actors = new Set(done.map(op => Number(op.role)));
  if (done.some(op => !Number.isInteger(Number(op.role)) || Number(op.role) < 0 || Number(op.role) >= target.worker_key_envs.length)) failures.push('WORKER_SCOPE_MISMATCH');
  if (mode === 'full' && actors.size !== 10) failures.push('TEN_WORKERS_NOT_OBSERVED');
  const stageCounts = {};
  for (const [ids, stages] of [[measuredReceipts, ['receipt.receive', 'receipt.inspect', 'receipt.putaway']], [measuredOrders, ['order.reserve', 'order.pick', 'package.create', 'shipment.create']]]) {
    for (const stage of stages) {
      stageCounts[stage] = done.filter(op => op.input.command === stage).length;
      if (stageCounts[stage] !== ids.size) failures.push('PHYSICAL_STAGE_INCOMPLETE:' + stage);
    }
  }
  if (measuredCommands.some(op => op.status !== 'done')) failures.push('UNRESOLVED_PHYSICAL_COMMANDS');
  const lineSizes = events.flatMap(op => op.input.event.payload.lines?.length ?? []);
  if (lineSizes.some(size => size < 1 || size > 5)) failures.push('ORDER_LINE_PROFILE_MISMATCH');
  const shift=run.context.shift??{},policy=shiftPolicy(mode==='full'?'shift':'shift-smoke',target);
  if(!shift.initial_assignment_completed_at||!shift.long_reservation_observed_at||!shift.handover_completed_at||shift.final_assignee===shift.initial_assignee)failures.push('T11_HANDOVER_EVIDENCE_INCOMPLETE');
  if((shift.reservation_age_at_warning_ms??-1)<policy.reservation_warning_ms)failures.push('T11_RESERVATION_DURATION_NOT_MET');
  if((shift.handover_completed_at??0)-Number(run.context.measured_start)<policy.handover_at_ms)failures.push('T11_SHIFT_TIME_NOT_MET');
  const functionalPassed=failures.length===0;if(mode==='full'&&(!runtimeReport.quality_targets?.qualification||!runtimeReport.quality_targets?.met))failures.push('PERFORMANCE_TARGETS_NOT_MET');
  const seedEvents = operations.filter(op => op.kind === 'event' && op.input.phase === 'seed');
  return { company_id: target.company_id, warehouse_id: target.warehouse_id, mode, measured_start: Number.isFinite(measuredStart) ? new Date(measuredStart).toISOString() : null,
    elapsed_ms: Number.isFinite(elapsed) ? elapsed : null, required_duration_ms: expectedDuration, planned_orders: count('order.create'), planned_receipts: count('receipt.create'),
    initial_seed_receipts: seedEvents.length, initial_seed_is_measured_throughput: false, baseline_source_run_id:target.baseline?.source_run_id??null, worker_accounts_observed: actors.size, stage_counts: stageCounts, t11:{policy,held_order_id:shift.pinned_order_id,initial_assignee:shift.initial_assignee,final_assignee:shift.final_assignee,reservation_age_at_warning_ms:shift.reservation_age_at_warning_ms,handover_completed_at:shift.handover_completed_at,shift_report_id:shift.shift_report_id},
    functional_passed:functionalPassed,performance_targets:runtimeReport.quality_targets??{qualification:false,met:null}, failures: [...new Set(failures)], verdict: failures.length ? 'failed' : mode === 'full' ? 'passed' : 'smoke_passed', eight_hour_requirement_passed: mode === 'full' && failures.length === 0 };
}

function http(target, environment, fetcher) {
  return async (role, path) => {
    const name = role === 'source' ? target.source_key_env : target.worker_key_envs[0];
    const response = await fetcher(new URL(path, target.url), { headers: { authorization: 'Bearer ' + environment[name] }, redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw Object.assign(new Error('SHIFT_HTTP_FAILED'), { code: 'SHIFT_HTTP_FAILED', status: response.status });
    return response.json();
  };
}
async function verifyTarget(api, target) {
  const value = await api('source', '/api/v2/integration/connection');
  requireValue(value.contract_version === '2.0' && value.environment === 'test' && value.test_company === true && value.company_id === target.company_id && value.kind === 'integration' && value.warehouse_ids?.includes(target.warehouse_id), 'REGISTERED_TEST_TARGET_REQUIRED');
  return hash({ origin: new URL(target.url).origin, company: value.company_id, environment: value.environment, source: value.source_system, warehouses: [...value.warehouse_ids].sort(), contract: value.contract_version });
}

/** Baseline quantities originate from the independent fixture generator manifest. */
export function baselineDeltas(target) {
  if (!target.baseline) return [];
  requireValue(typeof target.baseline.source_run_id === 'string' && ID.test(target.baseline.source_run_id), 'BASELINE_PROVENANCE_REQUIRED');
  const rows=target.baseline.expected_positions, items=new Set(target.catalog.map(row=>row.item_id)), locations=new Set(target.catalog.flatMap(row=>['receiving_id','storage_id','staging_id','hold_id','shipping_id'].map(key=>row[key]).filter(Boolean))), keys=new Set(), result=[];
  requireValue(Array.isArray(rows)&&rows.length>0,'BASELINE_POSITIONS_REQUIRED');
  for(const row of rows){
    const key=row.item_id+':'+row.location_id;
    requireValue(items.has(row.item_id)&&ID.test(row.location_id)&&locations.has(row.location_id)&&!keys.has(key),'BASELINE_POSITION_SCOPE_INVALID');keys.add(key);
    for(const bucket of ['S','R','P','Q','B']){requireValue(Number.isSafeInteger(row[bucket])&&row[bucket]>=0,'BASELINE_QUANTITY_INVALID');if(row[bucket])result.push({item_id:row.item_id,location_id:row.location_id,bucket,delta:row[bucket]});}
    requireValue(row.R<=row.S,'BASELINE_RESERVATION_INVALID');
  }
  return result;
}

/** The expected side comes only from locally recorded physical intent, not returned WMS quantities. */
export async function reconcileShiftBoundary(target, operations, api, boundary) {
  const snapshot = (await api('worker', '/api/v2/workflow?warehouse_id=' + target.warehouse_id)).snapshot;
  requireValue(snapshot.version === boundary, 'SHIFT_BOUNDARY_CHANGED');
  const catalog = new Set(target.catalog.map(row => row.item_id)), expected = new Map(), actual = new Map(), ledger = new Map();
  const add = (map, key, quantity) => map.set(key, (map.get(key) ?? 0) + quantity);
  for(const row of baselineDeltas(target)) add(expected,[row.item_id,row.location_id,row.bucket].join(':'),row.delta);
  for (const op of operations.filter(op => op.kind === 'command' && op.status === 'done')) for (const row of op.input.oracle_deltas ?? []) add(expected, [row.item_id, row.location_id, row.bucket].join(':'), row.delta);
  for (const row of snapshot.stock.filter(row => catalog.has(row.item_id))) for (const bucket of ['S', 'R', 'P', 'Q', 'B']) add(actual, [row.item_id, row.location_id, bucket].join(':'), row[bucket]);
  let cursor, pages = 0;
  do {
    const result = await api('worker', '/api/v2/workflow/ledger?warehouse_id=' + target.warehouse_id + '&boundary=' + boundary + '&limit=500' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''));
    requireValue(result.boundary === boundary, 'SHIFT_LEDGER_BOUNDARY_CHANGED');
    for (const row of result.rows.filter(row => catalog.has(row.item_id))) add(ledger, [row.item_id, row.location_id, row.bucket].join(':'), row.delta);
    requireValue(!result.has_more || result.cursor && result.cursor !== cursor, 'SHIFT_LEDGER_CURSOR_STALLED');
    cursor = result.has_more ? result.cursor : undefined;
    requireValue(++pages <= 100000, 'SHIFT_LEDGER_PAGE_LIMIT');
  } while (cursor);
  const differences = [];
  for (const key of new Set([...expected.keys(), ...actual.keys(), ...ledger.keys()])) if ((expected.get(key) ?? 0) !== (actual.get(key) ?? 0) || (expected.get(key) ?? 0) !== (ledger.get(key) ?? 0)) differences.push({ key, expected: expected.get(key) ?? 0, actual: actual.get(key) ?? 0, ledger: ledger.get(key) ?? 0 });
  for(const op of operations.filter(op=>op.kind==='event'&&op.status==='done'&&['receipt.create','order.create'].includes(op.input.event.event_type))){
    const event=op.input.event,id=op.result?.result?.id,collection=event.event_type==='receipt.create'?snapshot.receipts:snapshot.orders;
    const object=collection?.find(row=>row.id===id);
    if(!object){differences.push({kind:'missing_business_object',external_id:event.external_entity_id});continue;}
    for(const planned of event.payload.lines){const line=planned.id?object.lines.find(row=>row.id===planned.id):object.lines.find(row=>row.item_id===planned.item_id);
      const doneField=event.event_type==='receipt.create'?'received':'shipped';
      if(!line||line.item_id!==planned.item_id||line.quantity!==planned.quantity||line.cancelled!==0||line[doneField]!==planned.quantity)differences.push({kind:'business_quantity',object_id:id,item_id:planned.item_id,expected:planned.quantity,actual:line?.[doneField]??null});
    }
  }
  const reserved = snapshot.orders.flatMap(order => order.reservations ?? []).filter(row => catalog.has(row.item_id)).reduce((sum, row) => sum + row.quantity, 0);
  const wantedR = [...expected].filter(([key]) => key.endsWith(':R')).reduce((sum, [, quantity]) => sum + quantity, 0);
  if (reserved !== wantedR) differences.push({ kind: 'reservation', expected: wantedR, actual: reserved });
  for (const row of snapshot.stock.filter(row => catalog.has(row.item_id))) {
    if (['S', 'R', 'P', 'Q', 'B'].some(bucket => !Number.isSafeInteger(row[bucket]) || row[bucket] < 0) || row.R > row.S) differences.push({ kind: 'invalid_quantity', item_id: row.item_id });
    if (row.H !== undefined && row.H !== row.S + row.P + row.Q + row.B) differences.push({ kind: 'physical_total', item_id: row.item_id });
    const storage=target.catalog.some(item=>item.storage_id===row.location_id),locked=snapshot.counts?.some(count=>count.location_id===row.location_id&&['counting','submitted'].includes(count.status)),blocked=snapshot.location_blocks?.some(block=>block.location_id===row.location_id);
    const available=storage&&!locked&&!blocked?row.S-row.R:0;if(row.A!==undefined&&row.A!==available)differences.push({kind:'available_total',item_id:row.item_id,expected:available,actual:row.A});
  }
  return { boundary, full_ledger_pages: pages, differences, passed: differences.length === 0 };
}

function childEnvironment(config, environment) {
  const result = {};
  for (const name of ['PATH', 'TZ', 'NODE_OPTIONS', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY']) if (environment[name]) result[name] = environment[name];
  for (const target of config.targets) for (const name of [target.source_key_env, target.process_key_env, target.supervisor_key_env??target.approver_key_env, ...target.worker_key_envs]) result[name] = environment[name];
  // Database URLs, provider credentials and administrator bindings are never inherited.
  return result;
}
function spawnRuntime(configPath, mode, resumeId, environment) {
  return new Promise((resolvePromise, reject) => {
    const args = [fileURLToPath(new URL('./profile.mjs', import.meta.url)), configPath, mode === 'full' ? 'shift' : 'shift-smoke', ...(resumeId ? [resumeId] : [])];
    const child = spawn(process.execPath, args, { env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
    let runId = resumeId, buffer = '';
    child.stdout.on('data', chunk => {
      buffer += chunk.toString(); let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); try { const value = JSON.parse(line); if (typeof value.run_id === 'string' && ID.test(value.run_id)) runId = value.run_id; } catch { /* Non-structured child output is not forwarded. */ } }
    });
    child.stderr.on('data', () => {});
    const stop = signal => child.kill(signal);
    const interrupt = () => stop('SIGINT'), terminate = () => stop('SIGTERM');
    process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
    child.on('error', reject);
    child.on('close', code => { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); if (!runId) reject(Object.assign(new Error('SHIFT_RUNTIME_FAILED'), { code: 'SHIFT_RUNTIME_FAILED' })); else resolvePromise({ runId, exitCode: code }); });
  });
}

export async function runShiftProfile({ configPath, mode = 'full', resumeId, environment = process.env, fetcher = fetch, executor = spawnRuntime }) {
  const absolute = resolve(configPath), config = JSON.parse(await readFile(absolute, 'utf8'));
  const specification = validateShiftConfiguration(config, mode, environment);
  if (resumeId) requireValue(ID.test(resumeId), 'INVALID_RESUME_RUN');
  const targetFingerprints = [];
  for (const target of config.targets) targetFingerprints.push(await verifyTarget(http(target, environment, fetcher), target));
  const execution = await executor(absolute, mode, resumeId, childEnvironment(config, environment));
  const directory = resolve(config.output ?? 'data/profile'), raw = JSON.parse(await readFile(directory + '/' + execution.runId + '.json', 'utf8'));
  const store = openStore(directory + '/profile.sqlite'), companies = [];
  try {
    for (const [index, target] of config.targets.entries()) {
      const id = execution.runId + ':' + index, run = store.run(id), operations = store.operations(id);
      requireValue(run && run.config.kind === (mode === 'full' ? 'shift' : 'shift-smoke'), 'SHIFT_JOURNAL_PROFILE_MISMATCH');
      const runtimeReport = raw.companies.find(company => company.company_id === target.company_id);
      requireValue(runtimeReport, 'SHIFT_RUNTIME_COMPANY_MISSING');
      const api = http(target, environment, fetcher);
      requireValue(await verifyTarget(api, target) === targetFingerprints[index], 'SHIFT_TARGET_CHANGED');
      const judged = evaluateShiftJournal({ mode, target, run, operations, runtimeReport });
      const reconciliation = await reconcileShiftBoundary(target, operations, api, runtimeReport.boundary);
      if (!reconciliation.passed) { judged.failures.push('INDEPENDENT_BOUNDARY_RECONCILIATION_FAILED'); judged.verdict = 'failed'; judged.eight_hour_requirement_passed = false; }
      companies.push({ ...judged, reconciliation, target_fingerprint: targetFingerprints[index] });
    }
  } finally { store.close(); }
  const report = { run_id: execution.runId, profile: mode === 'full' ? 'eight_hour_shift' : 'accelerated_shift_smoke', generator_version: '2.0.0', scenario_version: '1.1', generated_at: new Date().toISOString(), configuration_sha256: hash(config), specification,
    verdict: companies.every(company => company.verdict !== 'failed') ? mode === 'full' ? 'passed' : 'smoke_passed' : 'failed',
    eight_hour_requirement_passed: mode === 'full' && companies.every(company => company.eight_hour_requirement_passed), companies,
    runtime_report: execution.runId + '.json', runtime_report_sha256: hash(raw),
    limitations: ['No hosting, real-device or field certification.', 'Physical intent and execution come only from HTTP work and the independent local journal; no WMS database connection is used.', 'Shift handover and reservation duration are checked from actual persisted work; full-duration completion still requires eight real hours. Restore/resume needs its separate evidence. Accelerated smoke never satisfies the eight-hour duration.'] };
  await mkdir(directory, { recursive: true });
  const output = directory + '/' + execution.runId + '-shift-summary.json';
  await writeFile(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  return { report, output };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    requireValue(process.argv[2], 'Usage: node shift-profile.mjs targets.json [full|smoke] [resume-run-id]');
    console.log(JSON.stringify({event:'shift_profile_requested',mode:process.argv[3]??'full',full_duration_ms:SHIFT_DURATION_MS,eight_hour_requirement_passed:false}));
    const { report, output } = await runShiftProfile({ configPath: process.argv[2], mode: process.argv[3] ?? 'full', resumeId: process.argv[4] });
    console.log(JSON.stringify({ run_id: report.run_id, profile: report.profile, verdict: report.verdict, eight_hour_requirement_passed: report.eight_hour_requirement_passed, report: output }));
    process.exitCode = report.verdict === 'failed' ? 1 : 0;
  } catch (error) { console.error(JSON.stringify({ status: 'failed', code: error.code ?? 'SHIFT_PROFILE_FAILED', eight_hour_requirement_passed: false })); process.exitCode = 1; }
}
