import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {firstBy,workIndex,seedsComplete,physicalComplete,expectedRevisionOutcomes,qualityEvents,rejectedRevisionDetails} from '../profile-index.mjs';
import {stableId} from '../profile-plan.mjs';
import {openStore} from '../store.mjs';
import {shiftWorkAllowed} from '../shift-profile.mjs';

const event=(id,type,external,revision,status='done',object=id)=>({id,kind:'event',status,input:{phase:'measured',event:{event_type:type,external_entity_id:external,revision,payload:{lines:[{quantity:revision}]}}},result:{result:{id:object}}});
const command=(id,stage,order,status='unsent')=>({id,kind:'command',status,input:{command:stage,payload:{order_id:order}}});

test('seed readiness hashes once per seed and reads fresh statuses even when startup definitions are unsent',()=>{
 const seeds=Array.from({length:100},(_,i)=>({...event('seed-'+i,'receipt.create','seed-'+i,1,'unsent'),input:{phase:'seed',event:{external_entity_id:'seed-'+i}}}));
 const receipts=seeds.map((seed,i)=>({id:'receipt-'+i,external_id:'SOURCE:'+seed.input.event.external_entity_id}));
 const states=[...Array.from({length:10000},(_,i)=>({id:'unrelated-'+i,status:'done'})),...seeds.map(seed=>({id:seed.id,status:'done'})),...receipts.map(receipt=>({id:stableId('run:'+receipt.id+':receipt.putaway'),status:'done'}))];
 let hashes=0;const hash=value=>{hashes++;return stableId(value);};
 assert.equal(seedsComplete('run','SOURCE',{receipts},seeds,states,hash),true);assert.equal(hashes,100);
 states.at(-1).status='unconfirmed';assert.equal(seedsComplete('run','SOURCE',{receipts},seeds,states),false);
 states.at(-1).status='done';states.find(row=>row.id==='seed-1').status='unconfirmed';hashes=0;
 assert.equal(seedsComplete('run','SOURCE',{receipts},seeds,states,hash),false);assert.equal(hashes,0);
 assert.equal(seedsComplete('run','SOURCE',null,[],[]),true);
});

test('completion requires the latest applied revision and exact physical final stage, including after resume',()=>{
 const create=event('e1','order.create','ORDER',1,'done','order'),update=event('e2','order.update','ORDER',2),rejected=event('e3','order.update','ORDER',3,'expected_business_rejected');
 const old=command(stableId('run:order:shipment.create'),'shipment.create','order','done');
 const operations=[create,update,rejected,old,...Array.from({length:10000},(_,i)=>command('other-'+i,'order.reserve','other','done'))];
 let hashes=0;const hash=value=>{hashes++;return stableId(value);};
 assert.equal(physicalComplete('run',operations,hash),false);assert.equal(hashes,1);
 operations.push(command(stableId('run:order:revision:2:shipment.create'),'shipment.create','order','done'));
 assert.equal(physicalComplete('run',JSON.parse(JSON.stringify(operations))),true);
 operations.at(-1).status='unconfirmed';assert.equal(physicalComplete('run',operations),false);
 const receipt=event('r1','receipt.create','RECEIPT',1,'done','receipt');
 assert.equal(physicalComplete('run',[receipt]),false);
 assert.equal(physicalComplete('run',[receipt,command(stableId('run:receipt:receipt.putaway'),'receipt.putaway',null,'done')]),true);
 receipt.result=null;assert.equal(physicalComplete('run',[receipt]),false);
});

test('work indices preserve ordinal revisions, reserve supersession candidates, first-match metadata and fresh status changes',()=>{
 const operations=[event('create','order.create','ORDER',1),command('old','order.reserve','order','waiting_stock'),event('update','order.update','ORDER',2),command('current','order.reserve','order','unconfirmed'),command('done','order.reserve','order','done'),command('other','order.reserve','different','unsent'),event('rejected','order.update','ORDER',3,'expected_business_rejected')];
 const indexed=workIndex(operations);assert.equal(indexed.definitions.get('ORDER').revision,2);assert.equal(indexed.definitions.get('ORDER').event_type,'order.create');assert.deepEqual(indexed.definitions.get('ORDER').payload,{lines:[{quantity:2}]});
 assert.deepEqual(indexed.reservationsByOrder.get('order').map(op=>op.id),['old','current']);assert.equal(indexed.byId.get('old'),operations[1]);
 operations[1].status='superseded';assert.deepEqual(workIndex(operations).reservationsByOrder.get('order').map(op=>op.id),['current']);
 const first={id:'item',label:'first'},second={id:'item',label:'second'};assert.equal(firstBy([first,second],row=>row.id).get('item'),first);
});

