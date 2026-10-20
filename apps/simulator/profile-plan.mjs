import {createHash} from 'node:crypto';
import {seeded} from './planner.mjs';
export function stableId(value){const hex=createHash('sha256').update(value).digest('hex').slice(0,32);return `${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20)}`;}
export function profilePlan(runId,kind,catalog,source,warehouse,seed,business={}){
 if(!['congestion','shift','smoke','shift-smoke'].includes(kind))throw Error('Unknown profile');if(!catalog.length)throw Error('Catalog required');const random=seeded(seed),events=[],orders=[];
 const add=(type,ordinal,offset,phase,payload,external,revision=1)=>{const entity=external??`${runId}:${type}:${ordinal}`,event={schema_version:'2.0',event_id:stableId(`${runId}:${ordinal}:${phase}`),source_system:source,external_entity_id:entity,revision,event_type:type,occurred_at:new Date().toISOString(),correlation_id:runId,run_id:runId,warehouse_id:warehouse,payload:{...(type==='receipt.create'?{supplier_id:business.supplier_id,expected_at:business.expected_at}:{}),...(type==='order.create'?{delivery:{partner_id:business.customer_id,delivery_destination_id:business.destination_id},due_at:business.due_at}:{}),...payload}};events.push({id:stableId(runId+':op:'+phase+':'+ordinal),kind:'event',label:type,role:'source',offset_ms:offset,phase,input:event});return event;};
 const lines=(prefix,max=5)=>{const count=1+Math.floor(random()*max),chosen=new Set(),result=[];while(result.length<Math.min(count,catalog.length)){const item=catalog[Math.floor(random()*catalog.length)];if(chosen.has(item.item_id))continue;chosen.add(item.item_id);result.push({id:stableId(prefix+':line:'+result.length),item_id:item.item_id,quantity:1+Math.floor(random()*5)});}return result;};
 if(kind==='shift'||kind==='shift-smoke'){
  const orderCount=kind==='shift'?1000:4,receiptCount=kind==='shift'?100:2,duration=kind==='shift'?28800000:Number(business.smoke_duration_ms??15000);
  if(!business.baseline)for(let i=0;i<catalog.length;i++)add('receipt.create',i,0,'seed',{lines:[{id:stableId(runId+':seedline:'+i),item_id:catalog[i].item_id,quantity:10000}]});
  for(let i=0;i<orderCount;i++)add('order.create',i,i*duration/orderCount,'measured',{lines:lines(runId+':order:'+i)});
  for(let i=0;i<receiptCount;i++)add('receipt.create',orderCount+i,i*duration/receiptCount,'measured',{lines:[{id:stableId(runId+':receiptline:'+i),item_id:catalog[i%catalog.length].item_id,quantity:1000}]});
  return {duration_ms:duration,events:events.sort((a,b)=>a.phase==='seed'&&b.phase!=='seed'?-1:b.phase==='seed'&&a.phase!=='seed'?1:a.offset_ms-b.offset_ms),unique_measured:orderCount+receiptCount,orders:orderCount,receipts:receiptCount};
 }
 if(kind==='congestion')for(let i=0;i<catalog.length;i++)add('receipt.create',i,0,'seed',{lines:[{id:stableId(runId+':seedline:'+i),item_id:catalog[i].item_id,quantity:10000}]},runId+':seed:receipt:'+i);
 const schedules=kind==='congestion'?[...Array.from({length:600},(_,i)=>i*1000),...Array.from({length:1500},(_,i)=>600000+i*200),...Array.from({length:600},(_,i)=>900000+i*1000)]:Array.from({length:20},(_,i)=>i*100);
 for(const [i,offset]of schedules.entries()){
  if(i%10<7){const e=add('order.create',i,offset,'measured',{lines:lines(runId+':order:'+i)});orders.push({event:e,revision:1});}
  else if(i%10<9){const entry=catalog[Math.floor(random()*catalog.length)];add('receipt.create',i,offset,'measured',{lines:[{id:stableId(runId+':receiptline:'+i),item_id:entry.item_id,quantity:1000}]});}
  else{const order=orders.at(-1);order.revision++;add('order.update',i,offset,'measured',{lines:order.event.payload.lines.map(x=>({...x,quantity:x.quantity+1}))},order.event.external_entity_id,order.revision);}
 }
 return {duration_ms:kind==='congestion'?1500000:2000,events,unique_measured:schedules.length,orders:schedules.length*0.7,receipts:schedules.length*0.2,updates:schedules.length*0.1};
}
