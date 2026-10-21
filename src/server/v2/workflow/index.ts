import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { Identity } from '../../auth/access';
import { withTenant } from '../../db/tenant';
import { assertV2MachineKeyInTransaction, requireV2Access } from '../access';
import { applyCommand, applyOwnedCommand, fail, integer, object, reconcile, snapshot, text, uuid } from './engine';
import {correctionOriginActors,hydrateApprovalSeparation} from './approval-separation';
import {approvalActorExcluded,approvalRoleAllowed} from './approval-eligibility';
import {validateCorrection} from './corrections';
import { resolveBarcode } from '../masters/service';
import { emptyState, type Bucket, type WorkflowInput, type WorkflowState, type Stock } from './types';
import {readWorkflowState,writeWorkflowState,claimLoadedWorkflowState} from './object-storage';
import {firstPositions} from './position-index';
import {refreshStockLocations} from './location-projection';
import {physicalScanReferences,scanReferences} from './scan-reference-index';
import {genericHoldOwnership} from './hold-ownership';
import {hydrateLegacyOverageQuality} from './overage-quality';
import {nameHistoricalActors,nameSnapshotActors} from './actor-names';
import {beginTiming,observeTimingCount,timeAsync,timeSync,timingDiagnosticsActive} from '../../timing-diagnostics';
export * from './types';
export { applyCommand, emptyState, snapshot };

