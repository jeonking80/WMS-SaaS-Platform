import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { applyCommand as pureApplyCommand, applyOwnedCommand, snapshot, reconcile } from '../../src/server/v2/workflow/engine';
import {ownDetachedWorkflowState} from '../../src/server/v2/workflow/owned-state';
import { emptyState, type WorkflowContext, type WorkflowState } from '../../src/server/v2/workflow/types';


const successfulCommands=new Set<string>();
function applyCommand(original:WorkflowState,command:string,payload:Record<string,unknown>,context:WorkflowContext){
 const before=structuredClone(original),ids:string[]=[];let ordinary:ReturnType<typeof pureApplyCommand>|undefined,ordinaryError:unknown;
 try{ordinary=pureApplyCommand(original,command,payload,{...context,id:()=>{const id=context.id();ids.push(id);return id;}});}catch(error){ordinaryError=error;}
 expect(original).toEqual(before);
 const draft=structuredClone(before),ownership=ownDetachedWorkflowState(draft);let used=0,owned:ReturnType<typeof applyOwnedCommand>|undefined,ownedError:unknown;
 try{owned=applyOwnedCommand(ownership,command,structuredClone(payload),{...context,id:()=>{expect(used).toBeLessThan(ids.length);return ids[used++];}});}catch(error){ownedError=error;}
 expect(used).toBe(ids.length);
 expect(()=>applyOwnedCommand(ownership,command,payload,context)).toThrow('Workflow state ownership unavailable');
 if(ordinaryError){expect(ownedError).toBeInstanceOf((ordinaryError as Error).constructor);expect((ownedError as Error).message).toBe((ordinaryError as Error).message);throw ordinaryError;}
 expect(ownedError).toBeUndefined();expect(owned!.state).toBe(draft);expect({state:owned!.state,result:owned!.result}).toEqual(ordinary);expect(owned!.previousStock).toEqual(before.stock);successfulCommands.add(command);return ordinary!;
}

function world() {
 const item=randomUUID(),receiving=randomUUID(),storage=randomUUID(),staging=randomUUID(),hold=randomUUID(),actor=randomUUID(),other=randomUUID();
 const context:WorkflowContext={actor:{id:actor,role:'worker'},request_id:randomUUID(),command:'',now:'2026-10-20T12:00:00.000Z',id:randomUUID,items:[{id:item,active:true}],locations:[{id:receiving,active:true,kind:'RECEIVING'},{id:storage,active:true,kind:'STORAGE'},{id:staging,active:true,kind:'STAGING'},{id:hold,active:true,kind:'HOLD'}]};
 let state=emptyState();
 const command=(name:string,payload:Record<string,unknown>,manager=false)=>{const r=applyCommand(state,name,payload,{...context,request_id:randomUUID(),actor:manager?{id:other,role:'supervisor'}:context.actor});state=r.state;return r.result;};
 const stock=()=>snapshot(state).stock.filter(x=>x.item_id===item).reduce((a,x)=>({S:a.S+x.S,R:a.R+x.R,P:a.P+x.P,Q:a.Q+x.Q,B:a.B+x.B,A:a.A+x.A,H:a.H+x.H}),{S:0,R:0,P:0,Q:0,B:0,A:0,H:0});
 const seed=(q:number)=>{const r=command('receipt.create',{lines:[{item_id:item,quantity:q}]}).id;const line=state.receipts.find(x=>x.id===r)!.lines[0];command('receipt.receive',{receipt_id:r,lines:[{line_id:line.id,quantity:q,location_id:receiving}]});const lot=state.receipts.find(x=>x.id===r)!.lots[0];command('receipt.inspect',{receipt_id:r,lines:[{lot_id:lot.id,quantity:q,outcome:'normal'}]});command('receipt.putaway',{receipt_id:r,lines:[{lot_id:lot.id,quantity:q,location_id:storage}]});};
 const pick=(q:number)=>{const id=command('order.create',{lines:[{item_id:item,quantity:q}]}).id;command('order.reserve',{order_id:id,partial:false});const o=state.orders.find(x=>x.id===id)!;command('order.pick',{order_id:id,lines:[{reservation_id:o.reservations[0].id,quantity:q,location_id:staging}]});return id;};
 return{item,receiving,storage,staging,hold,context,command,stock,seed,pick,get state(){return state;}};
}

