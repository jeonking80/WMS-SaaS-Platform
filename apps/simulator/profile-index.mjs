import {stableId} from './profile-plan.mjs';

// Preserve Array.find's first-match behavior, including on a resumed journal.
export function firstBy(rows,key){const indexed=new Map();for(const row of rows){const value=key(row);if(!indexed.has(value))indexed.set(value,row);}return indexed;}
export function workIndex(operations){
 const byId=new Map(),definitions=new Map(),reservationsByOrder=new Map();
 for(const op of operations){
  byId.set(op.id,op);
  if(op.kind==='event'&&op.status==='done'){
   const event=op.input.event;
   if(event.event_type.endsWith('.create'))definitions.set(event.external_entity_id,event);
   else if(event.event_type==='order.update'&&definitions.has(event.external_entity_id)){const prior=definitions.get(event.external_entity_id);definitions.set(event.external_entity_id,{...prior,payload:event.payload,revision:event.revision});}
  }
  if(op.kind==='command'&&op.input.command==='order.reserve'&&['unsent','unconfirmed','waiting_stock'].includes(op.status)){
   const order=op.input.payload.order_id,list=reservationsByOrder.get(order)??[];list.push(op);reservationsByOrder.set(order,list);
  }
 }
 return {byId,definitions,reservationsByOrder};
}
export function seedsComplete(runId,source,snapshot,seeds,states,idFor=stableId){
 if(!seeds.length)return true;
 const byId=new Map(states.map(row=>[row.id,row]));
 if(!seeds.every(seed=>byId.get(seed.id)?.status==='done'))return false;
 const receipts=firstBy(snapshot?.receipts??[],receipt=>receipt.external_id);
 return seeds.every(seed=>{const receipt=receipts.get(source+':'+seed.input.event.external_entity_id);if(!receipt)return false;const id=idFor(runId+':'+receipt.id+':receipt.putaway');return byId.get(id)?.status==='done';});
}
export function physicalComplete(runId,operations,idFor=stableId){
 const byId=new Map(operations.map(op=>[op.id,op])),done=operations.filter(op=>op.kind==='event'&&op.status==='done'),revisions=new Map();
 for(const op of done){const event=op.input.event;revisions.set(event.external_entity_id,Math.max(revisions.get(event.external_entity_id)??0,event.revision));}
 for(const op of done){
  const event=op.input.event;if(!['order.create','receipt.create'].includes(event.event_type))continue;
  const object=op.result?.result?.id;if(!object)return false;
  const revision=revisions.get(event.external_entity_id)??1,entity=event.event_type==='order.create'&&revision>1?object+':revision:'+revision:object;
  const id=idFor(runId+':'+entity+':'+(event.event_type==='order.create'?'shipment.create':'receipt.putaway'));
  if(byId.get(id)?.status!=='done')return false;
 }
 return true;
}

export const EXPECTED_REVISION_REASONS=['USE_CANCELLATION','CREATE_LINKED_ORDER'];
export function expectedRevisionOutcomes(operations){
 return operations.flatMap(op=>{const event=op.input.event??op.input;return event.event_type==='order.update'?EXPECTED_REVISION_REASONS.map(reason=>({event_id:event.event_id,status:'business_rejected',reason,owner:'profile operator',follow_up:'Preserve the rejected original and existing accepted order; explicit linked addition/cancellation requires separate intent. No automatic replacement.'})):[];});
}
export function qualityEvents(operations){
 return operations.filter(op=>op.kind==='event'&&op.input.phase==='measured').map(op=>{
  const options=op.options??{},event=op.input.event;
  const status=op.status==='done'?'applied':op.status==='expected_business_rejected'?'business_rejected':op.status==='quarantined'?'quarantined':options.last_server_status??op.status;
  return {id:event.event_id,scheduled_offset_ms:op.input.offset_ms,first_sent_at_ms:options.first_sent_at_ms,accepted_at_ms:options.accepted_at_ms,acceptance_latency_ms:options.acceptance_latency_ms,processed_at_ms:options.processed_at_ms,completion_observed_at_ms:options.completion_observed_at_ms,status,reason:op.error??options.last_server_reason??null};
 });
}
export function rejectedRevisionDetails(operations){
 const accepted=new Map(),rejected=[];
 for(const op of operations){
  if(op.kind!=='event')continue;const event=op.input.event;
  if(op.status==='done'&&['receipt.create','order.create','order.update'].includes(event.event_type))accepted.set(event.external_entity_id,event);
  if(op.status!=='expected_business_rejected')continue;
  const prior=accepted.get(event.external_entity_id),lines=event.payload.lines.map(line=>{const previous=prior?.payload.lines.find(row=>line.id?row.id===line.id:row.item_id===line.item_id);return {line_id:line.id??null,item_id:line.item_id,requested_quantity:line.quantity,accepted_source_quantity:previous?.quantity??0,unapplied_delta:line.quantity-(previous?.quantity??0)};});
  rejected.push({event_id:event.event_id,external_entity_id:event.external_entity_id,revision:event.revision,reason:op.error,original_result:op.result,accepted_source_revision:prior?.revision??null,lines,automatic_follow_up:false,basis:'Requested source revision minus the preceding successfully applied source plan in journal ordinal order; WMS quantities are not used.'});
 }
 return rejected;
}