export function parseWorkflowInput(value:unknown):WorkflowInput { const v=object(value);const p=object(v.payload);return {warehouse_id:uuid(v.warehouse_id),request_id:uuid(v.request_id),command:text(v.command),payload:structuredClone(p)}; }
export function workflowPermission(command:string) {return ['approval.decide','order.damage','count.unlock','shift.close','shipment.delivery.correct'].includes(command)?'approve':'write';}
function canonical(value:unknown):string {if(value===null||typeof value!=='object')return JSON.stringify(value);if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical((value as Record<string,unknown>)[k])).join(',')+'}';}
function hash(value:unknown) {return createHash('sha256').update(canonical(value)).digest('hex');}
async function lockState(client:PoolClient,tenantId:string,warehouseId:string):Promise<WorkflowState> {
 const warehouse=await timeAsync('workflow.warehouse_lock',()=>client.query('SELECT id FROM warehouses WHERE tenant_id=$1 AND id=$2 AND active=true FOR SHARE',[tenantId,warehouseId]));if(!warehouse.rowCount)fail('WAREHOUSE_UNAVAILABLE',404);
 await timeAsync('workflow.state_initialize',()=>client.query('INSERT INTO v2_workflow_state_header(tenant_id,warehouse_id,state) VALUES($1,$2,$3::jsonb) ON CONFLICT DO NOTHING',[tenantId,warehouseId,JSON.stringify(emptyState())]));
 // Await includes the unchanged pg JSON parser; no text cast or parser override.
 const state=(await readWorkflowState(client,tenantId,warehouseId,'UPDATE'))!;observeStateCounts(state);if(!(await aggregateMatchesStock(client,tenantId,warehouseId,state)))fail('RECONCILIATION_FAILED');state.ledger=[];state.ledger_base=timeSync('workflow.state_clone',()=>structuredClone(state.stock));return state;
}
function observeStateCounts(state:WorkflowState){if(!timingDiagnosticsActive())return;observeTimingCount('state.stock_rows',state.stock.length);observeTimingCount('state.orders',state.orders.length);observeTimingCount('state.receipts',state.receipts.length);observeTimingCount('state.returns',state.returns.length);observeTimingCount('state.tasks',state.tasks.length);observeTimingCount('state.packages',state.packages.length);observeTimingCount('state.shipments',state.shipments.length);}
async function references(client:PoolClient,tenant:string,warehouse:string) {
 const items=await client.query('SELECT id,active FROM items WHERE tenant_id=$1 ORDER BY id FOR SHARE',[tenant]);
 // to_jsonb keeps this service compatible while the additive masters migration is rolling out.
 const locations=await client.query("SELECT id,active,COALESCE(to_jsonb(l)->>'kind','STORAGE') AS kind,code,COALESCE((to_jsonb(l)->>'priority')::integer,100) AS priority,COALESCE((to_jsonb(l)->>'reservation_blocked')::boolean,false) AS reservation_blocked FROM locations l WHERE tenant_id=$1 AND warehouse_id=$2 ORDER BY id FOR SHARE",[tenant,warehouse]);
 return{items:items.rows,locations:locations.rows};
}
function persist(client:PoolClient,identity:Identity,input:WorkflowInput,before:WorkflowState,after:WorkflowState,result:Record<string,unknown>,requestHash:string):Promise<WorkflowResponse>;
function persist(client:PoolClient,identity:Identity,input:WorkflowInput,before:WorkflowState,after:WorkflowState,result:Record<string,unknown>,requestHash:string,includeSnapshot:boolean,stockBefore?:readonly Stock[]):Promise<WorkflowResponse|WorkflowCompactResponse>;
async function persist(client:PoolClient,identity:Identity,input:WorkflowInput,before:WorkflowState,after:WorkflowState,result:Record<string,unknown>,requestHash:string,includeSnapshot=true,stockBefore:readonly Stock[]=before.stock):Promise<WorkflowResponse|WorkflowCompactResponse> {
 const tenant=identity.tenant.id,previousStock=firstPositions(stockBefore);for(const row of after.stock){const previous=previousStock.get(row.item_id)?.get(row.location_id);if(previous&&(['S','R','P','Q','B'] as const).every(b=>previous[b]===row[b]))continue;await timeAsync('workflow.persist_sql',()=>client.query(`INSERT INTO v2_workflow_stock(tenant_id,warehouse_id,item_id,location_id,s,r,p,q,b) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
 ON CONFLICT(tenant_id,warehouse_id,item_id,location_id) DO UPDATE SET s=EXCLUDED.s,r=EXCLUDED.r,p=EXCLUDED.p,q=EXCLUDED.q,b=EXCLUDED.b`,[tenant,input.warehouse_id,row.item_id,row.location_id,row.S,row.R,row.P,row.Q,row.B]));}
 const savedResponse={result,version:after.version};
 await timeAsync('workflow.persist_sql',()=>client.query('INSERT INTO v2_workflow_requests(tenant_id,warehouse_id,request_id,request_hash,command,actor_id,response) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)',[tenant,input.warehouse_id,input.request_id,requestHash,input.command,identity.user.id,JSON.stringify(savedResponse)]));
 for(const row of after.ledger){await timeAsync('workflow.persist_sql',()=>client.query(`INSERT INTO v2_workflow_ledger(id,tenant_id,warehouse_id,item_id,location_id,request_id,actor_id,command,bucket,delta,reason,original_id,created_at)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,[row.id,tenant,input.warehouse_id,row.item_id,row.location_id,input.request_id,identity.user.id,input.command,row.bucket,row.delta,row.reason,row.original_id??null,row.created_at]));}
 const persisted={...after,ledger:[],ledger_base:timeSync('workflow.state_clone',()=>structuredClone(after.stock))};
 await writeWorkflowState(client,tenant,input.warehouse_id,before,persisted);
 if(!includeSnapshot){await databaseSnapshot(client,tenant,input.warehouse_id,after,false,false);return{result,version:after.version,replayed:false};}
 return {result,snapshot:await databaseSnapshot(client,tenant,input.warehouse_id,after,false),replayed:false};
}
/** The caller must authenticate, authorize its restricted command scope and enter withTenant first. */
export type WorkflowResponse={result:Record<string,unknown>;snapshot:ReturnType<typeof snapshot>;replayed:boolean};
/** Internal response representation only; excluded from the business request/hash. */
export type WorkflowCompactResponse={result:Record<string,unknown>;version:number;replayed:boolean};
export function executeWorkflowInTransaction(client:PoolClient,identity:Identity,value:WorkflowInput,options:{includeSnapshot:false}):Promise<WorkflowCompactResponse>;
export function executeWorkflowInTransaction(client:PoolClient,identity:Identity,value:WorkflowInput,options?:{includeSnapshot?:true}):Promise<WorkflowResponse>;
export async function executeWorkflowInTransaction(client:PoolClient,identity:Identity,value:WorkflowInput,options:{includeSnapshot?:boolean}={}):Promise<WorkflowResponse|WorkflowCompactResponse> {
 const input=parseWorkflowInput(value);if(identity.role==='viewer')fail('ROLE_FORBIDDEN',403);
 await timeAsync('workflow.request_lock',()=>client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[identity.tenant.id+':'+input.request_id]));
 const before=await lockState(client,identity.tenant.id,input.warehouse_id);
 const requestHash=timeSync('workflow.request_hash',()=>hash(input));const saved=await client.query('SELECT request_hash,response FROM v2_workflow_requests WHERE tenant_id=$1 AND request_id=$2',[identity.tenant.id,input.request_id]);
 if(saved.rowCount){if(saved.rows[0].request_hash!==requestHash)fail('IDEMPOTENCY_CONFLICT');
  if(options.includeSnapshot===false){await databaseSnapshot(client,identity.tenant.id,input.warehouse_id,before,true,false);return{result:saved.rows[0].response.result,version:saved.rows[0].response.version,replayed:true};}
  return{result:saved.rows[0].response.result,snapshot:await databaseSnapshot(client,identity.tenant.id,input.warehouse_id,before),replayed:true};
 }
 const refs=await timeAsync('workflow.references',()=>references(client,identity.tenant.id,input.warehouse_id));
 if(!('keyId' in identity)){
 const current=await client.query(`SELECT role FROM memberships WHERE tenant_id=$1 AND user_id=$2 AND status='active' FOR SHARE`,[identity.tenant.id,identity.user.id]);
 if(!current.rowCount)fail('MEMBERSHIP_REQUIRED',403);identity={...identity,role:current.rows[0].role};
 }
 const payload=input.payload;
 const validDate=(value:unknown)=>{const raw=text(value);if(!Number.isFinite(new Date(raw).getTime()))fail('INVALID_TIMESTAMP',400);return new Date(raw).toISOString();};
 if(input.command==='receipt.create'){uuid(payload.supplier_id);payload.expected_at=validDate(payload.expected_at);}
 if(input.command==='order.create'||(['order.update','package.create'].includes(input.command)&&payload.delivery!==undefined)){const delivery=object(payload.delivery);uuid(delivery.partner_id);uuid(delivery.delivery_destination_id??delivery.destination_id);}
 if(input.command==='order.create')payload.due_at=validDate(payload.due_at);
 if(input.command==='receipt.update'&&payload.expected_at!==undefined)payload.expected_at=validDate(payload.expected_at);
 if(input.command==='order.update'&&payload.due_at!==undefined)payload.due_at=validDate(payload.due_at);

 if(payload.supplier_id){const supplier=await client.query('SELECT id,code,name FROM business_partners WHERE tenant_id=$1 AND id=$2 AND active AND supplier FOR SHARE',[identity.tenant.id,uuid(payload.supplier_id)]);if(!supplier.rowCount)fail('SUPPLIER_UNAVAILABLE');payload.supplier=supplier.rows[0];}
 if(payload.delivery&&typeof payload.delivery==='object'&&!Array.isArray(payload.delivery)){
 const delivery=payload.delivery as Record<string,unknown>;
 if(delivery.partner_id){const partner=await client.query('SELECT id FROM business_partners WHERE tenant_id=$1 AND id=$2 AND active AND customer FOR SHARE',[identity.tenant.id,uuid(delivery.partner_id)]);if(!partner.rowCount)fail('CUSTOMER_UNAVAILABLE');}
 const destination=delivery.destination_id??delivery.delivery_destination_id;
 if(destination){const found=await client.query('SELECT id,partner_id,recipient_name,name,postal_code,address_line1,address_line2,contact_name,phone FROM delivery_destinations WHERE tenant_id=$1 AND id=$2 AND active FOR SHARE',[identity.tenant.id,uuid(destination)]);if(!found.rowCount)fail('DESTINATION_UNAVAILABLE');if(found.rows[0].partner_id!==delivery.partner_id)fail('DESTINATION_PARTNER_MISMATCH');payload.delivery={...found.rows[0],delivery_destination_id:found.rows[0].id};}
 }
 if(input.command==='task.assign'||input.command==='shift.close'){
 const approvalAssignees=new Set<string>(),hydrated=new Set<string>();
 if(input.command==='shift.close'&&Array.isArray(payload.handover))for(const raw of payload.handover){
  const handover=object(raw),approval=before.approvals.find(row=>row.id===handover.object_id);
  // An extra differently typed entry must not override the effective owner of
  // an approval after a valid entry satisfied the required-handover check.
  if(handover.object_type!=='approval'&&!approval)continue;
  if(handover.object_type!=='approval'||!approval||approval.status!=='pending')fail('HANDOVER_REQUIRED');
  if(!hydrated.has(approval.id)){await hydrateApprovalSeparation(client,identity.tenant.id,input.warehouse_id,before,approval);hydrated.add(approval.id);}
  const assignee=text(handover.assignee_id);
  if(approvalActorExcluded(before,approval,assignee))fail('ASSIGNEE_UNAVAILABLE');
  approvalAssignees.add(assignee);
 }
 const assignees=input.command==='task.assign'?[payload.assignee_id]:(Array.isArray(payload.handover)?payload.handover.map(x=>object(x).assignee_id):[]);
 for(const rawAssignee of new Set(assignees)){
 const assignee=text(rawAssignee);
 if(assignee.startsWith('machine:')){
  if(process.env.WMS_ENVIRONMENT!=='test')fail('AUTOMATION_FORBIDDEN',403);const keyId=uuid(assignee.slice(8));
  const active=await client.query(`SELECT 1 FROM v2_machine_keys k JOIN v2_machine_warehouses g ON g.tenant_id=k.tenant_id AND g.key_id=k.id JOIN tenants t ON t.id=k.tenant_id WHERE k.tenant_id=$1 AND k.id=$2 AND g.warehouse_id=$3 AND t.active AND t.is_test AND k.kind='automation' AND k.environment='test' AND k.revoked_at IS NULL AND k.expires_at>CURRENT_TIMESTAMP AND k.role IN ('worker','supervisor') AND k.scopes @> ARRAY['read','write']::text[] FOR SHARE OF k,g`,[identity.tenant.id,keyId,input.warehouse_id]);if(!active.rowCount)fail('ASSIGNEE_UNAVAILABLE');
  if(approvalAssignees.has(assignee))await assertV2MachineKeyInTransaction(client,identity.tenant.id,keyId,'approve',input.warehouse_id);
 }else{
  const active=await client.query(`SELECT m.role FROM memberships m JOIN v2_warehouse_grants g ON g.tenant_id=m.tenant_id AND g.user_id=m.user_id WHERE m.tenant_id=$1 AND m.user_id=$2 AND m.status='active' AND m.role IN ('worker','admin','supervisor') AND g.warehouse_id=$3 FOR SHARE OF m,g`,[identity.tenant.id,assignee,input.warehouse_id]);if(!active.rowCount)fail('ASSIGNEE_UNAVAILABLE');
  if(approvalAssignees.has(assignee)&&!approvalRoleAllowed(active.rows[0].role))fail('ASSIGNEE_UNAVAILABLE');
 }
 }
 }

 // Do not mix new work into an unreviewed legacy warehouse.
 const cutoverTable=await client.query("SELECT to_regclass('v2_cutovers') AS name");
 if(cutoverTable.rows[0]?.name){const legacy=await client.query('SELECT 1 FROM stock_balances WHERE tenant_id=$1 AND warehouse_id=$2 AND quantity<>0 LIMIT 1',[identity.tenant.id,input.warehouse_id]);if(legacy.rowCount){const converted=await client.query("SELECT 1 FROM v2_cutovers WHERE tenant_id=$1 AND warehouse_id=$2 AND state='active'",[identity.tenant.id,input.warehouse_id]);if(!converted.rowCount)fail('LEGACY_CUTOVER_REQUIRED');}}
 if(input.command==='order.reserve') refs.locations=refs.locations.map(x=>x.reservation_blocked?{...x,kind:'BLOCKED'}:x);
 if(identity.role==='worker'&&input.command!=='task.assign'){
 const targets=new Set<unknown>([input.payload.order_id,input.payload.receipt_id,input.payload.return_id,input.payload.count_id].filter(Boolean));
 const packageIds=Array.isArray(input.payload.package_ids)?input.payload.package_ids:input.payload.package_id?[input.payload.package_id]:[];
 for(const pack of before.packages.filter(p=>packageIds.includes(p.id)))targets.add(pack.order_id);
 if(input.payload.shipment_id)for(const line of before.shipments.find(sh=>sh.id===input.payload.shipment_id)?.lines??[])targets.add(line.order_id);
 if(input.payload.lot_id){for(const parent of [...before.receipts,...before.returns])if(parent.lots.some(l=>l.id===input.payload.lot_id))targets.add(parent.id);}
 for(const target of targets){const task=[...before.tasks].reverse().find(t=>t.object_id===target);if(task&&task.assignee_id!==identity.user.id)fail('TASK_ASSIGNEE_MISMATCH',403);}
 if(['hold.release','stock.inspect','stock.putaway'].includes(input.command)){const ids=input.command==='hold.release'?[input.payload.lot_id]:Array.isArray(input.payload.lines)?input.payload.lines.map(line=>object(line).lot_id):[];for(const id of new Set(ids)){const lot=(before.holds??[]).find(lot=>lot.id===id);if(!lot){if(input.command!=='hold.release')fail('NOT_FOUND',404);continue;}const ownership=genericHoldOwnership(before,lot);if(ownership.requiresAssignment)fail('HOLD_ASSIGNMENT_REQUIRED',403);if(ownership.task&&ownership.task.assignee_id!==identity.user.id)fail('TASK_ASSIGNEE_MISMATCH',403);}}
 }
 input.payload.overage_history_recovery=await timeAsync('workflow.legacy_hydrate',()=>hydrateLegacyOverageQuality(client,identity.tenant.id,input.warehouse_id,before));
 if(input.command==='correction.request'){await validateCorrection(client,identity.tenant.id,input.warehouse_id,before,input.payload);input.payload.source_actor_ids=await correctionOriginActors(client,identity.tenant.id,input.warehouse_id,String(input.payload.original_id));}
 if(input.command==='approval.decide'){const a=before.approvals.find(a=>a.id===input.payload.approval_id);if(a)await hydrateApprovalSeparation(client,identity.tenant.id,input.warehouse_id,before,a);}
 if(input.command==='approval.decide'&&input.payload.approve===true){const approval=before.approvals.find(a=>a.id===input.payload.approval_id);if(approval?.type==='correction')await validateCorrection(client,identity.tenant.id,input.warehouse_id,before,{...approval.data,original_id:approval.target_id},approval.id);}
 await timeAsync('workflow.scans',()=>normalizeScans(client,before,input,identity));
 const now=(await client.query<{now:string}>('SELECT CURRENT_TIMESTAMP::text AS now')).rows[0].now;
 if(input.command==='shift.close'&&!(await reconcileWorkflowInTransaction(client,identity.tenant.id,input.warehouse_id)).ok)fail('RECONCILIATION_FAILED');
 const applied=timeSync('workflow.engine',()=>{const ownership=timeSync('workflow.state_clone',()=>claimLoadedWorkflowState(before));return applyOwnedCommand(ownership,input.command,input.payload,{actor:{id:identity.user.id,role:identity.role},command:input.command,request_id:input.request_id,now:new Date(now).toISOString(),id:randomUUID,...refs});});
 const createdKind:Record<string,string>={'receipt.create':'receipt','order.create':'order','return.request':'return','package.create':'package','shipment.create':'shipment','count.start':'count'};
 if(createdKind[input.command])await client.query('INSERT INTO v2_workflow_objects(tenant_id,warehouse_id,id,kind,external_id) VALUES($1,$2,$3,$4,$5)',[identity.tenant.id,input.warehouse_id,applied.result.id,createdKind[input.command],typeof input.payload.external_id==='string'?input.payload.external_id:null]);
 if(['receipt.receive','return.receive'].includes(input.command))await client.query('INSERT INTO v2_workflow_receivings(tenant_id,warehouse_id,receiving_id,request_id,object_id) VALUES($1,$2,$3,$4,$5)',[identity.tenant.id,input.warehouse_id,input.payload.receiving_id??input.request_id,input.request_id,input.payload.receipt_id??input.payload.return_id]);
 const evidence=safeEvidence(input.payload);
 await client.query('INSERT INTO v2_workflow_performances(tenant_id,warehouse_id,request_id,actor_id,command,evidence,reason) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)',[identity.tenant.id,input.warehouse_id,input.request_id,identity.user.id,input.command,JSON.stringify(evidence),typeof input.payload.reason==='string'?input.payload.reason:'']);
 return persist(client,identity,input,before,applied.state,applied.result,requestHash,options.includeSnapshot!==false,applied.previousStock);
}
export async function executeWorkflow(identity:Identity,input:WorkflowInput) {const parsed=parseWorkflowInput(input);await requireV2Access(identity,parsed.warehouse_id,workflowPermission(parsed.command));return withTenant(identity.tenant.id,c=>executeWorkflowInTransaction(c,identity,parsed));}
export async function getWorkflowSnapshot(identity:Identity,warehouseId:string) {uuid(warehouseId);await requireV2Access(identity,warehouseId,'read');return withTenant(identity.tenant.id,async c=>{const state=await readWorkflowState(c,identity.tenant.id,warehouseId,'SHARE');return databaseSnapshot(c,identity.tenant.id,warehouseId,state??emptyState());});}
export async function getWorkflowRequest(identity:Identity,warehouseId:string,requestId:string) {uuid(warehouseId);uuid(requestId);await requireV2Access(identity,warehouseId,'read');return withTenant(identity.tenant.id,async c=>{const state=await readWorkflowState(c,identity.tenant.id,warehouseId,'SHARE');const r=await c.query('SELECT response FROM v2_workflow_requests WHERE tenant_id=$1 AND warehouse_id=$2 AND request_id=$3',[identity.tenant.id,warehouseId,requestId]);if(!r.rowCount)fail('NOT_FOUND',404);return {...r.rows[0].response,replayed:true,snapshot:await databaseSnapshot(c,identity.tenant.id,warehouseId,state??emptyState())};});}

function safeEvidence(payload:Record<string,unknown>) {
 const keys=['id','line_id','lot_id','reservation_id','pick_id','item_id','location_id','from_location_id','quantity','outcome','scanned_item_id','scanned_location_id','input_mode','conversion'];
 const references=Object.fromEntries(['receipt_id','order_id','return_id','count_id','lot_id','package_id','package_ids','shipment_id','approval_id','object_type','object_id','assignee_id','receiving_id','original_id','original_order_id','original_return_id','expected_version','weight_grams','previous_revision','revision','status'].filter(key=>payload[key]!==undefined).map(key=>[key,payload[key]]));
 return {...references,...(Array.isArray(payload.overage_history_recovery)&&payload.overage_history_recovery.length?{overage_history_recovery:payload.overage_history_recovery}:{}),lines:(Array.isArray(payload.lines)?payload.lines:payload.lot_id?[payload]:[]).map(value=>{const line=object(value);return Object.fromEntries(keys.filter(key=>line[key]!==undefined).map(key=>[key,line[key]]));}),execution_mode:payload.execution_mode==='automated'?'automated':'human',manual_entry_reason:typeof payload.manual_entry_reason==='string'?payload.manual_entry_reason:undefined};
}
export const physicalWorkflowCommands=['receipt.receive','receipt.inspect','receipt.putaway','order.pick','order.return_picked','order.damage','package.create','return.receive','return.inspect','return.putaway','stock.move','stock.hold','stock.inspect','stock.putaway','hold.release'] as const;
async function normalizeScans(client:PoolClient,state:WorkflowState,input:WorkflowInput,identity:Identity) {
 const physical=(physicalWorkflowCommands as readonly string[]).includes(input.command);
 const automated=input.payload.execution_mode==='automated';
 if(automated&&(!('kind' in identity)||identity.kind!=='automation'||!('isTest' in identity.tenant)||identity.tenant.isTest!==true||process.env.WMS_ENVIRONMENT!=='test'))fail('AUTOMATION_FORBIDDEN',403);

 const inputLines=Array.isArray(input.payload.lines)?input.payload.lines:input.command==='hold.release'?[input.payload]:[];
 const references=scanReferences(state),physicalReferences=physicalScanReferences(state,input.command,input.payload);
 for(const value of inputLines){const line=object(value);if(physical&&!automated&&!['barcode','search'].includes(String(line.input_mode)))fail('INVALID_SCAN_MODE',400);
 if(line.input_mode==='search'){try{input.payload.manual_entry_reason=text(input.payload.manual_entry_reason);}catch{fail('MANUAL_ENTRY_REASON_REQUIRED',400);}}
 const source=physical?physicalReferences(line):undefined;
 const lot=physical?source:references.lot(line.lot_id);
 const reservation=physical?source:references.reservation(line.reservation_id);
 const pick=physical?source:references.pick(line.pick_id);
 const expectedLocation=['stock.move','stock.hold'].includes(input.command)?line.from_location_id:input.command==='order.pick'?reservation?.location_id:['receipt.inspect','return.inspect','stock.inspect'].includes(input.command)?lot?.location_id:input.command==='package.create'?pick?.location_id:line.location_id;
 if(line.input_mode==='barcode'&&physical&&expectedLocation!==undefined&&line.scanned_location_id===undefined)fail('LOCATION_SCAN_REQUIRED',400);
 if(line.scanned_location_id!==undefined&&expectedLocation!==undefined&&line.scanned_location_id!==expectedLocation)fail('WRONG_LOCATION_SCAN');
 const expectedItem=physical?(['stock.move','stock.hold'].includes(input.command)?line.item_id:source?.item_id):typeof line.item_id==='string'?line.item_id:references.line(line.line_id)?.item_id??lot?.item_id??reservation?.item_id??pick?.item_id;
 if(physical&&typeof line.item_id==='string'&&expectedItem!==undefined&&line.item_id!==expectedItem)fail('WRONG_ITEM_SCAN');
 if(line.scanned_item_id!==undefined&&expectedItem!==undefined&&line.scanned_item_id!==expectedItem)fail('WRONG_ITEM_SCAN');
 if(line.scans===undefined){if(line.input_mode==='barcode')fail('ITEM_SCAN_REQUIRED',400);continue;}
 if(!Array.isArray(line.scans)||!line.scans.length||line.scans.length>100)fail('INVALID_SCANS',400);
 let total=0;const conversion=[];
 for(const raw of line.scans){const scan=object(raw);const barcode=text(scan.barcode);const count=integer(scan.count);const mapping=await resolveBarcode(client,barcode);if(mapping.item_id!==expectedItem)fail('WRONG_ITEM_SCAN');const base=count*Number(mapping.quantity);if(!Number.isSafeInteger(base)||base>1_000_000_000)fail('INVALID_QUANTITY',400);total+=base;conversion.push({barcode,input_unit:mapping.unit,conversion_quantity:Number(mapping.quantity),input_quantity:count,base_quantity:base,item_id:mapping.item_id});}
 if(line.quantity!==undefined&&line.quantity!==total)fail('SCAN_QUANTITY_MISMATCH',400);line.quantity=total;line.scanned_item_id=expectedItem;line.conversion=conversion;
 }
}

async function aggregateMatchesStock(client:PoolClient,tenantId:string,warehouseId:string,state:WorkflowState) {
 const end=beginTiming('workflow.aggregate_match');try{
 const rows=(await timeAsync('workflow.stock_read',()=>client.query('SELECT item_id,location_id,s,r,p,q,b FROM v2_workflow_stock WHERE tenant_id=$1 AND warehouse_id=$2',[tenantId,warehouseId]))).rows;
 if(rows.length!==state.stock.length)return false;
 const stock=firstPositions(rows);
 return state.stock.every(st=>{const row=stock.get(st.item_id)?.get(st.location_id);return row&&(['S','R','P','Q','B'] as const).every(b=>Number(row[b.toLowerCase()])===st[b]);});
 }catch(error){end(true);throw error;}finally{end();}
}

/** Independent persisted balance-to-ledger check at a stable warehouse lock boundary. */
export async function reconcileWorkflowInTransaction(client:PoolClient,tenantId:string,warehouseId:string) {
 const end=beginTiming('workflow.persisted_reconcile');try{
 const r=await client.query(`WITH l AS (SELECT item_id,location_id,COALESCE(sum(delta) FILTER(WHERE bucket='S'),0) s,COALESCE(sum(delta) FILTER(WHERE bucket='R'),0) r,COALESCE(sum(delta) FILTER(WHERE bucket='P'),0) p,COALESCE(sum(delta) FILTER(WHERE bucket='Q'),0) q,COALESCE(sum(delta) FILTER(WHERE bucket='B'),0) b FROM v2_workflow_ledger WHERE tenant_id=$1 AND warehouse_id=$2 GROUP BY item_id,location_id) SELECT count(*)::int AS differences FROM (SELECT * FROM v2_workflow_stock WHERE tenant_id=$1 AND warehouse_id=$2) s FULL JOIN l USING(item_id,location_id) WHERE COALESCE(s.s,0)<>COALESCE(l.s,0) OR COALESCE(s.r,0)<>COALESCE(l.r,0) OR COALESCE(s.p,0)<>COALESCE(l.p,0) OR COALESCE(s.q,0)<>COALESCE(l.q,0) OR COALESCE(s.b,0)<>COALESCE(l.b,0)`,[tenantId,warehouseId]);return {ok:r.rows[0].differences===0,differences:r.rows[0].differences};
 }catch(error){end(true);throw error;}finally{end();}
}
async function databaseSnapshot(client:PoolClient,tenantId:string,warehouseId:string,state:WorkflowState,independent?:boolean):Promise<ReturnType<typeof snapshot>>;
async function databaseSnapshot(client:PoolClient,tenantId:string,warehouseId:string,state:WorkflowState,independent:boolean,includeSnapshot:false):Promise<undefined>;
async function databaseSnapshot(client:PoolClient,tenantId:string,warehouseId:string,state:WorkflowState,independent=true,includeSnapshot=true) {
 const end=beginTiming('workflow.snapshot');try{
 // Compact internal callers still execute every query and reconciliation below.
 // Only response-only deep cloning, blind-count projection and A/H views are omitted.
 observeStateCounts(state);const s=timeSync('workflow.snapshot_clone',()=>includeSnapshot?structuredClone(state):{...state,stock:state.stock.map(row=>({...row}))});
 await timeAsync('workflow.legacy_hydrate',()=>hydrateLegacyOverageQuality(client,tenantId,warehouseId,s));
 const locs=await timeAsync('workflow.snapshot_sql',()=>client.query("SELECT id,active,COALESCE(to_jsonb(l)->>'kind','STORAGE') AS kind,COALESCE((to_jsonb(l)->>'reservation_blocked')::boolean,false) AS reservation_blocked FROM locations l WHERE tenant_id=$1 AND warehouse_id=$2",[tenantId,warehouseId]));
 refreshStockLocations(s,locs.rows);
 const history=await timeAsync('workflow.snapshot_sql',()=>client.query("SELECT id,item_id,location_id,bucket,delta::float8 AS delta,request_id,actor_id,command,reason,original_id,created_at FROM v2_workflow_ledger WHERE tenant_id=$1 AND warehouse_id=$2 ORDER BY created_at DESC,id DESC LIMIT 100",[tenantId,warehouseId]));
 s.ledger=history.rows.reverse();s.ledger_base=timeSync('workflow.snapshot_clone',()=>structuredClone(s.stock));for(const row of s.ledger){const baseline=s.ledger_base.find(x=>x.item_id===row.item_id&&x.location_id===row.location_id);if(baseline)baseline[row.bucket]-=row.delta;}
 const view=includeSnapshot?snapshot(s):undefined;const validation=view?.reconciliation??timeSync('workflow.snapshot_reconcile',()=>reconcile(s));if(view)delete view.ledger_base;
 if(!(await aggregateMatchesStock(client,tenantId,warehouseId,state))){validation.ok=false;validation.issues.push('AGGREGATE_STOCK_MISMATCH');}
 if(independent){const db=await reconcileWorkflowInTransaction(client,tenantId,warehouseId);if(!db.ok){validation.ok=false;validation.issues.push('PERSISTED_LEDGER_MISMATCH');}}
 if(view)await timeAsync('workflow.actor_names',()=>nameSnapshotActors(client,tenantId,view));
 return view;
 }catch(error){end(true);throw error;}finally{end();}
}

/** Internal opening only: caller verifies legacy mapping or separately approved external source, and owns the transaction. */
export async function importLegacyOpeningInTransaction(client:PoolClient,identity:Identity,warehouseId:string,rows:{item_id:string;location_id:string;bucket:'S'|'Q'|'B';quantity:number}[],requestId:string,origin:'MIGRATION_OPENING'|'EXTERNAL_OPENING'='MIGRATION_OPENING') {
 const before=await lockState(client,identity.tenant.id,uuid(warehouseId));if(before.version!==0||before.stock.length||before.ledger.length)fail('V2_WAREHOUSE_NOT_EMPTY');const refs=await references(client,identity.tenant.id,warehouseId);const after=structuredClone(before);const now=(await client.query<{now:string}>('SELECT CURRENT_TIMESTAMP::text AS now')).rows[0].now;
 for(const x of rows){if(!refs.items.some(i=>i.id===x.item_id)||!refs.locations.some(l=>l.id===x.location_id))fail('REFERENCE_CONFLICT');if(!['S','Q','B'].includes(x.bucket)||!Number.isSafeInteger(x.quantity)||x.quantity<0)fail('INVALID_INPUT',400);if(!x.quantity)continue;let st=after.stock.find(s=>s.item_id===x.item_id&&s.location_id===x.location_id);if(!st){st={item_id:x.item_id,location_id:x.location_id,S:0,R:0,P:0,Q:0,B:0};after.stock.push(st);}st[x.bucket]+=x.quantity;if(x.bucket!=='S')after.holds.push({id:randomUUID(),line_id:randomUUID(),item_id:x.item_id,location_id:x.location_id,quantity:x.quantity,pending:x.bucket==='Q'?x.quantity:0,normal:0,hold:x.bucket==='B'?x.quantity:0,putaway:0,overage:false,approved:0,released:0});after.ledger.push({id:randomUUID(),item_id:x.item_id,location_id:x.location_id,bucket:x.bucket as Bucket,delta:x.quantity,request_id:requestId,actor_id:identity.user.id,command:origin,reason:origin==='EXTERNAL_OPENING'?'외부 자료의 별도 승인 개시재고':'기존 원장 잔량의 검증된 상태 이관',created_at:new Date(now).toISOString()});}
 after.version=1;after.ledger_count=after.ledger.length;const input={warehouse_id:warehouseId,request_id:uuid(requestId),command:origin,payload:{rows}};return persist(client,identity,input,before,after,{warehouse_id:warehouseId,opening_rows:rows.length},hash(input));
}

export type WorkflowLedgerQuery={warehouse_id:string;item_id?:string;location_id?:string;cursor?:string;boundary?:number;limit?:number;from?:string;to?:string};
/** An immutable version boundary plus the ledger timestamp/UUID pair makes every page repeatable. */
export async function listWorkflowLedger(identity:Identity,q:WorkflowLedgerQuery) {
 const warehouseId=uuid(q.warehouse_id);const itemId=q.item_id?uuid(q.item_id):null;const locationId=q.location_id?uuid(q.location_id):null;const limit=q.limit??100;if(!Number.isInteger(limit)||limit<1||limit>500)fail('INVALID_LIMIT',400);
 const parseTime=(value:string|undefined)=>{if(!value)return null;const date=new Date(value);if(!Number.isFinite(date.getTime()))fail('INVALID_TIMESTAMP',400);return date.toISOString();};const from=parseTime(q.from),to=parseTime(q.to);if(from&&to&&from>to)fail('INVALID_TIMESTAMP_RANGE',400);
 await requireV2Access(identity,warehouseId,'read');
 return withTenant(identity.tenant.id,async client=>{
 const st=await client.query('SELECT version FROM v2_workflow_state WHERE tenant_id=$1 AND warehouse_id=$2 FOR SHARE',[identity.tenant.id,warehouseId]);const current=st.rows[0]?.version??0;
 let boundary=q.boundary??current;let at:string|null=null,id:string|null=null;const filters=hash({tenant:identity.tenant.id,warehouse:warehouseId,item:itemId,location:locationId,from,to});
 if(q.cursor){try{const value=object(JSON.parse(Buffer.from(q.cursor,'base64url').toString('utf8')));if(value.filters!==filters||typeof value.at!=='string'||!Number.isInteger(value.boundary))fail('INVALID_CURSOR',400);at=value.at;id=uuid(value.id);if(q.boundary!==undefined&&q.boundary!==value.boundary)fail('BOUNDARY_CONFLICT',409);boundary=value.boundary as number;}catch(error){if(error instanceof Error&&'code' in error)throw error;fail('INVALID_CURSOR',400);}}
 if(!Number.isSafeInteger(boundary)||boundary<0||boundary>current)fail('INVALID_BOUNDARY',400);
 const rows=(await client.query(`SELECT l.id,l.item_id,l.location_id,l.bucket,l.delta::float8 AS delta,l.request_id,l.actor_id,l.command,l.reason,l.original_id,l.created_at::text AS created_at,(r.response->>'version')::integer AS version
 FROM v2_workflow_ledger l JOIN v2_workflow_requests r ON r.tenant_id=l.tenant_id AND r.request_id=l.request_id
 WHERE l.tenant_id=$1 AND l.warehouse_id=$2 AND (r.response->>'version')::integer<=$3
 AND ($4::uuid IS NULL OR l.item_id=$4) AND ($5::timestamptz IS NULL OR l.created_at>=$5) AND ($6::timestamptz IS NULL OR l.created_at<=$6)
 AND ($10::uuid IS NULL OR l.location_id=$10) AND ($7::timestamptz IS NULL OR (l.created_at,l.id)>($7::timestamptz,$8::uuid)) ORDER BY l.created_at,l.id LIMIT $9`,[identity.tenant.id,warehouseId,boundary,itemId,from,to,at,id,limit+1,locationId])).rows;
 const has_more=rows.length>limit;if(has_more)rows.pop();await nameHistoricalActors(client,identity.tenant.id,rows);const last=rows.at(-1);const cursor=has_more&&last?Buffer.from(JSON.stringify({filters,boundary,at:last.created_at,id:last.id})).toString('base64url'):null;
 return{rows,cursor,has_more,boundary,warehouse_id:warehouseId,item_id:itemId,location_id:locationId,from,to};
 });
}