describe('v2 workflow conservation and exception transitions',()=>{
 it('preserves input on a late-line failure and prevents partial stock effects',()=>{const w=world();w.seed(10);const destination=randomUUID();w.context.locations.push({id:destination,active:true,kind:'STORAGE'});const before=structuredClone(w.state);expect(()=>w.command('stock.move',{reason:'Two lines',lines:[{item_id:w.item,from_location_id:w.storage,location_id:destination,quantity:2},{item_id:w.item,from_location_id:w.storage,location_id:destination,quantity:20}]})).toThrow();expect(w.state).toEqual(before);});
 it('keeps the order during damaged pick replacement and ships only ten good pieces (AC23)',()=>{const w=world();w.seed(12);const id=w.pick(10);let o=w.state.orders.find(x=>x.id===id)!;w.command('order.damage',{order_id:id,reason:'Broken',lines:[{pick_id:o.picks[0].id,quantity:2,location_id:w.hold}]},true);expect(w.stock()).toMatchObject({S:2,P:8,B:2,H:12});w.command('order.reserve',{order_id:id,partial:false});o=w.state.orders.find(x=>x.id===id)!;const r=o.reservations.find(x=>x.quantity===2)!;w.command('order.pick',{order_id:id,lines:[{reservation_id:r.id,quantity:2,location_id:w.staging}]});o=w.state.orders.find(x=>x.id===id)!;const pack=w.command('package.create',{order_id:id,lines:o.picks.map(x=>({pick_id:x.id,quantity:x.active}))}).id;w.command('shipment.create',{package_ids:[pack],handover_by:'Driver',carrier:'Virtual'});expect(w.stock()).toMatchObject({S:0,P:0,B:2,H:2});o=w.state.orders.find(x=>x.id===id)!;expect(o.lines[0]).toMatchObject({quantity:10,cancelled:0,shipped:10});expect(o.picks.reduce((n,p)=>n+p.quantity,0)).toBe(12);expect(reconcile(w.state).ok).toBe(true);});
 it('keeps cancellation pending until unpack and physical return',()=>{const w=world();w.seed(5);const id=w.pick(5);const o=w.state.orders.find(x=>x.id===id)!;const pack=w.command('package.create',{order_id:id,lines:[{pick_id:o.picks[0].id,quantity:5}]}).id;w.command('order.cancel',{order_id:id,lines:[{line_id:o.lines[0].id,quantity:5}],reason:'Customer'});expect(()=>w.command('shipment.create',{package_ids:[pack],handover_by:'Driver',carrier:'Virtual'})).toThrow('CANCELLATION_PENDING');expect(w.stock()).toMatchObject({A:0,P:5,H:5});w.command('package.unpack',{package_id:pack,reason:'Cancel'});w.command('order.return_picked',{order_id:id,lines:[{pick_id:o.picks[0].id,quantity:5,location_id:w.storage,outcome:'normal'}],reason:'Returned'});expect(w.stock()).toMatchObject({A:5,P:0,H:5});expect(w.state.orders[0].lines[0].cancelled).toBe(5);});
 it('protects count locks and prevents the original counter approving through a different submitter',()=>{const w=world();w.seed(10);const id=w.command('count.start',{location_id:w.storage}).id;expect(w.stock()).toMatchObject({S:10,H:10,A:0});w.command('count.record',{count_id:id,lines:[{item_id:w.item,bucket:'S',quantity:8}],recount:true,reason:'Verified'});const a=w.command('count.submit',{count_id:id,reason:'Verified'}).id;const original=structuredClone(w.state);expect(()=>applyCommand(original,'approval.decide',{approval_id:a,approve:true,reason:'Self'},{...w.context,actor:{id:w.context.actor.id,role:'admin'}})).toThrow('SELF_APPROVAL_FORBIDDEN');w.command('approval.decide',{approval_id:a,approve:true,reason:'Count reviewed'},true);expect(w.stock()).toMatchObject({S:8,H:8,A:8});});
 it('blocks stale count approval after force unlock',()=>{const w=world();w.seed(10);const id=w.command('count.start',{location_id:w.storage}).id;w.command('count.record',{count_id:id,lines:[{item_id:w.item,bucket:'S',quantity:8}],recount:true});const a=w.command('count.submit',{count_id:id,reason:'Count'}).id;w.command('count.unlock',{count_id:id,reason:'Restart'},true);expect(()=>w.command('approval.decide',{approval_id:a,approve:true,reason:'Old'},true)).toThrow('APPROVAL_STALE');expect(w.stock()).toMatchObject({S:10,H:10,A:10});});
 it('releases normal stock holds through inspection and putaway without changing H',()=>{const w=world();w.seed(10);const held=w.command('stock.hold',{lines:[{item_id:w.item,from_location_id:w.storage,location_id:w.hold,quantity:3}],reason:'Quality check'});const lot=(held.lot_ids as string[])[0];expect(w.stock()).toMatchObject({S:7,B:3,H:10});w.command('hold.release',{lot_id:lot,quantity:3,location_id:w.receiving,reason:'Review'});const released=w.state.holds.find(x=>x.pending===3)!;w.command('stock.inspect',{lines:[{lot_id:released.id,quantity:3,outcome:'normal'}]});w.command('stock.putaway',{lines:[{lot_id:released.id,quantity:3,location_id:w.storage}]});expect(w.stock()).toMatchObject({S:10,B:0,Q:0,H:10});});
 it('rejects missing/incorrect item scans without changing the reservation',()=>{const w=world();w.seed(10);const id=w.command('order.create',{lines:[{item_id:w.item,quantity:5}]}).id;w.command('order.reserve',{order_id:id,partial:false});const r=w.state.orders[0].reservations[0];const before=structuredClone(w.state);expect(()=>w.command('order.pick',{order_id:id,lines:[{reservation_id:r.id,quantity:5,location_id:w.staging,scanned_item_id:randomUUID()}]})).toThrow('WRONG_ITEM_SCAN');expect(w.state).toEqual(before);});
 it('supports a persisted baseline with only current-command ledger deltas',()=>{const w=world();w.seed(10);const compact:WorkflowState={...structuredClone(w.state),ledger:[],ledger_base:structuredClone(w.state.stock)};const after=applyCommand(compact,'order.create',{lines:[{item_id:w.item,quantity:1}]},w.context);expect(reconcile(after.state).ok).toBe(true);expect(after.state.ledger).toEqual([]);});
 it('blocks a shortage location before releasing reservations and restores availability only after count approval',()=>{const w=world();w.seed(10);const id=w.command('order.create',{lines:[{item_id:w.item,quantity:5}]}).id;w.command('order.reserve',{order_id:id,partial:false});const r=w.state.orders[0].reservations[0];w.command('order.shortage',{order_id:id,lines:[{reservation_id:r.id,quantity:5}],reason:'One piece missing'});expect(w.stock()).toMatchObject({S:10,R:0,A:0,H:10});expect(()=>w.command('order.reserve',{order_id:id,partial:false})).toThrow('INSUFFICIENT_STOCK');const c=w.command('count.start',{location_id:w.storage}).id;w.command('count.record',{count_id:c,lines:[{item_id:w.item,bucket:'S',quantity:9}],recount:true});const a=w.command('count.submit',{count_id:c,reason:'Confirmed one missing'}).id;w.command('approval.decide',{approval_id:a,approve:true,reason:'Independent approval'},true);expect(w.stock()).toMatchObject({S:9,A:9,H:9});w.command('order.reserve',{order_id:id,partial:false});expect(w.stock()).toMatchObject({R:5,A:4});});
 it('preserves the original order quantity after work begins and links additional demand',()=>{const w=world();w.seed(10);const id=w.command('order.create',{lines:[{item_id:w.item,quantity:5}]}).id;const line=w.state.orders[0].lines[0];w.command('order.update',{order_id:id,lines:[{id:line.id,item_id:w.item,quantity:4}]});expect(w.state.orders[0].lines[0].quantity).toBe(4);w.command('order.reserve',{order_id:id,partial:false});expect(()=>w.command('order.update',{order_id:id,lines:[{id:line.id,item_id:w.item,quantity:6}]})).toThrow('CREATE_LINKED_ORDER');const extra=w.command('order.create',{original_order_id:id,lines:[{item_id:w.item,quantity:2}]}).id;expect(w.state.orders.find(x=>x.id===extra)?.original_order_id).toBe(id);});
 it('accepts a complete location count in several batches while rejecting incomplete submission',()=>{const w=world();const ctx={...w.context,items:Array.from({length:21},()=>({id:randomUUID(),active:true}))};let state=emptyState();state.stock=ctx.items.map(i=>({item_id:i.id,location_id:w.storage,S:1,R:0,P:0,Q:0,B:0}));state.ledger_base=structuredClone(state.stock);const start=applyCommand(state,'count.start',{location_id:w.storage},ctx);state=start.state;const id=start.result.id;state=applyCommand(state,'count.record',{count_id:id,lines:ctx.items.slice(0,20).map(i=>({item_id:i.id,bucket:'S',quantity:1})),recount:false},ctx).state;expect(()=>applyCommand(state,'count.submit',{count_id:id,reason:'Complete'},ctx)).toThrow('INCOMPLETE_COUNT');state=applyCommand(state,'count.record',{count_id:id,lines:[{item_id:ctx.items[20].id,bucket:'S',quantity:1}],recount:false},ctx).state;expect(applyCommand(state,'count.submit',{count_id:id,reason:'Complete'},ctx).state.counts[0].status).toBe('submitted');});

 it.each([
  {status:'unlocked',versionOffset:0},
  {status:'completed',versionOffset:0},
  {status:'counting',versionOffset:0},
  {status:'submitted',versionOffset:1},
 ] as const)('records stale count rejection without changing $status target at version offset $versionOffset',({status,versionOffset})=>{
  const w=world();w.seed(10);
  const id=w.command('count.start',{location_id:w.storage}).id;
  w.command('count.record',{count_id:id,lines:[{item_id:w.item,bucket:'S',quantity:8}],recount:true,reason:'Counted independently'});
  const approval=w.command('count.submit',{count_id:id,reason:'Two missing'}).id;
  // Legacy persisted combinations exercise status and version guards separately.
  // The real unlock/move path is covered by the PostgreSQL acceptance scenario.
  const original=structuredClone(w.state),count=original.counts.find(c=>c.id===id)!;
  count.status=status;count.version+=versionOffset;
  const savedCount=structuredClone(count);
  const after=applyCommand(original,'approval.decide',{approval_id:approval,approve:false,reason:'Close obsolete approval history'},{...w.context,actor:{id:randomUUID(),role:'supervisor'}}).state;
  expect(after.approvals.find(a=>a.id===approval)).toMatchObject({status:'rejected',decision_reason:'Close obsolete approval history'});
  expect(after.counts.find(c=>c.id===id)).toEqual(savedCount);
  expect(after.stock).toEqual(original.stock);expect(after.ledger).toEqual(original.ledger);
  expect(original.approvals.find(a=>a.id===approval)?.status).toBe('pending');
  expect(reconcile(after).ok).toBe(true);
 });
 it('returns only the current submitted count to counting on rejection and accepts a fresh recount',()=>{
  const w=world();w.seed(10);
  const id=w.command('count.start',{location_id:w.storage}).id;
  w.command('count.record',{count_id:id,lines:[{item_id:w.item,bucket:'S',quantity:8}],recount:true,reason:'First recount'});
  const approval=w.command('count.submit',{count_id:id,reason:'Two missing'}).id;
  const before=structuredClone(w.state.counts.find(c=>c.id===id)!);
  w.command('approval.decide',{approval_id:approval,approve:false,reason:'Recount again'},true);
  expect(w.state.counts.find(c=>c.id===id)).toEqual({...before,status:'counting',version:before.version+1});
  expect(w.stock()).toMatchObject({S:10,H:10,A:0});
  w.command('count.record',{count_id:id,lines:[{item_id:w.item,bucket:'S',quantity:9}],recount:true,reason:'Fresh recount confirms one missing'});
  const current=w.command('count.submit',{count_id:id,reason:'One missing'}).id;
  w.command('approval.decide',{approval_id:current,approve:true,reason:'Independent fresh-count approval'},true);
  expect(w.stock()).toMatchObject({S:9,H:9,A:9});expect(reconcile(w.state).ok).toBe(true);
 });

});


