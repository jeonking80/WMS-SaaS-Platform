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
