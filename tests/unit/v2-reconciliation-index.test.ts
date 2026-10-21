import {describe,it,expect} from 'vitest';
import {reconcile} from '../../src/server/v2/workflow/engine';
import {firstPositions} from '../../src/server/v2/workflow/position-index';
import {emptyState,type Ledger,type Order,type Stock} from '../../src/server/v2/workflow/types';

const stock=(item_id:string,location_id:string,patch:Partial<Stock>={}):Stock=>({item_id,location_id,S:0,R:0,P:0,Q:0,B:0,...patch});
const entry=(item_id:string,location_id:string,delta:number):Ledger=>({id:'entry',item_id,location_id,bucket:'S',delta,request_id:'request',actor_id:'actor',command:'fixture',reason:'',created_at:'2026-10-20T00:00:00Z'});
function order(id:string,item_id:string,location_id:string,quantities:number[],active:number):Order{return {id,version:1,created_at:'2026-10-20T00:00:00Z',delivery:{},lines:[{id:'',item_id,quantity:10,received:0,cancelled:0,shipped:0}],reservations:quantities.map((quantity,index)=>({id:String(index),line_id:'',item_id,location_id,quantity,picked:0})),picks:[{id:'pick',reservation_id:'0',line_id:'',item_id,location_id,quantity:active,active,packed:0,shipped:0,damaged:0,returned:0,cancel_pending:0}]};}

describe('workflow position indexes preserve reconciliation semantics',()=>{
 it('keeps the first duplicate position, empty identifiers and distinct delimiter-containing keys',()=>{
  const first=stock('','',{S:0}),duplicate=stock('','',{S:99}),a=stock('a:b','c',{S:2}),b=stock('a','b:c',{S:3}),special=stock('__proto__','constructor',{S:4});
  const index=firstPositions([first,duplicate,a,b,special]);expect(index.get('')?.get('')).toBe(first);expect(index.get('a:b')?.get('c')).toBe(a);expect(index.get('a')?.get('b:c')).toBe(b);expect(index.get('__proto__')?.get('constructor')).toBe(special);expect(index.get('absent')).toBeUndefined();
 });
 it('sums duplicate reservation/ledger positions, uses the first baseline and keeps zero rows and report counters',()=>{
  const state=emptyState();state.version=7;state.ledger_count=123;state.stock=[stock('','',{S:13,R:3,P:2})];state.ledger_base=[stock('','',{S:10,R:3,P:2}),stock('','',{S:999,R:999,P:999})];state.ledger=[entry('','',5),entry('','',-2),entry('','',0)];state.orders=[order('first','','',[1,0,2],2),order('second','','',[0],0)];
  const before=structuredClone(state);expect(reconcile(state)).toEqual({ok:true,issues:[],stock_rows:1,ledger_rows:123,version:7});expect(state).toEqual(before);
  state.stock.push({...state.stock[0]});expect(reconcile(state).ok).toBe(true); // Existing duplicate stock handling is not silently strengthened.
 });
 it('retains integer/negative/overflow errors and the original deduplicated issue order',()=>{
  const state=emptyState();state.stock=[stock('bad','position',{S:1.5,R:2,P:-1,Q:Number.NaN,B:Number.MAX_SAFE_INTEGER+1})];state.orders=[order('bad-order','bad','position',[],0)];state.orders[0].lines[0].quantity=1;state.orders[0].lines[0].cancelled=2;
  expect(reconcile(state)).toMatchObject({ok:false,issues:['NEGATIVE_OR_OVERFLOW','LEDGER_MISMATCH','OVER_RESERVED','RESERVATION_MISMATCH','PICK_MISMATCH','ORDER_QUANTITY_MISMATCH']});
 });
 it('keeps the existing stock-driven treatment of unmatched history and an empty aggregate',()=>{
  const state=emptyState();state.ledger=[entry('unmatched','history',5)];expect(reconcile(state)).toEqual({ok:true,issues:[],stock_rows:0,ledger_rows:1,version:0});
  state.stock=[stock('known','position')];state.ledger_base=[stock('other','position',{S:100})];expect(reconcile(state).ok).toBe(true);
 });
 it('reconciles accumulated orders and closed zero-quantity history without changing the input',()=>{
  const state=emptyState(),totals=new Map<string,{reserved:number;picked:number}>();
  for(let index=0;index<1000;index++){const item='item-'+index%40,location='location-'+index%7,closed=index%3===0,reserved=closed?0:1,picked=closed?0:2,position=JSON.stringify([item,location]);state.orders.push(order('order-'+index,item,location,[reserved,0],picked));const total=totals.get(position)??{reserved:0,picked:0};total.reserved+=reserved;total.picked+=picked;totals.set(position,total);}
  for(const[position,total]of totals){const[item,location]=JSON.parse(position) as [string,string];state.stock.push(stock(item,location,{S:total.reserved+10,R:total.reserved,P:total.picked}));}
  state.ledger_base=structuredClone(state.stock);const before=structuredClone(state);expect(reconcile(state).ok).toBe(true);expect(state).toEqual(before);
  state.orders[1].reservations[0].quantity++;expect(reconcile(state)).toMatchObject({ok:false,issues:['RESERVATION_MISMATCH']});
 });
});