describe('correction approval across inventory-neutral shift reports',()=>{
 function close(w:ReturnType<typeof world>){
  const pending=[...w.state.approvals.filter(a=>a.status==='pending').map(a=>({object_type:'approval',object_id:a.id})),...w.state.orders.filter(o=>o.lines.some(l=>l.quantity>l.shipped+l.cancelled)).map(o=>({object_type:'order',object_id:o.id})),...w.state.holds.filter(l=>l.hold+l.pending+l.normal>0).map(l=>({object_type:'hold',object_id:l.id})),...w.state.counts.filter(c=>c.status==='counting').map(c=>({object_type:'count',object_id:c.id}))];
  return w.command('shift.close',{handover:pending.map(row=>({...row,assignee_id:randomUUID(),reason:'Preserve unfinished work'})),unconfirmed_request_ids:[]},true);
 }
 function request(w:ReturnType<typeof world>){return w.command('correction.request',{original_id:randomUUID(),lines:[{item_id:w.item,location_id:w.storage,bucket:'S',quantity:-2}],reason:'Recorded two excess pieces'}).id;}
 it('keeps the frozen target version and permits two consecutive shifts before independent review',()=>{
  const w=world();w.seed(10);const id=request(w),target=w.state.approvals[0].target_version,stock=structuredClone(w.state.stock);close(w);close(w);
  expect(w.state.approvals[0].target_version).toBe(target);expect(w.state.stock).toEqual(stock);
  w.command('approval.decide',{approval_id:id,approve:true,reason:'Independent review after handover'},true);expect(w.stock()).toMatchObject({S:8,H:8});
 });
 it.each(['physical','assignment','force-unlock'])('does not revive a correction across an intervening %s version',kind=>{
  const w=world();w.seed(10);const id=request(w);close(w);
  if(kind==='physical')w.command('stock.hold',{lines:[{item_id:w.item,from_location_id:w.storage,location_id:w.hold,quantity:1}],reason:'New physical effect'});
  if(kind==='assignment')w.command('task.assign',{object_type:'receipt',object_id:w.state.receipts[0].id,assignee_id:randomUUID(),reason:'Separate command'} ,true);
  if(kind==='force-unlock'){const count=w.command('count.start',{location_id:w.storage}).id;w.command('count.unlock',{count_id:count,reason:'Force restart'},true);}
  close(w);const before=structuredClone(w.state);expect(()=>w.command('approval.decide',{approval_id:id,approve:true,reason:'Old review'},true)).toThrow('APPROVAL_STALE');expect(w.state).toEqual(before);
 });
 it('fails closed when a required historical shift version is absent',()=>{
  const w=world();w.seed(10);const id=request(w);close(w);delete w.state.shifts[0].version;
  expect(()=>w.command('approval.decide',{approval_id:id,approve:true,reason:'Incomplete history'},true)).toThrow('APPROVAL_STALE');
 });
});


