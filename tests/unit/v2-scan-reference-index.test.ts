import {describe,it,expect} from 'vitest';
import {scanReferences} from '../../src/server/v2/workflow/scan-reference-index';
import type {WorkflowState} from '../../src/server/v2/workflow/types';

// Mixed historical bodies intentionally cover compatibility shapes beyond typed IDs.
function fixture(){
 const receiptLot={id:'shared',item_id:'receipt'},returnLot={id:'shared',item_id:'return'},hold={id:'shared',item_id:'hold'};
 const receiptLine={id:'line',item_id:'receipt'},returnLine={id:'line',item_id:'return'},orderLine={id:'line',item_id:'order'};
 const firstReservation={id:'reservation',item_id:'first'},lastReservation={id:'reservation',item_id:'last'},firstPick={id:'pick',item_id:'first'},lastPick={id:'pick',item_id:'last'};
 const state={receipts:[{lots:[receiptLot],lines:[receiptLine]}],returns:[{lots:[returnLot],lines:[returnLine]}],holds:[hold],orders:[{lines:[orderLine],reservations:[firstReservation],picks:[firstPick]},{lines:[],reservations:[lastReservation],picks:[lastPick]}]} as unknown as WorkflowState;
 return {state,receiptLot,returnLot,hold,receiptLine,firstReservation,firstPick};
}
describe('ephemeral scan reference lookup',()=>{
 it('preserves original collection precedence and first duplicate identities without mutating state',()=>{
  const f=fixture(),before=structuredClone(f.state),lookup=scanReferences(f.state);
  expect(lookup.lot('shared')).toBe(f.receiptLot);expect(lookup.line('line')).toBe(f.receiptLine);expect(lookup.reservation('reservation')).toBe(f.firstReservation);expect(lookup.pick('pick')).toBe(f.firstPick);expect(lookup.lot('absent')).toBeUndefined();expect(f.state).toEqual(before);
  f.state.receipts[0].lots=[];expect(scanReferences(f.state).lot('shared')).toBe(f.returnLot);f.state.returns[0].lots=[];expect(scanReferences(f.state).lot('shared')).toBe(f.hold);
 });
 it('retains undefined/empty keys, object identity and current row mutation; fresh calls see new rows',()=>{
  const f=fixture(),missing={item_id:'missing'},empty={id:'',item_id:'empty'};f.state.holds=[missing,empty] as unknown as WorkflowState['holds'];const lookup=scanReferences(f.state);
  expect(lookup.lot(undefined)).toBe(missing);expect(lookup.lot('')).toBe(empty);expect(lookup.lot(null)).toBeUndefined();expect(lookup.lot(Number.NaN)).toBeUndefined();
  f.receiptLot.item_id='updated';expect(lookup.lot('shared')?.item_id).toBe('updated');const added={id:'new',item_id:'next'};f.state.holds.push(added as WorkflowState['holds'][number]);expect(scanReferences(f.state).lot('new')).toBe(added);
 });
 it('does not inspect any collection until its original lookup point',()=>{
  const state={get receipts(){throw Error('receipt lookup reached');},get orders(){throw Error('order lookup reached');}} as unknown as WorkflowState;
  const lookup=scanReferences(state);expect(()=>lookup.reservation('missing')).toThrow('order lookup reached');expect(()=>lookup.lot('missing')).toThrow('receipt lookup reached');
 });
 it('preserves early matches before malformed null rows and throws when strict find reaches them',()=>{
  const f=fixture();f.state.receipts[0].lots.push(null as unknown as WorkflowState['holds'][number]);const lookup=scanReferences(f.state);
  expect(lookup.lot('shared')).toBe(f.receiptLot);expect(()=>lookup.lot('absent')).toThrow(TypeError);expect(()=>lookup.lot(undefined)).toThrow(TypeError);
 });
 it('does not make a NaN runtime ID match strict equality',()=>{
  const f=fixture();f.state.holds=[{id:Number.NaN,item_id:'invalid'}] as unknown as WorkflowState['holds'];expect(scanReferences(f.state).lot(Number.NaN)).toBeUndefined();
 });
});
