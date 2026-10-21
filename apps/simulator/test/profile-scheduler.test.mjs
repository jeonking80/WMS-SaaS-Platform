import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createSourceScheduler,assertSchedulerResume,PROFILE_SCHEDULER_VERSION} from '../profile-scheduler.mjs';
import {openStore} from '../store.mjs';
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function deferred(){let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};}

test('ten slow old polls leave all ten new-transmission slots available, with no duplicate active operation',async()=>{
 const queued={poll:Array.from({length:25},(_,i)=>({id:'poll-'+i})),new:Array.from({length:25},(_,i)=>({id:'new-'+i}))},gates=new Map(),started=[],completed=new Set();
 const scheduler=createSourceScheduler({select:(lane,limit,excluded)=>queued[lane].filter(op=>!excluded.includes(op.id)&&!completed.has(op.id)).slice(0,limit),dispatch:async op=>{started.push(op.id);const gate=deferred();gates.set(op.id,gate);await gate.promise;completed.add(op.id);}});
 scheduler.pulse('poll');await flush();assert.equal(started.length,10);
 scheduler.pulse('new');await flush();assert.equal(started.filter(id=>id.startsWith('new-')).length,10);assert.equal(scheduler.activeCount,20);
 scheduler.pulse('new');scheduler.pulse('poll');await flush();assert.equal(started.length,20);assert.equal(new Set(started).size,20);
 gates.get('new-0').resolve();await flush();scheduler.pulse('new');await flush();
 assert.equal(started.at(-1),'new-10');assert.equal(started.filter(id=>id.startsWith('poll-')).length,10);assert.equal(scheduler.activeCount,20);
 for(const gate of gates.values())gate.resolve();await scheduler.settle();assert.equal(scheduler.activeCount,0);
});

test('an uncertain POST keeps its operation reserved across lanes until completion, and SQLite preserves poll-before-retransmit classification',async()=>{
 const store=openStore(':memory:'),gate=deferred();let calls=0;
 try{
  store.create({id:'run',config:{scheduler_version:PROFILE_SCHEDULER_VERSION},target:{}},[{id:'event',kind:'event',label:'create',role:'source',input:{phase:'measured',offset_ms:0,event:{event_id:'original-id'}}}]);
  const scheduler=createSourceScheduler({select:(lane,limit,excluded)=>store.readyEvents('run',1000,1000,limit,lane,excluded),dispatch:async op=>{calls++;store.updateOp(op.id,{status:'unconfirmed'});await gate.promise;store.updateOp(op.id,{next_at:1250});}});
  scheduler.pulse('new');await flush();assert.equal(calls,1);assert.equal(store.hasUnconfirmedEvents('run'),true);
  scheduler.pulse('poll');await flush();assert.equal(calls,1);assert.equal(scheduler.activeCount,1);
  gate.resolve();await scheduler.settle();assert.equal(scheduler.activeCount,0);
  assert.deepEqual(store.readyEvents('run',1249,1000,10,'poll'),[]);
  const poll=store.readyEvents('run',1250,1000,10,'poll');assert.equal(poll.length,1);assert.equal(poll[0].status,'unconfirmed');assert.equal(poll[0].input.event.event_id,'original-id');
  assert.deepEqual(store.readyEvents('run',1250,1000,10,'new'),[]);
 }finally{gate.resolve();store.close();}
});

test('scheduler-version changes block old-run resume while generator and event plans remain independently versioned',()=>{
 assert.throws(()=>assertSchedulerResume({generator_version:'2.0.0'}),/scheduler changed/);
 assert.throws(()=>assertSchedulerResume({scheduler_version:'legacy'}),/scheduler changed/);
 assert.doesNotThrow(()=>assertSchedulerResume({scheduler_version:PROFILE_SCHEDULER_VERSION,generator_version:'2.0.0'}));
});