it('matches owned and pure complete graphs across the remaining document lifecycle commands',()=>{
 const w=world();
 const id=w.command('receipt.create',{lines:[{item_id:w.item,quantity:1}]}).id;
 w.command('receipt.update',{receipt_id:id,lines:[{id:w.state.receipts[0].lines[0].id,item_id:w.item,quantity:2}],expected_at:'2026-11-01T00:00:00Z'});
 w.command('receipt.receive',{receipt_id:id,reason:'One excess physical unit',lines:[{line_id:w.state.receipts[0].lines[0].id,quantity:3,location_id:w.receiving,hold_location_id:w.hold}]});
 const excess=w.state.receipts[0].lots.find(l=>l.overage)!;
 let approval=w.command('overage.request',{lot_id:excess.id,quantity:1,reason:'Independent excess review'}).id;
 w.command('approval.decide',{approval_id:approval,approve:true,reason:'Accept original physical excess'},true);
 w.command('hold.release',{lot_id:excess.id,quantity:1,location_id:w.receiving,reason:'Physical excess release'});
 for(const lot of w.state.receipts[0].lots){w.command('receipt.inspect',{receipt_id:id,lines:[{lot_id:lot.id,quantity:lot.pending,outcome:'normal'}]});w.command('receipt.putaway',{receipt_id:id,lines:[{lot_id:lot.id,quantity:w.state.receipts[0].lots.find(l=>l.id===lot.id)!.normal,location_id:w.storage}]});}
 approval=w.command('receipt.close.request',{receipt_id:id,reason:'Close zero remainder explicitly'}).id;w.command('approval.decide',{approval_id:approval,approve:true,reason:'Independent close'},true);
 const cancelled=w.command('receipt.create',{lines:[{item_id:w.item,quantity:1}]}).id;w.command('receipt.cancel',{receipt_id:cancelled,reason:'Unreceived intent withdrawn'});
 const second=randomUUID();w.context.locations.push({id:second,active:true,kind:'STORAGE'});w.command('stock.move',{reason:'Explicit physical move',lines:[{item_id:w.item,from_location_id:w.storage,location_id:second,quantity:1}]});w.command('stock.move',{reason:'Explicit physical return',lines:[{item_id:w.item,from_location_id:second,location_id:w.storage,quantity:1}]});
 const order=w.command('order.create',{lines:[{item_id:w.item,quantity:2}]}).id;w.command('order.reserve',{order_id:order,partial:false});w.command('order.release',{order_id:order,lines:[{reservation_id:w.state.orders[0].reservations[0].id,quantity:1}]});w.command('order.reserve',{order_id:order,partial:false});
 w.command('order.pick',{order_id:order,lines:w.state.orders[0].reservations.filter(r=>r.quantity>0).map(r=>({reservation_id:r.id,quantity:r.quantity,location_id:w.staging}))});
 const pack=w.command('package.create',{order_id:order,lines:w.state.orders[0].picks.map(p=>({pick_id:p.id,quantity:p.active}))}).id;
 const shipment=w.command('shipment.create',{package_ids:[pack],carrier:'Fixture',handover_by:'Independent carrier'}).id;
 w.command('shipment.delivery',{shipment_id:shipment,revision:1,status:'in_transit'});w.command('shipment.delivery.correct',{shipment_id:shipment,previous_revision:1,revision:2,status:'delivered',reason:'Independent physical delivery confirmation'},true);
 const ret=w.command('return.request',{shipment_id:shipment,lines:[{shipment_line_id:w.state.shipments[0].lines[0].id,quantity:1}],reason:'Actual customer request'}).id;
 w.command('return.receive',{return_id:ret,lines:[{line_id:w.state.returns[0].lines[0].id,quantity:1,location_id:w.receiving}]});const lot=w.state.returns[0].lots[0].id;
 w.command('return.inspect',{return_id:ret,lines:[{lot_id:lot,quantity:1,outcome:'normal'}]});w.command('return.putaway',{return_id:ret,lines:[{lot_id:lot,quantity:1,location_id:w.storage}]});w.command('return.close',{return_id:ret,reason:'No further unreceived return remainder'});
});

