import type {PoolClient} from 'pg';
import type {Approval,WorkflowState} from './types';
/** Retain the real requester separately from every actor whose physical work is being approved. */
export async function hydrateApprovalSeparation(client:PoolClient,tenant:string,warehouse:string,state:WorkflowState,approval:Approval) {
 const previousRequester=approval.requester_id;
 const request=(await client.query('SELECT request_id,actor_id FROM v2_workflow_requests WHERE tenant_id=$1 AND warehouse_id=$2 AND (request_id=$3::uuid OR response->\'result\'->>\'id\'=$4) ORDER BY created_at LIMIT 1',[tenant,warehouse,approval.request_id??null,approval.id])).rows[0];
 if(request){approval.requester_id=request.actor_id;approval.request_id=request.request_id;}
 const origins=new Set(approval.origin_actor_ids??[]);
 if(approval.type==='overage'){
  const lot=[...state.receipts,...state.returns].flatMap(r=>r.lots).find(l=>l.id===approval.target_id);
  if(lot?.received_by)origins.add(lot.received_by);else if(!approval.origin_actor_ids)origins.add(previousRequester);
 }else if(approval.type==='count'){
  const count=state.counts.find(c=>c.id===approval.target_id);
  const actors=(await client.query("SELECT DISTINCT actor_id FROM v2_workflow_performances WHERE tenant_id=$1 AND warehouse_id=$2 AND command='count.record' AND evidence->>'count_id'=$3",[tenant,warehouse,approval.target_id])).rows.map(x=>x.actor_id as string);
  if(count){count.counter_ids=[...new Set([...(count.counter_ids??[]),...actors,...(count.counter_id?[count.counter_id]:[])])];for(const id of count.counter_ids)origins.add(id);if(!origins.size)origins.add(previousRequester);}
 }else if(approval.type==='correction'){
  for(const id of await correctionOriginActors(client,tenant,warehouse,approval.target_id))origins.add(id);
 }else if(approval.type==='receipt.close'){
  for(const lot of state.receipts.find(r=>r.id===approval.target_id)?.lots??[])if(lot.received_by)origins.add(lot.received_by);
 }
 approval.origin_actor_ids=[...origins];
}
export async function correctionOriginActors(client:PoolClient,tenant:string,warehouse:string,sourceId:string):Promise<string[]> {
 const rows=(await client.query('SELECT actor_id FROM v2_workflow_ledger WHERE tenant_id=$1 AND warehouse_id=$2 AND id=$3',[tenant,warehouse,sourceId])).rows;
 if(rows.length)return rows.map(x=>x.actor_id);
 return (await client.query('SELECT DISTINCT a.actor_id FROM audit_logs a JOIN inventory_documents d ON d.tenant_id=a.tenant_id AND d.id=a.document_id WHERE d.tenant_id=$1 AND d.warehouse_id=$2 AND d.id=$3',[tenant,warehouse,sourceId])).rows.map(x=>x.actor_id);
}
