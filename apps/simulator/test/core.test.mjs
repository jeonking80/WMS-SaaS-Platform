import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {openStore} from '../store.mjs';
import {makePlan,seeded,resolveRefs} from '../planner.mjs';
import {reconcile,expectedStock} from '../oracle.mjs';
import {retryAt,createRunner} from '../runner.mjs';
import {randomUUID} from 'node:crypto';
import {profilePlan} from '../profile-plan.mjs';
test('SQLite preserves the exact unsent body, key, delayed retry and checkpoint across process storage restart',()=>{
 const dir=mkdtempSync(join(tmpdir(),'wms-sim-')),path=join(dir,'state.sqlite');let db=openStore(path);
 const input={event_id:'persistent-event',payload:{lines:[{quantity:12}]}};
 db.create({id:'run',config:{seed:15},target:{fingerprint:'original'}},[{id:'op',kind:'event',label:'create',role:'source',input}]);
 db.updateOp('op',{status:'unconfirmed',attempts:3,next_at:Date.now()+120000});db.updateRun('run',{checkpoint:4});db.close();db=openStore(path);
 assert.deepEqual(db.operations('run')[0].input,input);assert.equal(db.operations('run')[0].attempts,3);assert(db.operations('run')[0].next_at>Date.now()+110000);assert.equal(db.run('run').checkpoint,4);db.close();rmSync(dir,{recursive:true});
});
test('independent oracle detects equal corruption in WMS stock and WMS ledger',()=>{
 const config={item_id:'item',receiving_id:'dock',storage_id:'store',staging_id:'stage'};
 const ops=[{status:'done',input:{command:'receipt.receive',payload:{lines:[{quantity:60,location_id:'dock'}]}}}];
 const snapshot={version:1,stock:[{item_id:'item',location_id:'dock',S:0,R:0,P:0,Q:61,B:0}],ledger:[{item_id:'item',location_id:'dock',bucket:'Q',delta:61}],orders:[],receipts:[]};
 const judged=reconcile(config,ops,snapshot);assert.equal(judged.passed,false);assert.equal(judged.differences.length,2);assert.equal(judged.expected.totals.Q,60);
});
test('seed controls the reproducible supplier distribution and refs never copy WMS quantities',()=>{
 const c={scenario:'supply',warehouse_id:'w',item_id:'i',seed:77,event_count:40,quantity_min:2,quantity_max:7};
 const a=makePlan('run',c,'source').map(x=>[x.input.event_type,x.input.payload]);const b=makePlan('run',c,'source').map(x=>[x.input.event_type,x.input.payload]);assert.deepEqual(a,b);assert.notDeepEqual(a,makePlan('run',{...c,seed:78},'source').map(x=>[x.input.event_type,x.input.payload]));
 assert.equal(seeded(1)(),seeded(1)());assert.deepEqual(resolveRefs({lot_id:{$ref:'receipt.id'},quantity:60},{receipt:{id:'server-id',quantity:900}}),{lot_id:'server-id',quantity:60});
});
test('Retry-After survives long server backpressure and target changes block resume',async()=>{
 assert.equal(retryAt(2,120,1000,()=>0),121000);
 const store=openStore(':memory:');store.create({id:'run',config:{},target:{fingerprint:'old'}},[]);
 const runner=createRunner(store,{url:'http://test-wms',companyId:'company',sourceKey:'secret'},async()=>Response.json({contract_version:'2.0',environment:'test',test_company:true,company_id:'company',kind:'integration',source_system:'source',warehouse_ids:['w']}));
 await assert.rejects(runner.resume('run'),/TARGET_CHANGED_RESUME_BLOCKED/);assert.equal(store.run('run').status,'paused');store.close();
});
test('durable outage respects the stored Retry-After deadline without spending retries on each scheduler tick',async()=>{
 const store=openStore(':memory:');const company=randomUUID(),warehouse=randomUUID();let calls=0;
 const meta={contract_version:'2.0',environment:'test',test_company:true,company_id:company,kind:'integration',source_system:'source',warehouse_ids:[warehouse]};
 const empty={version:0,stock:[],ledger:[],receipts:[],orders:[],returns:[],shipments:[],packages:[]};
 const fake=async(input,init)=>{calls++;const path=new URL(input).pathname;if(path.endsWith('/connection'))return Response.json(meta);if(path==='/api/v2/workflow')return Response.json({snapshot:empty});if(path.endsWith('/events')&&!init.body)return Response.json({events:[]});if(path.endsWith('/events'))return Response.json({event:{id:randomUUID(),status:'accepted'}},{status:202});throw Error('Unexpected transport');};
 const runner=createRunner(store,{url:'http://test-wms',companyId:company,sourceKey:'source',processKey:'processor',workerKey:'worker'},fake);
 const run=await runner.create({scenario:'supply',mode:'auto',warehouse_id:warehouse,item_id:randomUUID(),receiving_id:randomUUID(),storage_id:randomUUID(),staging_id:randomUUID(),hold_id:randomUUID(),supplier_id:randomUUID(),customer_id:randomUUID(),destination_id:randomUUID(),expected_at:'2026-11-01T00:00:00Z',due_at:'2026-11-01T00:00:00Z',seed:1,delay_ms:100,event_count:1,outage_seconds:60});await runner.resume(run.id);await runner.tick(run.id);await new Promise(resolve=>setTimeout(resolve,110));await runner.tick(run.id);
 const op=store.operations(run.id)[0];assert.equal(op.attempts,1);assert(op.next_at>Date.now()+58000);const before=calls;await runner.tick(run.id);await runner.tick(run.id);assert.equal(calls,before);assert.equal(store.operations(run.id)[0].attempts,1);store.close();
});
test('full profile schedules keep real 8-hour and 25-minute targets separate from smoke',()=>{
 const catalog=Array.from({length:100},(_,i)=>({item_id:'item-'+i}));const burst=profilePlan('run','congestion',catalog,'source','warehouse',15);const measured=burst.events.filter(x=>x.phase==='measured');assert.equal(burst.duration_ms,1500000);assert.equal(measured.length,2700);assert.equal(measured.filter(x=>x.input.event_type==='order.create').length,1890);assert.equal(measured.filter(x=>x.input.event_type==='receipt.create').length,540);assert.equal(measured.filter(x=>x.input.event_type==='order.update').length,270);assert.equal(measured.filter(x=>x.offset_ms<600000).length,600);assert.equal(measured.filter(x=>x.offset_ms>=600000&&x.offset_ms<900000).length,1500);assert.equal(burst.events.filter(x=>x.phase==='seed').length,100);
 const shift=profilePlan('shift','shift',catalog,'source','warehouse',15);assert.equal(shift.duration_ms,28800000);assert.equal(shift.events.filter(x=>x.phase==='measured'&&x.input.event_type==='order.create').length,1000);assert.equal(shift.events.filter(x=>x.phase==='measured'&&x.input.event_type==='receipt.create').length,100);assert.equal(profilePlan('smoke','shift-smoke',catalog,'source','warehouse',15,{smoke_duration_ms:8000}).duration_ms,8000);
});
test('seeded mixed ratios select real shortage, replacement damage and wrong-scan operations and persist fault choices',()=>{
 const config={scenario:'mixed_pattern',seed:17,event_count:3,quantity_min:5,quantity_max:5,item_id:'i',warehouse_id:'w',receiving_id:'r',storage_id:'s',staging_id:'p',hold_id:'b',shortage_ratio:1,damage_ratio:1,wrong_scan_ratio:1,duplicate_ratio:1,response_loss_ratio:1,delay_ratio:1};
 const ops=makePlan('run',config,'source');assert.equal(ops.filter(x=>x.input.expect_error==='INSUFFICIENT_STOCK').length,3);assert.equal(ops.filter(x=>x.input.expect_error==='WRONG_ITEM_SCAN').length,3);assert.equal(ops.filter(x=>x.input.command==='order.damage').length,3);assert.equal(ops.filter(x=>x.input.command==='shipment.create').length,3);assert(ops.filter(x=>x.kind==='event').every(x=>x.options.duplicate&&x.options.lose_response&&x.options.delayed));
 const no=makePlan('run',{...config,shortage_ratio:0,damage_ratio:0,wrong_scan_ratio:0,duplicate_ratio:0,response_loss_ratio:0,delay_ratio:0},'source');assert(!no.some(x=>x.input.expect_error||x.input.command==='order.damage'));assert(no.filter(x=>x.kind==='event').every(x=>!x.options.duplicate&&!x.options.delayed&&!x.options.lose_response));
 const db=openStore(':memory:');db.create({id:'run',config,target:{}},ops);assert.deepEqual(db.operation(ops[0].id).options,ops[0].options);db.close();
});
test('Korean working windows support a closed day and an overnight shift; comparisons show changed test conditions',async()=>{
 const {nextWorkingTime,compareReports}=await import('../scheduling.mjs');
 const at=Date.parse('2026-10-20T12:00:00Z');assert.equal(nextWorkingTime(at,'09:00','18:00'),Date.parse('2026-10-21T00:00:00Z'));assert.equal(nextWorkingTime(at,'20:00','06:00'),at);assert.equal(nextWorkingTime(at,'00:00','24:00'),at);
 const a={id:'a',config:{scenario:'mixed_pattern',seed:1},report:{verdict:'passed',counts:{api_calls:10},latency:{p95_ms:30},differences:[]}},b={...a,id:'b',config:{...a.config,seed:2},report:{...a.report,counts:{api_calls:15},latency:{p95_ms:25}}};const comparison=compareReports(a,b);assert.equal(comparison.conditions_equal,false);assert.equal(comparison.deltas.api_calls,5);assert.equal(comparison.deltas.latency_p95_ms,-5);
});
test('closed working hours durably defer a new WMS request without sending or spending retries',async()=>{
 const store=openStore(':memory:'),warehouse=randomUUID(),company=randomUUID();let writes=0;const now=new Date(Date.now()+9*3600000),hour=(now.getUTCHours()+1)%24,format=x=>String(x).padStart(2,'0')+':00';
 const fake=async(input,init)=>{if(init.body)writes++;if(new URL(input).pathname.endsWith('/connection'))return Response.json({contract_version:'2.0',environment:'test',test_company:true,company_id:company,kind:'integration',source_system:'source',warehouse_ids:[warehouse]});return Response.json({snapshot:{version:0,stock:[],ledger:[],receipts:[],orders:[]}});};
 const runner=createRunner(store,{url:'http://test-wms',companyId:company,sourceKey:'source',processKey:'process',workerKey:'worker'},fake),run=await runner.create({scenario:'supply',mode:'auto',seed:7,delay_ms:100,warehouse_id:warehouse,item_id:randomUUID(),receiving_id:randomUUID(),storage_id:randomUUID(),staging_id:randomUUID(),hold_id:randomUUID(),supplier_id:randomUUID(),customer_id:randomUUID(),destination_id:randomUUID(),expected_at:'2026-11-01T00:00:00Z',due_at:'2026-11-01T00:00:00Z',working_start:format(hour),working_end:format((hour+1)%24)});await runner.resume(run.id);await runner.tick(run.id);const op=store.operations(run.id)[0];assert.equal(op.status,'unsent');assert.equal(op.attempts,0);assert(op.next_at>Date.now());assert.equal(writes,0);assert(store.observations(run.id).some(x=>x.kind==='working_hours_wait'));store.close();
});
test('request latency includes response body delivery and JSON parsing, not only response headers',async()=>{
 const store=openStore(':memory:');store.create({id:'body-latency',config:{},target:{}},[]);
 const runner=createRunner(store,{url:'http://test-wms',workerKey:'worker'},async()=>{const response=Response.json({ok:true}),parse=response.json.bind(response);response.json=async()=>{await new Promise(resolve=>setTimeout(resolve,35));return parse();};return response;});
 await runner.api('worker','/api/v2/workflow',undefined,'body-latency');const sample=store.observations('body-latency').find(x=>x.kind==='api_call');assert(sample.details.latency_ms>=30);store.close();
});

test('independent source totals use the accepted revised quantity without copying WMS quantities',()=>{
 const make=(type,external,quantity)=>({status:'done',kind:'event',input:{event_type:type,source_system:'source',external_entity_id:external,payload:{lines:[{item_id:'item',quantity}]}}});
 const expected=expectedStock({},[make('order.create','a',5),make('order.update','a',6),make('order.create','b',5)]);assert.equal(expected.order.ordered,11);
});
