import {randomUUID} from 'node:crypto';
import {describe,it,expect} from 'vitest';
import {applyCommand,snapshot} from '../../src/server/v2/workflow/engine';
import {refreshStockLocations} from '../../src/server/v2/workflow/location-projection';
import {emptyState,type Count,type Stock,type WorkflowContext} from '../../src/server/v2/workflow/types';

const row=(location_id:string):Stock=>({item_id:'item',location_id,S:10,R:0,P:0,Q:0,B:0});
function count(location_id:string,status:Count['status']):Count{return{id:location_id+status,location_id,actor_id:'counter',version:1,status,baseline:[row(location_id)],lines:[],recount:false,reason:''};}

describe('current location and count projections',()=>{
 it('preserves first-reference authority, missing references, stock identity and ordering',()=>{
  const state=emptyState();state.stock=['duplicate','blocked','inactive','hold','missing','__proto__',''].map(row);
  const originalRows=[...state.stock];state.location_blocks=[{location_id:'blocked',reason:'Physical check',blocked_at:'now',request_id:'request'}];
  const locations=[{id:'duplicate',active:false,kind:'STORAGE'},{id:'duplicate',active:true,kind:'HOLD'},{id:'blocked',active:true,kind:'STORAGE'},{id:'inactive',active:false,kind:'STORAGE'},{id:'hold',active:true,kind:'HOLD',reservation_blocked:true},{id:'__proto__',active:true,kind:'STORAGE'},{id:'',active:true,kind:'STORAGE'}];
  const refsBefore=structuredClone(locations);refreshStockLocations(state,locations);
  expect(state.stock.map(x=>[x.location_id,x.reservation_blocked,x.location_kind])).toEqual([['duplicate',true,'STORAGE'],['blocked',true,'STORAGE'],['inactive',true,'STORAGE'],['hold',true,'HOLD'],['missing',false,undefined],['__proto__',false,'STORAGE'],['',false,'STORAGE']]);
  state.stock.forEach((value,index)=>expect(value).toBe(originalRows[index]));expect(locations).toEqual(refsBefore);
  state.location_blocks=[];refreshStockLocations(state,[{id:'duplicate',active:true,kind:'STORAGE'}]);
  expect(state.stock.every(x=>x.reservation_blocked===false)).toBe(true);expect(state.stock[3].location_kind).toBeUndefined();
 });
 it('keeps blind counts, active locks, quantities, complete history and reconciliation without changing input',()=>{
  const state=emptyState();state.version=17;state.stock=['open','counting','submitted','finished','blocked','hold'].map(row);state.ledger_base=structuredClone(state.stock);
  state.stock[4].reservation_blocked=true;state.stock[5].location_kind='HOLD';
  state.counts=[count('counting','completed'),count('counting','counting'),count('submitted','submitted'),count('finished','completed'),count('finished','unlocked')];
  state.tasks=[{id:'task',object_type:'count',object_id:'counting',assignee_id:'next',reason:'handover',assigned_at:'now'}];state.shifts=[{id:'shift',version:16}];
  const before=structuredClone(state),view=snapshot(state);
  expect(view.stock.map(x=>[x.location_id,x.A,x.H,x.locked])).toEqual([['open',10,10,false],['counting',0,10,true],['submitted',0,10,true],['finished',10,10,false],['blocked',0,10,false],['hold',0,10,false]]);
  expect(view.counts.map(x=>x.baseline.length)).toEqual([1,0,0,1,1]);expect(snapshot(state,false).counts).toEqual(before.counts);
  expect(view.tasks).toEqual(before.tasks);expect(view.shifts).toEqual(before.shifts);expect(view.reconciliation).toEqual({ok:true,issues:[],stock_rows:6,ledger_rows:0,version:17});expect(state).toEqual(before);
  state.counts[1].status='unlocked';state.counts[2].status='completed';expect(snapshot(state).stock.filter(x=>['counting','submitted'].includes(x.location_id)).every(x=>x.A===10&&!x.locked)).toBe(true);
  state.stock[0].S=11;expect(snapshot(state).reconciliation).toMatchObject({ok:false,issues:['LEDGER_MISMATCH']});
 });
 it('refreshes current metadata in an ordinary command while preserving the original aggregate',()=>{
  const item=randomUUID(),location=randomUUID(),state=emptyState();state.stock=[{...row(location),item_id:item,reservation_blocked:false,location_kind:'HOLD'}];state.ledger_base=structuredClone(state.stock);
  const context:WorkflowContext={actor:{id:randomUUID(),role:'worker'},request_id:randomUUID(),command:'',now:'2026-10-20T00:00:00Z',id:randomUUID,items:[{id:item,active:true}],locations:[{id:location,active:false,kind:'STORAGE'},{id:location,active:true,kind:'HOLD'}]};
  const before=structuredClone(state),result=applyCommand(state,'receipt.create',{lines:[{item_id:item,quantity:1}]},context);
  expect(result.state.stock).toEqual([{...before.stock[0],reservation_blocked:true,location_kind:'STORAGE'}]);expect(result.state.version).toBe(1);expect(result.state.receipts).toHaveLength(1);expect(snapshot(result.state).reconciliation.ok).toBe(true);expect(state).toEqual(before);
 });
});
