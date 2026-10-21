import type {WorkflowState} from './types';

/** Build once per normalization call, only when the old lookup would be reached.
 * Missing IDs are keys too. Retain strict-find behavior for malformed null rows. */
function lazyFirst<T extends {id:string}>(materialize:()=>T[]) {
 let lookup:((id:unknown)=>T|undefined)|undefined;
 return (id:unknown):T|undefined=>{
  if(!lookup){
   const rows=materialize(),first=new Map<unknown,T>();let malformed=false;
   for(const row of rows){if(row==null){malformed=true;break;}if(!first.has(row.id))first.set(row.id,row);}
   lookup=malformed?key=>rows.find(row=>row.id===key):key=>typeof key==='number'&&Number.isNaN(key)?undefined:first.get(key);
  }
  return lookup(id);
 };
}
/** Ephemeral lookup over stable authorized state; return original row references. */
export function scanReferences(state:WorkflowState) {
 return {
  lot:lazyFirst(()=>[...state.receipts,...state.returns].flatMap(row=>row.lots).concat(state.holds??[])),
  reservation:lazyFirst(()=>state.orders.flatMap(row=>row.reservations)),
  pick:lazyFirst(()=>state.orders.flatMap(row=>row.picks)),
  line:lazyFirst(()=>[...state.receipts,...state.returns,...state.orders].flatMap(row=>row.lines)),
 };
}

/** Resolve only the reference the physical command actually consumes. Parent-scoped
 * lookups prevent duplicate line IDs or unrelated client hints selecting another SKU. */
export function physicalScanReferences(state:WorkflowState,command:string,payload:Record<string,unknown>):(line:Record<string,unknown>)=>{item_id:string;location_id?:string}|undefined {
 switch(command){
  case 'receipt.receive': {const lookup=lazyFirst(()=>state.receipts.find(row=>row.id===payload.receipt_id)?.lines??[]);return line=>lookup(line.line_id);}
  case 'return.receive': {const lookup=lazyFirst(()=>state.returns.find(row=>row.id===payload.return_id)?.lines??[]);return line=>lookup(line.line_id);}
  case 'receipt.inspect':case 'receipt.putaway': {const lookup=lazyFirst(()=>state.receipts.find(row=>row.id===payload.receipt_id)?.lots??[]);return line=>lookup(line.lot_id);}
  case 'return.inspect':case 'return.putaway': {const lookup=lazyFirst(()=>state.returns.find(row=>row.id===payload.return_id)?.lots??[]);return line=>lookup(line.lot_id);}
  case 'stock.inspect':case 'stock.putaway': {const lookup=lazyFirst(()=>state.holds??[]);return line=>lookup(line.lot_id);}
  case 'hold.release': {const lookup=scanReferences(state).lot;return line=>lookup(line.lot_id);}
  case 'order.pick': {const lookup=lazyFirst(()=>state.orders.find(row=>row.id===payload.order_id)?.reservations??[]);return line=>lookup(line.reservation_id);}
  case 'package.create':case 'order.return_picked':case 'order.damage': {const lookup=lazyFirst(()=>state.orders.find(row=>row.id===payload.order_id)?.picks??[]);return line=>lookup(line.pick_id);}
  default:return()=>undefined;
 }
}
