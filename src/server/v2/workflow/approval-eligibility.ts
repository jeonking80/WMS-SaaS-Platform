import type {Approval,WorkflowState} from './types';

export const approvalRoleAllowed=(role:string)=>role==='admin'||role==='supervisor';

/** Shared by decision, handover and UI; persistent history is hydrated on the server first. */
export function approvalActorExcluded(state:WorkflowState,approval:Approval,actor:string):boolean {
 if(approval.requester_id===actor||approval.origin_actor_ids?.includes(actor))return true;
 if(approval.type==='count'){
  const count=state.counts.find(row=>row.id===approval.target_id);
  return count?.counter_id===actor||count?.counter_ids?.includes(actor)===true;
 }
 if(approval.type==='overage')return [...state.receipts,...state.returns].some(row=>row.lots.some(lot=>lot.id===approval.target_id&&lot.received_by===actor));
 if(approval.type==='receipt.close')return state.receipts.find(row=>row.id===approval.target_id)?.lots.some(lot=>lot.received_by===actor)===true;
 return false;
}

type Candidate={userId:string;role:string;status:string;warehouseIds:string[];scopes?:string[]};
/** A snapshot only guides choices. The transaction rechecks current authority and history. */
export function approvalAssigneeEligible(state:WorkflowState,approval:Approval,candidate:Candidate,warehouse:string):boolean {
 return approval.status==='pending'&&candidate.status==='active'&&candidate.warehouseIds.includes(warehouse)&&approvalRoleAllowed(candidate.role)
  &&(!candidate.userId.startsWith('machine:')||(candidate.role==='supervisor'&&candidate.scopes?.includes('approve')===true))
  &&!approvalActorExcluded(state,approval,candidate.userId);
}
