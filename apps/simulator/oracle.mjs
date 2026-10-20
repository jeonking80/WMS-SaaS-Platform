// Deliberately independent of WMS code. Inputs are the locally persisted physical intent,
// never the quantities returned by WMS. Identifier bindings do not determine expected quantities.
export function expectedStock(config,operations){
  const buckets=['S','R','P','Q','B'];const locations={};
  const change=(loc,b,q)=>{locations[loc]??=Object.fromEntries(buckets.map(k=>[k,0]));locations[loc][b]+=q;};
  let ordered=0,reserved=0,picked=0,shipped=0;const packages={},orderQuantities=new Map();
  for(const op of operations.filter(x=>x.status==='done')){
    const p=op.input.payload??{},command=op.input.command??op.input.event_type;
    const orderKey=op.input.external_entity_id?op.input.source_system+':'+op.input.external_entity_id:p.order_id??op.result?.result?.id??op.result?.id??op.id;
    if(command==='order.create'){const q=p.lines.reduce((n,x)=>n+x.quantity,0);ordered+=q;orderQuantities.set(orderKey,q);}
    if(command==='order.update'&&orderQuantities.has(orderKey)){const q=p.lines.reduce((n,x)=>n+x.quantity,0);ordered+=q-orderQuantities.get(orderKey);orderQuantities.set(orderKey,q);}
    if(command==='receipt.receive'||command==='return.receive')for(const x of p.lines){if(command==='receipt.receive'&&config.scenario?.startsWith('overage')){change(x.location_id,'Q',100);change(x.hold_location_id,'B',x.quantity-100);}else change(x.location_id,'Q',x.quantity);}
    if(command==='receipt.inspect'||command==='return.inspect')for(const x of p.lines)if(x.outcome==='hold'){change(config.receiving_id,'Q',-x.quantity);change(config.receiving_id,'B',x.quantity);}
    if(command==='receipt.putaway'||command==='return.putaway')for(const x of p.lines){change(config.receiving_id,'Q',-x.quantity);change(x.location_id,'S',x.quantity);}
    if(command==='order.reserve'){const q=p.lines?p.lines.reduce((n,x)=>n+x.quantity,0):ordered-reserved-picked-shipped;reserved+=q;change(config.storage_id,'R',q);}
    if(command==='order.pick')for(const x of p.lines){reserved-=x.quantity;picked+=x.quantity;change(config.storage_id,'R',-x.quantity);change(config.storage_id,'S',-x.quantity);change(x.location_id,'P',x.quantity);}
    if(command==='order.damage')for(const x of p.lines){picked-=x.quantity;change(config.staging_id,'P',-x.quantity);change(x.location_id,'B',x.quantity);}
    if(command==='hold.release'){change(config.hold_id,'B',-p.quantity);change(p.location_id,'Q',p.quantity);}
    if(command==='approval.decide'&&config.scenario==='count'&&p.approve)change(config.storage_id,'S',8-(locations[config.storage_id]?.S??0));
    if(command==='order.return_picked')for(const x of p.lines){picked-=x.quantity;change(config.staging_id,'P',-x.quantity);change(x.location_id,x.outcome==='normal'?'S':'B',x.quantity);}
    if(command==='package.create')packages[op.result?.result?.id??op.result?.id??op.id]=p.lines.reduce((n,x)=>n+x.quantity,0);
    if(command==='shipment.create')for(const id of p.package_ids){const q=packages[id];if(q===undefined)throw Error('Independent package quantity missing');picked-=q;shipped+=q;change(config.staging_id,'P',-q);}
  }
  return {locations,order:{ordered,reserved,picked,shipped},totals:Object.fromEntries(buckets.map(b=>[b,Object.values(locations).reduce((n,x)=>n+x[b],0)]))};
}
export function reconcile(config,operations,snapshot){
  const expected=expectedStock(config,operations),differences=[];const buckets=['S','R','P','Q','B'];const actual={};const ledger={};
  for(const row of snapshot.stock.filter(x=>x.item_id===config.item_id)){actual[row.location_id]=row;for(const b of buckets)if(!Number.isSafeInteger(row[b])||row[b]<0)differences.push({kind:'invalid_quantity',location:row.location_id,bucket:b,actual:row[b]});if(row.R>row.S)differences.push({kind:'over_reservation',location:row.location_id});if(row.H!==undefined&&row.H!==row.S+row.P+row.Q+row.B)differences.push({kind:'physical_total',location:row.location_id});const available=row.locked||row.reservation_blocked||row.location_kind&&row.location_kind!=='STORAGE'?0:row.S-row.R;if(row.A!==undefined&&row.A!==available)differences.push({kind:'available_total',location:row.location_id,expected:available,actual:row.A});}
  for(const row of snapshot.ledger.filter(x=>x.item_id===config.item_id)){ledger[row.location_id]??={S:0,R:0,P:0,Q:0,B:0};ledger[row.location_id][row.bucket]+=row.delta;}
  for(const loc of new Set([...Object.keys(expected.locations),...Object.keys(actual),...Object.keys(ledger)]))for(const b of buckets){const wanted=expected.locations[loc]?.[b]??0,got=actual[loc]?.[b]??0,book=ledger[loc]?.[b]??0;if(wanted!==got)differences.push({kind:'physical_intent_vs_stock',location:loc,bucket:b,expected:wanted,actual:got});if(wanted!==book)differences.push({kind:'physical_intent_vs_ledger',location:loc,bucket:b,expected:wanted,actual:book});}
  const currentReservations=snapshot.orders.flatMap(x=>x.reservations??[]).filter(x=>x.item_id===config.item_id).reduce((n,x)=>n+x.quantity,0);
  if(currentReservations!==expected.totals.R)differences.push({kind:'reservation_reconciliation',expected:expected.totals.R,actual:currentReservations});
  for(const order of snapshot.orders)for(const line of order.lines??[])if(line.item_id===config.item_id){const remaining=line.quantity-line.cancelled-line.shipped;if(remaining<0)differences.push({kind:'order_conservation',order:order.id});}
  const external=new Map();for(const op of operations.filter(x=>x.status==='done'&&x.kind==='event')){const e=op.input;if(['receipt.create','receipt.update','order.create','order.update'].includes(e.event_type)){const key=e.event_type.split('.')[0]+':'+e.source_system+':'+e.external_entity_id;const previous=external.get(key);if(!previous||previous.revision<e.revision)external.set(key,e);}}
  for(const e of external.values()){const collection=e.event_type.startsWith('receipt.')?snapshot.receipts:snapshot.orders;const object=collection.find(x=>x.external_id===e.source_system+':'+e.external_entity_id);if(!object){differences.push({kind:'missing_external_object',external_id:e.external_entity_id});continue;}for(const line of e.payload.lines??[]){const actualLine=line.id?object.lines.find(x=>x.id===line.id):object.lines.find(x=>x.item_id===line.item_id);if(!actualLine||actualLine.quantity!==line.quantity)differences.push({kind:'external_intent_vs_object',external_id:e.external_entity_id,item_id:line.item_id,expected:line.quantity,actual:actualLine?.quantity});}}
  return {expected,actual,ledger,differences,passed:differences.length===0,boundary:{workflow_version:snapshot.version,ledger_rows:snapshot.ledger.length,at:new Date().toISOString()}};
}
