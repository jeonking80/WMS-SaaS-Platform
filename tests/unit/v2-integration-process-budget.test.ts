import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
const storage=vi.hoisted(()=>({withTenant:vi.fn()}));
vi.mock('../../src/server/db/tenant',()=>({withTenant:storage.withTenant}));
vi.mock('../../src/server/v2/access',()=>({assertV2MachineKeyInTransaction:vi.fn()}));
vi.mock('../../src/server/v2/workflow',()=>({executeWorkflowInTransaction:vi.fn()}));
import {processEvents,type IntegrationIdentity} from '../../src/server/v2/integration';

const identity={tenant:{id:'tenant',name:'Tenant'},user:{id:'actor',name:'Actor',email:''},role:'admin'} as IntegrationIdentity;
const item=(id:string)=>({id,status:'applied',result:{id:'business:'+id}});
let now=0;
beforeEach(()=>{now=0;storage.withTenant.mockReset();vi.spyOn(performance,'now').mockImplementation(()=>now);});
afterEach(()=>{vi.restoreAllMocks();});

describe('integration process soft transaction-boundary budget',()=>{
 it.each([5000,5001,20000])('returns the completed first event after %s ms without starting another transaction',async(elapsed)=>{
  storage.withTenant.mockImplementation(async()=>{now+=elapsed;return item('first');});
  expect(await processEvents(identity,'warehouse',50)).toEqual({events:[item('first')]});
  expect(storage.withTenant).toHaveBeenCalledTimes(1);
 });
 it('starts a further event below the boundary, then leaves the next event unselected at equality',async()=>{
  const queued=[item('first'),item('second'),item('third')],durations=[4999,1];
  storage.withTenant.mockImplementation(async()=>{now+=durations.shift()!;return queued.shift();});
  expect(await processEvents(identity,'warehouse',50)).toEqual({events:[item('first'),item('second')]});
  expect(storage.withTenant).toHaveBeenCalledTimes(2);expect(queued).toEqual([item('third')]);
 });
 it('waits for the active transaction promise to finish after the budget expires',async()=>{
  let finish!:(value:ReturnType<typeof item>)=>void,settled=false;
  storage.withTenant.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
  const pending=processEvents(identity,'warehouse',50).then(value=>{settled=true;return value;});
  now=20000;await Promise.resolve();
  expect(settled).toBe(false);expect(storage.withTenant).toHaveBeenCalledTimes(1);
  finish(item('committed'));
  expect(await pending).toEqual({events:[item('committed')]});
  expect(storage.withTenant).toHaveBeenCalledTimes(1);
 });
 it.each([1,25,50])('keeps the caller count limit %s as an upper bound while under budget',async(limit)=>{
  storage.withTenant.mockResolvedValue(item('committed'));
  expect((await processEvents(identity,'warehouse',limit)).events).toHaveLength(limit);
  expect(storage.withTenant).toHaveBeenCalledTimes(limit);
 });
 it('retains the default count limit and uses monotonic time independently of wall-clock changes',async()=>{
  vi.spyOn(Date,'now').mockReturnValue(100000).mockReturnValueOnce(0);
  storage.withTenant.mockResolvedValue(item('committed'));
  expect((await processEvents(identity,'warehouse')).events).toHaveLength(25);
 });
 it('still attempts the first transaction and returns no events when a slow first acquisition finds no eligible event',async()=>{
  storage.withTenant.mockImplementationOnce(async()=>{now=20000;return null;});
  expect(await processEvents(identity,'warehouse',50)).toEqual({events:[]});
  expect(storage.withTenant).toHaveBeenCalledTimes(1);
 });
 it('preserves an escaping transaction/commit error rather than returning earlier committed results as success',async()=>{
  const failure=Error('commit failed');
  storage.withTenant.mockImplementationOnce(async()=>{now=1;return item('first');})
   .mockImplementationOnce(async()=>{now=20000;throw failure;});
  await expect(processEvents(identity,'warehouse',50)).rejects.toBe(failure);
  expect(storage.withTenant).toHaveBeenCalledTimes(2);
 });
});
