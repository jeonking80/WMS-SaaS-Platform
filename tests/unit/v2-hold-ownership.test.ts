import {describe,it,expect} from 'vitest';
import {emptyState,type Lot,type Order,type Task} from '../../src/server/v2/workflow/types';
import {genericHoldOwnership} from '../../src/server/v2/workflow/hold-ownership';
const lot:Lot={id:'lot',line_id:'line',item_id:'item',location_id:'location',quantity:1,pending:0,normal:0,hold:1,putaway:0,overage:false,approved:0,released:0};
const order=(id:string):Order=>({id,version:1,lines:[{id:'line',item_id:'item',quantity:1,received:0,cancelled:0,shipped:0}],reservations:[],picks:[],delivery:{},created_at:'2026-10-21T00:00:00Z'});
const task=(object_type:string,object_id:string,assignee_id:string):Task=>({id:object_type+assignee_id,object_type,object_id,assignee_id,reason:'Explicit handover',assigned_at:'2026-10-21T00:00:00Z'});
describe('generic quality-lot ownership boundaries',()=>{
 it('inherits a unique legacy order owner and never silently chooses an ambiguous line',()=>{
  const s=emptyState();s.orders=[order('first')];s.tasks=[task('order','first','worker-a')];
  expect(genericHoldOwnership(s,lot)).toEqual({task:s.tasks[0],requiresAssignment:false});
  s.orders.push(order('second'));s.tasks.push(task('order','second','worker-b'));
  expect(genericHoldOwnership(s,lot)).toEqual({requiresAssignment:true});
 });
 it('uses the explicit server origin rather than ambiguous legacy line matching',()=>{
  const s=emptyState();s.orders=[order('first'),order('second')];s.tasks=[task('order','first','worker-a'),task('order','second','worker-b')];
  expect(genericHoldOwnership(s,{...lot,origin_order_id:'first'})).toEqual({task:s.tasks[0],requiresAssignment:false});
  expect(genericHoldOwnership(s,{...lot,origin_order_id:'missing'})).toEqual({requiresAssignment:true});
 });
 it('lets the latest direct hold handover replace inherited ownership even when the source changes',()=>{
  const s=emptyState();s.orders=[order('first')];s.tasks=[task('order','first','worker-a'),task('hold','lot','worker-b'),task('order','first','worker-c'),task('hold','lot','worker-d')];
  expect(genericHoldOwnership(s,{...lot,origin_order_id:'first'})).toEqual({task:s.tasks[3],requiresAssignment:false});
  expect(genericHoldOwnership(s,{...lot,origin_order_id:'missing'})).toEqual({task:s.tasks[3],requiresAssignment:false});
 });
 it('does not treat a task of another object type as a direct hold owner',()=>{
  const s=emptyState();s.tasks=[task('order','lot','unrelated')];
  expect(genericHoldOwnership(s,lot)).toEqual({task:undefined,requiresAssignment:false});
 });
});
