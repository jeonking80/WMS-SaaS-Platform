import {describe,expect,it,vi} from 'vitest';
import type {PoolClient} from 'pg';
import {emptyState} from '../../src/server/v2/workflow/types';
import {readWorkflowState,splitWorkflowState,writeWorkflowState} from '../../src/server/v2/workflow/object-storage';

describe('lossless ordered workflow object persistence',()=>{
 it('preserves legacy duplicate IDs, scalar arrays, empty arrays and unknown metadata',()=>{
  const state={...emptyState(),version:12,receiving_ids:['same','same'],shifts:[{id:'duplicate',actor:'old'},{id:'duplicate',actor:'new'}],ledger_count:9,extra:{retained:true},future_array:[null,1,{id:'x',nested:['a']},{id:123},{id:false},{id:null},{id:{nested:'id'}}]};
  const {metadata,rows}=splitWorkflowState(state);
  const rebuilt=structuredClone(metadata) as Record<string,unknown[]>;
  for(const row of rows)rebuilt[row.kind].push(row.body);
  expect(rebuilt).toEqual(state);
  expect(rows.filter(r=>r.kind==='future_array').map(r=>[r.object_key,r.object_id])).toEqual([[':0',null],[':1',null],['x:2','x'],[':3',null],[':4',null],[':5',null],[':6',null]]);
  expect(new Set(rows.map(r=>JSON.stringify([r.kind,r.object_key]))).size).toBe(rows.length);
 });
 it('writes one changed historical body and one append while preserving all unchanged objects',async()=>{
  const before={...emptyState(),version:4,shifts:[{id:'a',closed:true},{id:'b',closed:true}],receiving_ids:['r1']};
  const after=structuredClone(before);after.version++;after.shifts[0]={...after.shifts[0],closed:false};after.receiving_ids.push('r2');
  const query=vi.fn().mockResolvedValue({rows:[],rowCount:1});
  await writeWorkflowState({query} as unknown as PoolClient,'tenant','warehouse',before,after);
  expect(query).toHaveBeenCalledTimes(2);
  const changed=JSON.parse(query.mock.calls[0][1][2]);
  expect(changed.map((r:{kind:string;body:unknown})=>[r.kind,r.body])).toEqual([['shifts',after.shifts[0]],['receiving_ids','r2']]);
  expect(JSON.parse(query.mock.calls[1][1][3])).toEqual({...after,shifts:[],receiving_ids:[]});
 });
 it('removes deleted bodies and keeps moved array positions exact',async()=>{
  const before={...emptyState(),shifts:[{id:'a'},{id:'b'}]};const after={...emptyState(),version:1,shifts:[{id:'b'}]};
  const query=vi.fn().mockResolvedValue({rows:[],rowCount:1});
  await writeWorkflowState({query} as unknown as PoolClient,'tenant','warehouse',before,after);
  expect(JSON.parse(query.mock.calls[0][1][2])).toEqual([{kind:'shifts',object_key:'a:0'},{kind:'shifts',object_key:'b:1'}]);
  expect(JSON.parse(query.mock.calls[1][1][2])[0]).toMatchObject({kind:'shifts',object_key:'b:0',position:0,body:{id:'b'}});
 });
 it('persists legacy repairs that mutate the loaded before-state before engine cloning',async()=>{
  const query=vi.fn().mockResolvedValue({rows:[],rowCount:1})
   .mockResolvedValueOnce({rows:[{state:emptyState()}],rowCount:1})
   .mockResolvedValueOnce({rows:[{kind:'shifts',body:{id:'legacy',quality_hold:undefined}}]});
  const before=(await readWorkflowState({query} as unknown as PoolClient,'tenant','warehouse','UPDATE'))!;
  before.shifts[0].quality_hold=0;
  const after=structuredClone(before);after.version++;
  await writeWorkflowState({query} as unknown as PoolClient,'tenant','warehouse',before,after);
  expect(JSON.parse(query.mock.calls[2][1][2])).toEqual([expect.objectContaining({kind:'shifts',body:{id:'legacy',quality_hold:0}})]);
 });
 it('preserves a changed JSON null element as JSON null through recordset insertion',async()=>{
  const before={...emptyState(),future_array:[1]},after={...emptyState(),version:1,future_array:[null]};
  const query=vi.fn().mockResolvedValue({rows:[],rowCount:1});
  await writeWorkflowState({query} as unknown as PoolClient,'tenant','warehouse',before,after);
  expect(JSON.parse(query.mock.calls[0][1][2])).toEqual([expect.objectContaining({kind:'future_array',body:null})]);
  expect(query.mock.calls[0][0]).toContain("COALESCE(body,'null'::jsonb)");
 });
 it('reads bodies only after acquiring the warehouse lock',async()=>{
  const query=vi.fn().mockResolvedValueOnce({rows:[{state:emptyState()}],rowCount:1}).mockResolvedValueOnce({rows:[{kind:'shifts',body:{id:'history'}}]});
  const state=await readWorkflowState({query} as unknown as PoolClient,'tenant','warehouse','SHARE');
  expect(query.mock.calls[0][0]).toContain('FOR SHARE');
  expect(query.mock.calls[1][0]).toContain('ORDER BY kind,position');
  expect(state?.shifts).toEqual([{id:'history'}]);
 });
});