it.each(['approval.decide', 'correction.request', 'count.record', 'count.start', 'count.submit', 'count.unlock', 'hold.release', 'order.cancel', 'order.create', 'order.damage', 'order.pick', 'order.release', 'order.reserve', 'order.return_picked', 'order.shortage', 'order.update', 'overage.request', 'package.create', 'package.unpack', 'receipt.cancel', 'receipt.close.request', 'receipt.create', 'receipt.inspect', 'receipt.putaway', 'receipt.receive', 'receipt.update', 'return.close', 'return.inspect', 'return.putaway', 'return.receive', 'return.request', 'shift.close', 'shipment.create', 'shipment.delivery', 'shipment.delivery.correct', 'stock.hold', 'stock.inspect', 'stock.move', 'stock.putaway', 'task.assign'])('retains missing-input error and public immutability for %s',command=>{const w=world();expect(()=>applyCommand(w.state,command,{},w.context)).toThrow();});

afterAll(()=>expect([...successfulCommands].sort()).toEqual(['approval.decide', 'correction.request', 'count.record', 'count.start', 'count.submit', 'count.unlock', 'hold.release', 'order.cancel', 'order.create', 'order.damage', 'order.pick', 'order.release', 'order.reserve', 'order.return_picked', 'order.shortage', 'order.update', 'overage.request', 'package.create', 'package.unpack', 'receipt.cancel', 'receipt.close.request', 'receipt.create', 'receipt.inspect', 'receipt.putaway', 'receipt.receive', 'receipt.update', 'return.close', 'return.inspect', 'return.putaway', 'return.receive', 'return.request', 'shift.close', 'shipment.create', 'shipment.delivery', 'shipment.delivery.correct', 'stock.hold', 'stock.inspect', 'stock.move', 'stock.putaway', 'task.assign']));


it('retains ordinary structured-clone metadata semantics instead of a JSON round trip',()=>{
 const w=world(),state=emptyState() as WorkflowState&{future?:unknown};
 state.future={date:new Date('2026-10-21T00:00:00Z'),optional:undefined,negativeZero:-0,integer:1n,map:new Map([['retained',1]])};
 const result=applyCommand(state,'receipt.create',{lines:[{item_id:w.item,quantity:1}]},w.context);
 expect((result.state as typeof state).future).toEqual(state.future);expect((result.state as typeof state).future).not.toBe(state.future);
});
