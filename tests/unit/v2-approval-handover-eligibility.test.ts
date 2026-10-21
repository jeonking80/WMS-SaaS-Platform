import {describe,expect,it} from 'vitest';
import {emptyState,type Approval,type Count} from '../../src/server/v2/workflow/types';
import {approvalActorExcluded,approvalAssigneeEligible,approvalRoleAllowed} from '../../src/server/v2/workflow/approval-eligibility';

const approval:Approval={id:'approval',type:'count',target_id:'count',target_version:2,quantity:0,data:{},reason:'Review',requester_id:'requester',origin_actor_ids:['origin'],status:'pending'};
const state={...emptyState(),counts:[{id:'count',counter_id:'last-counter',counter_ids:['first-counter','last-counter']} as Count],approvals:[approval]};
const candidate=(userId:string,extra:Record<string,unknown>={})=>({userId,role:'supervisor',status:'active',warehouseIds:['warehouse'],...extra});
describe('shared approval decision and handover eligibility',()=>{
 it.each(['requester','origin','first-counter','last-counter'])('excludes %s from both approval decisions and handover choices',actor=>{
  expect(approvalActorExcluded(state,approval,actor)).toBe(true);
  expect(approvalAssigneeEligible(state,approval,candidate(actor),'warehouse')).toBe(false);
 });
 it.each(['admin','supervisor'])('keeps an independent current %s eligible',role=>{
  expect(approvalRoleAllowed(role)).toBe(true);expect(approvalAssigneeEligible(state,approval,candidate('independent',{role}),'warehouse')).toBe(true);
 });
 it('excludes ordinary workers, inactive or foreign-warehouse candidates and nonpending requests',()=>{
  for(const extra of [{role:'worker'},{role:'viewer'},{status:'departed'},{warehouseIds:['elsewhere']}])expect(approvalAssigneeEligible(state,approval,candidate('independent',extra),'warehouse')).toBe(false);
  expect(approvalAssigneeEligible(state,{...approval,status:'approved'},candidate('independent'),'warehouse')).toBe(false);
 });
 it('requires the existing automation approval role and approve scope rather than a supervisor label alone',()=>{
  expect(approvalAssigneeEligible(state,approval,candidate('machine:key'),'warehouse')).toBe(false);
  expect(approvalAssigneeEligible(state,approval,candidate('machine:key',{role:'worker',scopes:['read','write','approve']}),'warehouse')).toBe(false);
  expect(approvalAssigneeEligible(state,approval,candidate('machine:key',{scopes:['read','write','approve']}),'warehouse')).toBe(true);
 });
 it('also excludes known physical recipients when older origin_actor_ids are absent',()=>{
  const receipt={id:'receipt',lots:[{id:'lot',received_by:'receiver'}]} as typeof state.receipts[number];
  const legacy={...state,receipts:[receipt]};
  for(const [type,target_id] of [['overage','lot'],['receipt.close','receipt']] as const)expect(approvalActorExcluded(legacy,{...approval,type,target_id,origin_actor_ids:undefined},'receiver')).toBe(true);
 });
});
