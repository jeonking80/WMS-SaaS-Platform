import { randomUUID } from 'node:crypto';
export const VERSION='2.0.0';
export const scenarios={mixed_pattern:'설정형 혼합 · 부족/파손/오스캔 비율과 실물 대사',partial:'T01 · 부분 수령·검수·적치 (AC-01/02)',overage:'T01 · 과납105·다른 승인자 승인·5 해제/적치',overage_reject:'T01 · 과납105·반려·보류5 유지',concurrent:'T02 · 재고100에 주문80 두 건 동시 전체예약',cycle:'T03 · 20 피킹·15/5 포장·15 출하',cancel:'T04 · 포장 후5 취소·출하 차단·반납·15 출하',damage:'T06 · 파손2·대체피킹·10 출하 (AC-23)',wrongscan:'T06 · 오품목 스캔 무효과·정상 재실행',count:'T06 · 장부10·실사8·재계수·다른 승인자 -2',returns:'T05 · 배송실패·반품5 승인·3수령·2마감',revision:'T08 · revision3→1→2 순서역전·중복',receiving_load:'반복 수령·검수·적치 · 전체 원장 커서 대사',supply:'가상 거래처 · seed 기반 주문/예정 패턴 공급 (실물 작업 별도)'};
export function seeded(seed){let value=seed>>>0;return()=>{value=(Math.imul(value,1664525)+1013904223)>>>0;return value/4294967296;};}
export function validateConfig(c){
  const uuid=v=>typeof v==='string'&&/^[a-f0-9-]{36}$/i.test(v);
  if(!Object.hasOwn(scenarios,c.scenario)||!['human','auto','mixed'].includes(c.mode)||!['warehouse_id','item_id','receiving_id','storage_id','staging_id','hold_id'].every(k=>uuid(c[k]))||!Number.isSafeInteger(c.seed)||!Number.isInteger(c.delay_ms)||c.delay_ms<100||c.delay_ms>60000)throw Error('시나리오·모드·기준정보·seed·간격을 확인하세요.');
  const count=Number(c.event_count??10),min=Number(c.quantity_min??1),max=Number(c.quantity_max??100);if(!Number.isInteger(count)||count<1||count>10000||!Number.isInteger(min)||!Number.isInteger(max)||min<1||max<min||max>1000000)throw Error('사건수 1~10000, 정수 수량 범위를 확인하세요.');
  const outage=Number(c.outage_seconds??0);if(!Number.isInteger(outage)||outage<0||outage>120)throw Error('통신중단은 0~120초로 지정하세요.');
  const workers=Number(c.worker_count??1);if(!Number.isInteger(workers)||workers<1||workers>10)throw Error('자동 작업자는1~10명으로 지정하세요.');
  if(![c.supplier_id,c.customer_id,c.destination_id].every(uuid)||![c.expected_at,c.due_at].every(x=>typeof x==='string'&&Number.isFinite(Date.parse(x))))throw Error('공급처·납품처·배송지·예정일·납기를 선택하세요.');
  const ratios={};for(const name of ['shortage_ratio','damage_ratio','wrong_scan_ratio','delay_ratio','duplicate_ratio','response_loss_ratio']){const fallback=name==='duplicate_ratio'&&c.duplicate?1:name==='response_loss_ratio'&&c.lose_response?1:0;const value=Number(c[name]??fallback);if(!Number.isFinite(value)||value<0||value>1)throw Error('비율은0~100%로 지정하세요.');ratios[name]=value;}
  const timing={};for(const name of ['worker_interval_ms','event_delay_ms','handover_after_ms','interrupt_after_operations']){const value=Number(c[name]??0);if(!Number.isSafeInteger(value)||value<0||value>(name==='handover_after_ms'?86400000:60000))throw Error('시간/중단 설정 범위를 확인하세요.');timing[name]=value;}
  const working_start=c.working_start??'00:00',working_end=c.working_end??'24:00';if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(working_start)||!/^(([01]\d|2[0-3]):[0-5]\d|24:00)$/.test(working_end))throw Error('근무시간은HH:MM으로 지정하세요.');const worker_role=c.worker_role??'worker';if(!['worker','supervisor'].includes(worker_role))throw Error('작업자 역할을 확인하세요.');if(c.scenario==='mixed_pattern'&&count>100)throw Error('혼합 실물 시나리오는최대100업무로 분리하세요.');
  if(c.scenario!=='mixed_pattern'&&['shortage_ratio','damage_ratio','wrong_scan_ratio'].some(k=>ratios[k]>0))throw Error('부족·파손·오스캔 비율은 설정형 혼합 시나리오에서 지정하세요.');
  if(ratios.delay_ratio>0&&timing.event_delay_ms===0)throw Error('지연비율을 사용하려면 추가 지연시간을 지정하세요.');
  if(timing.handover_after_ms&&workers<2)throw Error('인계 시험은 서로 다른 작업자 키 2개 이상이 필요합니다.');
  if(worker_role==='supervisor'&&workers!==1)throw Error('책임자 역할 시험은 별도 책임자 키 1개로 실행합니다.');
  return {scenario:c.scenario,mode:c.mode,seed:c.seed,delay_ms:c.delay_ms,event_count:count,quantity_min:min,quantity_max:max,outage_seconds:outage,worker_count:workers,worker_role,working_start,working_end,...ratios,...timing,warehouse_id:c.warehouse_id,item_id:c.item_id,receiving_id:c.receiving_id,storage_id:c.storage_id,staging_id:c.staging_id,hold_id:c.hold_id,supplier_id:c.supplier_id,customer_id:c.customer_id,destination_id:c.destination_id,expected_at:c.expected_at,due_at:c.due_at,duplicate:!!c.duplicate,lose_response:!!c.lose_response};
}
function buildPlan(runId,c,source){
  const ops=[],item=c.item_id;const ref=name=>({$ref:name});
  const add=(kind,label,input,role='worker')=>ops.push({id:randomUUID(),kind,label,role,input});
  const event=(type,external,revision,payload)=>add('event',type,{schema_version:'2.0',event_id:randomUUID(),source_system:source,external_entity_id:`${runId}:${external}`,revision,event_type:type,occurred_at:new Date().toISOString(),correlation_id:runId,run_id:runId,warehouse_id:c.warehouse_id,payload:{...(type==='receipt.create'?{supplier_id:c.supplier_id,expected_at:c.expected_at}:{}),...(type==='order.create'?{delivery:{partner_id:c.customer_id,delivery_destination_id:c.destination_id},due_at:c.due_at}:{}),...payload}},'source');
  const command=(command,payload,bind,role='worker',expect_error)=>add('command',command,{warehouse_id:c.warehouse_id,command,request_id:randomUUID(),payload:{...payload,execution_mode:'automated'},bind,expect_error},role);
  if(c.scenario==='mixed_pattern'){
    const random=seeded(c.seed);const receive=(label,q)=>{event('receipt.create',label,1,{lines:[{item_id:item,quantity:q}]});command('receipt.receive',{receipt_id:ref('receipt.id'),receiving_id:randomUUID(),lines:[{line_id:ref('receipt.lines.0.id'),quantity:q,location_id:c.receiving_id}]});command('receipt.inspect',{receipt_id:ref('receipt.id'),lines:[{lot_id:ref('receipt.lots.0.id'),quantity:q,outcome:'normal'}]});command('receipt.putaway',{receipt_id:ref('receipt.id'),lines:[{lot_id:ref('receipt.lots.0.id'),quantity:q,location_id:c.storage_id}]});};
    for(let i=0;i<c.event_count;i++){
      const q=c.quantity_min+Math.floor(random()*(c.quantity_max-c.quantity_min+1)),short=random()<c.shortage_ratio,damage=random()<c.damage_ratio,wrong=random()<c.wrong_scan_ratio,damaged=damage?Math.max(1,Math.floor(q/5)):0;
      if(!short)receive('initial-'+i,q+damaged);
      event('order.create','order-'+i,1,{lines:[{item_id:item,quantity:q}]});
      const reserve=(quantity,reservation=0)=>command('order.reserve',{order_id:ref('order.id'),partial:false,lines:[{line_id:ref('order.lines.0.id'),quantity,location_id:c.storage_id}]});
      if(short){command('order.reserve',{order_id:ref('order.id'),partial:false},undefined,'worker','INSUFFICIENT_STOCK');receive('replenish-'+i,q+damaged);}
      reserve(q);
      const pick=(quantity,index=0,wrongItem=false)=>command('order.pick',{order_id:ref('order.id'),lines:[{reservation_id:ref('order.reservations.'+index+'.id'),quantity,location_id:c.staging_id,scanned_item_id:wrongItem?randomUUID():item,scanned_location_id:c.storage_id}]},undefined,'worker',wrongItem?'WRONG_ITEM_SCAN':undefined);
      if(wrong)pick(q,0,true);pick(q);
      if(damage){command('order.damage',{order_id:ref('order.id'),lines:[{pick_id:ref('order.picks.0.id'),quantity:damaged,location_id:c.hold_id}],reason:'설정된 파손비율에 따른 실물 격리'},undefined,'approver');reserve(damaged,1);pick(damaged,1);}
      command('package.create',{order_id:ref('order.id'),lines:[...(q-damaged>0?[{pick_id:ref('order.picks.0.id'),quantity:q-damaged}]:[]),...(damage?[{pick_id:ref('order.picks.1.id'),quantity:damaged}]:[])]},'package');
      command('shipment.create',{package_ids:[ref('package.id')],handover_by:'Simulated operator',carrier:'SIM-PATTERN'},'shipment');
      ops.at(-1).options={pattern:{shortage:short,damage,wrong_scan:wrong,quantity:q}};
    }return ops;
  }
  if(c.scenario==='supply'){const random=seeded(c.seed);for(let i=0;i<c.event_count;i++){const type=random()<0.7?'order':'receipt';const quantity=c.quantity_min+Math.floor(random()*(c.quantity_max-c.quantity_min+1));event(type+'.create',type+'-'+i,1,{lines:[{item_id:item,quantity}]});}return ops;}
  if(c.scenario==='receiving_load'){const random=seeded(c.seed);for(let i=0;i<c.event_count;i++){const quantity=c.quantity_min+Math.floor(random()*(c.quantity_max-c.quantity_min+1));event('receipt.create','receipt-'+i,1,{lines:[{item_id:item,quantity}]});command('receipt.receive',{receipt_id:ref('receipt.id'),receiving_id:randomUUID(),lines:[{line_id:ref('receipt.lines.0.id'),quantity,location_id:c.receiving_id}]});command('receipt.inspect',{receipt_id:ref('receipt.id'),lines:[{lot_id:ref('receipt.lots.0.id'),quantity,outcome:'normal'}]});command('receipt.putaway',{receipt_id:ref('receipt.id'),lines:[{lot_id:ref('receipt.lots.0.id'),quantity,location_id:c.storage_id}]});}return ops;}
  const isOverage=c.scenario.startsWith('overage');const incoming=c.scenario==='partial'||isOverage||c.scenario==='concurrent'?100:c.scenario==='damage'?12:c.scenario==='count'?10:20;
  event('receipt.create','receipt',1,{lines:[{item_id:item,quantity:incoming}]});
  command('receipt.receive',{receipt_id:ref('receipt.id'),receiving_id:randomUUID(),...(isOverage?{reason:'예정 초과5EA 실물 도착·보류 수령'}:{}),lines:[{line_id:ref('receipt.lines.0.id'),quantity:c.scenario==='partial'?60:isOverage?105:incoming,location_id:c.receiving_id,hold_location_id:c.hold_id}]},'received');
  if(isOverage){
    command('receipt.putaway',{receipt_id:ref('receipt.id'),lines:[{lot_id:ref('receipt.lots.1.id'),quantity:5,location_id:c.storage_id}]},undefined,'worker','INSPECTION_REQUIRED');
    command('overage.request',{lot_id:ref('receipt.lots.1.id'),quantity:5,reason:'초과 도착분 5EA 인수 요청'},'approval');
    command('approval.decide',{approval_id:ref('approval.id'),approve:true,reason:'작업자 승인권한 차단 확인'},undefined,'worker','SCOPE_FORBIDDEN');
    command('approval.decide',{approval_id:ref('approval.id'),approve:c.scenario==='overage',reason:'다른 승인자의 과납 검토'},undefined,'approver');
    if(c.scenario==='overage'){
      command('hold.release',{lot_id:ref('receipt.lots.1.id'),quantity:5,location_id:c.receiving_id,reason:'승인된 초과실물 확인'});
      command('receipt.inspect',{receipt_id:ref('receipt.id'),lines:[{lot_id:ref('receipt.lots.1.id'),quantity:5,outcome:'normal'}]});
      command('receipt.putaway',{receipt_id:ref('receipt.id'),lines:[{lot_id:ref('receipt.lots.1.id'),quantity:5,location_id:c.storage_id}]});
    }return ops;
  }
  command('receipt.inspect',{receipt_id:ref('receipt.id'),lines:[{lot_id:ref('receipt.lots.0.id'),quantity:c.scenario==='partial'?55:incoming,outcome:'normal'},...(c.scenario==='partial'?[{lot_id:ref('receipt.lots.0.id'),quantity:5,outcome:'hold'}]:[])]});
  command('receipt.putaway',{receipt_id:ref('receipt.id'),lines:[{lot_id:ref('receipt.lots.0.id'),quantity:c.scenario==='partial'?30:incoming,location_id:c.storage_id}]});
  if(c.scenario==='partial')return ops;
  if(c.scenario==='concurrent'){
    for(const label of ['order_a','order_b']){event('order.create',label,1,{lines:[{item_id:item,quantity:80}]});ops.at(-1).label+='|'+label;}
    for(const label of ['order_a','order_b']){command('order.reserve',{order_id:ref(label+'.id'),partial:false,lines:[{line_id:ref(label+'.lines.0.id'),quantity:80,location_id:c.storage_id}]});ops.at(-1).input.parallel_group='reservation_race';ops.at(-1).input.allowed_error='INSUFFICIENT_STOCK';}
    return ops;
  }
  if(c.scenario==='count'){
    command('count.start',{location_id:c.storage_id},'count');
    command('count.record',{count_id:ref('count.id'),lines:[{item_id:item,bucket:'S',quantity:8}],recount:true,reason:'실물8 재계수'});
    command('count.submit',{count_id:ref('count.id'),reason:'2EA 차이 승인 요청'},'approval');
    command('approval.decide',{approval_id:ref('approval.id'),approve:true,reason:'다른 승인자의 재계수 검토'},undefined,'approver');return ops;
  }
  if(c.scenario==='revision'){
    // No worker operations needed for this external contract scenario.
    ops.splice(1);
    const lineId=randomUUID();
    event('order.update','order',3,{lines:[{id:lineId,item_id:item,quantity:3}]});
    event('order.create','order',1,{lines:[{id:lineId,item_id:item,quantity:1}]});
    event('order.update','order',2,{lines:[{id:lineId,item_id:item,quantity:2}]});
    return ops;
  }
  const ordered=c.scenario==='damage'?10:20;
  event('order.create','order',1,{lines:[{item_id:item,quantity:ordered}]});
  command('order.reserve',{order_id:ref('order.id'),partial:false});
  if(c.scenario==='wrongscan')command('order.pick',{order_id:ref('order.id'),lines:[{reservation_id:ref('order.reservations.0.id'),quantity:ordered,location_id:c.staging_id,scanned_item_id:randomUUID(),scanned_location_id:c.storage_id}]},undefined,'worker','WRONG_ITEM_SCAN');
  command('order.pick',{order_id:ref('order.id'),lines:[{reservation_id:ref('order.reservations.0.id'),quantity:ordered,location_id:c.staging_id,scanned_item_id:item,scanned_location_id:c.storage_id}]});
  if(c.scenario==='cancel'){
    command('package.create',{order_id:ref('order.id'),lines:[{pick_id:ref('order.picks.0.id'),quantity:20}]},'original_package');
    command('order.cancel',{order_id:ref('order.id'),lines:[{line_id:ref('order.lines.0.id'),quantity:5}],reason:'고객 잔량5 취소'});
    command('shipment.create',{package_ids:[ref('original_package.id')],handover_by:'Simulator',carrier:'SIM'},undefined,'worker','CANCELLATION_PENDING');
    command('package.unpack',{package_id:ref('original_package.id'),reason:'취소실물 반납 전 포장해제'});
    command('order.return_picked',{order_id:ref('order.id'),lines:[{pick_id:ref('order.picks.0.id'),quantity:5,location_id:c.storage_id,outcome:'normal'}],reason:'취소실물5 반납 확인'});
    command('package.create',{order_id:ref('order.id'),lines:[{pick_id:ref('order.picks.0.id'),quantity:15}]},'package');
    command('shipment.create',{package_ids:[ref('package.id')],handover_by:'Simulator',carrier:'SIM'},'shipment');return ops;
  }
  if(c.scenario==='damage'){
    command('order.damage',{order_id:ref('order.id'),lines:[{pick_id:ref('order.picks.0.id'),quantity:2,location_id:c.hold_id}],reason:'시나리오 파손 2EA'},undefined,'approver');
    command('order.reserve',{order_id:ref('order.id'),partial:false});
    command('order.pick',{order_id:ref('order.id'),lines:[{reservation_id:ref('order.reservations.1.id'),quantity:2,location_id:c.staging_id,scanned_item_id:item,scanned_location_id:c.storage_id}]});
    command('package.create',{order_id:ref('order.id'),lines:[{pick_id:ref('order.picks.0.id'),quantity:8},{pick_id:ref('order.picks.1.id'),quantity:2}]},'package');
  }else{
    command('package.create',{order_id:ref('order.id'),lines:[{pick_id:ref('order.picks.0.id'),quantity:15}]},'package');
    command('package.create',{order_id:ref('order.id'),lines:[{pick_id:ref('order.picks.0.id'),quantity:5}]},'package2');
  }
  command('shipment.create',{package_ids:[ref('package.id')],handover_by:'Simulator physical operator',carrier:'SIM-CARRIER'},'shipment');
  if(c.scenario==='returns'){
    event('shipment.delivery','shipment',1,{shipment_id:ref('shipment.id'),status:'failed',reason:'가상 배송 실패'});
    event('return.request','return',1,{shipment_id:ref('shipment.id'),lines:[{shipment_line_id:ref('shipment.lines.0.id'),quantity:5}],reason:'시험 고객 반품'});
    command('return.receive',{return_id:ref('return.id'),receiving_id:randomUUID(),lines:[{line_id:ref('return.lines.0.id'),quantity:3,location_id:c.receiving_id}]});
    command('return.close',{return_id:ref('return.id'),reason:'미수령 2EA 마감'});
    command('return.inspect',{return_id:ref('return.id'),lines:[{lot_id:ref('return.lots.0.id'),quantity:3,outcome:'normal'}]});
    command('return.putaway',{return_id:ref('return.id'),lines:[{lot_id:ref('return.lots.0.id'),quantity:3,location_id:c.storage_id}]});
  }
  return ops;
}
export function makePlan(runId,c,source){const ops=buildPlan(runId,c,source),random=seeded(c.seed+31);for(const op of ops){if(op.kind==='event')op.options={...op.options,duplicate:random()<(c.duplicate_ratio??(c.duplicate?1:0)),lose_response:random()<(c.response_loss_ratio??(c.lose_response?1:0)),delayed:random()<(c.delay_ratio??0)};else if(op.kind==='command')op.options={...op.options,lose_response:random()<(c.response_loss_ratio??(c.lose_response?1:0))};}return ops;}
export function resolveRefs(input,context){
  if(Array.isArray(input))return input.map(v=>resolveRefs(v,context));
  if(input&&typeof input==='object'){
    if(Object.keys(input).length===1&&typeof input.$ref==='string'){
      const result=input.$ref.split('.').reduce((obj,key)=>obj?.[key],context);if(result===undefined)throw Error('의존 작업 대기: '+input.$ref);return result;
    }
    return Object.fromEntries(Object.entries(input).map(([k,v])=>[k,resolveRefs(v,context)]));
  }
  return input;
}