test('narrow SQLite readers preserve due-event ordinal order, retry boundaries, FULL durability and restart state',()=>{
 const directory=mkdtempSync(join(tmpdir(),'profile-index-')),path=join(directory,'journal.sqlite');let store;
 try{
  store=openStore(path);
  const ops=Array.from({length:35},(_,i)=>({id:'op-'+i,kind:i===34?'command':'event',label:'planned',role:'source',input:{phase:i<2?'seed':'measured',offset_ms:i<2?0:100,event:{event_id:'event-'+i}}}));
  store.create({id:'run',config:{baseline:{expected_positions:Array(1600).fill({S:312})}},target:{source_system:'SOURCE'}},ops);
  assert.equal(store.hasRun('run'),true);assert.equal(store.hasRun('absent'),false);assert.deepEqual(store.context('run'),{});
  assert.deepEqual(store.readyEvents('run',1000,undefined).map(op=>op.id),['op-0','op-1']);
  assert.deepEqual(store.readyEvents('run',1099,1000).map(op=>op.id),['op-0','op-1']);
  assert.deepEqual(store.readyEvents('run',1100,1000).map(op=>op.id),ops.slice(0,20).map(op=>op.id));
  for(const [id,status]of [['op-0','done'],['op-1','quarantined'],['op-2','superseded'],['op-3','expected_business_rejected']])store.updateOp(id,{status});
  store.updateOp('op-4',{status:'unconfirmed',attempts:3,next_at:1101,result:{id:'saved-event'}});
  assert.equal(store.hasUnconfirmedEvents('run'),true);assert.equal(store.hasUnconfirmedEvents('absent'),false);
  assert.deepEqual(store.readyEvents('run',1100,1000,2).map(op=>op.id),['op-5','op-6']);
  store.updateRun('run',{context:{measured_start:1000,shift:{pinned_order_id:'order'}}});
  assert.equal(store.db.prepare('PRAGMA synchronous').get().synchronous,2);assert.equal(store.db.prepare('PRAGMA journal_mode').get().journal_mode,'wal');
  store.close();store=openStore(path);
  const restored=store.readyEvents('run',1101,store.context('run').measured_start,1)[0];
  assert.equal(restored.id,'op-4');assert.equal(restored.attempts,3);assert.equal(restored.next_at,1101);assert.deepEqual(restored.result,{id:'saved-event'});assert.deepEqual(restored.input,ops[4].input);
  const original=store.operations('run').filter(op=>op.kind==='event'&&!new Set(['done','expected_business_rejected','superseded']).has(op.status)&&op.status!=='quarantined'&&op.next_at<=1101&&(op.input.phase==='seed'||1101>=1000+op.input.offset_ms)).slice(0,20);
  assert.deepEqual(store.readyEvents('run',1101,1000),original);
  assert.deepEqual(store.operationStates('run').map(row=>[row.id,row.status]),store.operations('run').map(row=>[row.id,row.status]));
  store.updateOp('op-4',{status:'done'});assert.equal(store.hasUnconfirmedEvents('run'),false);
  assert.equal(store.operationStates('run').find(op=>op.id==='op-4').status,'done');
 }finally{store?.close();rmSync(directory,{recursive:true,force:true});}
});

test('shift task selection uses one fresh shift context while retaining the three-argument compatibility path',()=>{
 const runtime={id:'run',shiftPolicy:{}},operation={input:{command:'order.pick',payload:{order_id:'order'}}};
 const store={run:()=>({context:{shift:{pinned_order_id:'order'}}})};
 assert.equal(shiftWorkAllowed(runtime,operation,store),false);
 assert.equal(shiftWorkAllowed(runtime,operation,{run(){throw Error('unexpected full metadata read');}},{pinned_order_id:'order'}),false);
 assert.equal(shiftWorkAllowed(runtime,operation,store,{pinned_order_id:'order',handover_completed_at:1}),true);
 assert.equal(shiftWorkAllowed({...runtime,shiftPolicy:null},operation,store),true);
});


test('revision exceptions are fixed from the original plan and rejection quantities use the preceding accepted source plan',()=>{
 const create=event('create','order.create','ORDER',1),rejected=event('reject','order.update','ORDER',2,'expected_business_rejected'),later=event('later','order.update','ORDER',3);
 create.input.event.event_id='create-id';rejected.input.event.event_id='update-id';later.input.event.event_id='later-id';rejected.error='CREATE_LINKED_ORDER';
 const planned=expectedRevisionOutcomes([create,rejected]);
 assert.equal(planned.length,2);assert(planned.every(rule=>rule.event_id==='update-id'&&rule.status==='business_rejected'));assert.deepEqual(planned.map(rule=>rule.reason),['USE_CANCELLATION','CREATE_LINKED_ORDER']);
 const detail=rejectedRevisionDetails([create,rejected,later])[0];assert.equal(detail.accepted_source_revision,1);assert.equal(detail.lines[0].unapplied_delta,1);assert.equal(detail.automatic_follow_up,false);
 assert.equal(detail.original_result,rejected.result);assert.deepEqual(expectedRevisionOutcomes(JSON.parse(JSON.stringify([create,rejected]))),planned);
});

test('quality event clocks and actual outcomes survive journal round trips without folding rejections into applied events',()=>{
 const op=event('op','order.update','ORDER',2,'expected_business_rejected');op.input.offset_ms=600000;op.input.event.event_id='event-id';op.error='CREATE_LINKED_ORDER';
 op.options={first_sent_at_ms:1,accepted_at_ms:2,acceptance_latency_ms:12,processed_at_ms:3,completion_observed_at_ms:4,last_server_status:'business_rejected'};
 const selected=qualityEvents(JSON.parse(JSON.stringify([op])))[0];assert.deepEqual(selected,{id:'event-id',scheduled_offset_ms:600000,first_sent_at_ms:1,accepted_at_ms:2,acceptance_latency_ms:12,processed_at_ms:3,completion_observed_at_ms:4,status:'business_rejected',reason:'CREATE_LINKED_ORDER'});
 op.status='quarantined';assert.equal(qualityEvents([op])[0].status,'quarantined');op.input.phase='seed';assert.deepEqual(qualityEvents([op]),[]);
});
