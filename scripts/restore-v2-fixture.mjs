/** Synthetic restore data only: SQL fixtures exercise preservation, not workflow execution. */
import { createHash, randomUUID } from 'node:crypto';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
// Physical tables only; the compatibility view is validated separately.
export const v2Views = ['v2_workflow_state'];
export const v2Tables = ['v2_workflow_state_header','v2_workflow_object_state','v2_workflow_stock','v2_workflow_objects','v2_workflow_requests','v2_workflow_performances','v2_workflow_receivings','v2_workflow_ledger','v2_warehouse_grants','v2_identity_links','v2_machine_keys','v2_machine_warehouses','v2_identity_audit','business_partners','master_barcodes','master_csv_previews','master_csv_applies','master_csv_applied_rows','v2_integration_limits','v2_integration_entities','v2_integration_events','v2_cutovers','api_request_metrics','v2_opening_imports'];
export async function seedV2RestoreFixture(client, {tenant, foreign, warehouse, location, item, destination, user}) {
  let statementNumber=0;
  const query=async(sql,values)=>{statementNumber++;try{return await client.query(sql,values);}catch(error){error.restoreStage=`v2-fixture-statement-${statementNumber}`;throw error;}};
  const foreignWarehouse=randomUUID(),foreignLocation=randomUUID(),foreignItem=randomUUID();
  await query("UPDATE tenants SET is_test=true,idle_lock_minutes=7 WHERE id=$1",[tenant]);
  await query("INSERT INTO warehouses(id,tenant_id,code,name) VALUES($1,$2,'RESTORE','Foreign synthetic warehouse')",[foreignWarehouse,foreign]);
  await query("INSERT INTO locations(id,tenant_id,warehouse_id,code,name) VALUES($1,$2,$3,'RESTORE','Foreign synthetic location')",[foreignLocation,foreign,foreignWarehouse]);
  await query("INSERT INTO items(id,tenant_id,code,name) VALUES($1,$2,'RESTORE','Foreign synthetic item')",[foreignItem,foreign]);
  await query('INSERT INTO v2_warehouse_grants VALUES($1,$2,$3)',[tenant,user,warehouse]);
  await query("INSERT INTO v2_identity_links(tenant_id,user_id,kind,token_hash,expires_at,consumed_at,created_by) VALUES($1,$2,'reset',$3,CURRENT_TIMESTAMP-interval '1 hour',CURRENT_TIMESTAMP-interval '2 hours',$2)",[tenant,user,hash(randomUUID())]);
  const previousKey=randomUUID(),key=randomUUID();
  for (const [id,previous,revoked] of [[previousKey,null,true],[key,previousKey,false]]) {
    await query(`INSERT INTO v2_machine_keys(id,tenant_id,name,source_system,environment,kind,scopes,token_hash,expires_at,revoked_at,created_by,rotated_from)
      VALUES($1,$2,'Restore synthetic key','restore-source','test','integration',ARRAY['integration:event','integration:read'],$3,CURRENT_TIMESTAMP+interval '1 day',CASE WHEN $4 THEN CURRENT_TIMESTAMP ELSE NULL END,$5,$6)`,[id,tenant,hash(randomUUID()),revoked,user,previous]);
    await query('INSERT INTO v2_machine_warehouses VALUES($1,$2,$3)',[tenant,id,warehouse]);
  }
  await query("INSERT INTO v2_identity_audit(tenant_id,actor_id,target_id,action,details) VALUES($1,$2,$3,'key.rotated',$4::jsonb)",[tenant,user,key,JSON.stringify({previousKeyId:previousKey})]);
  const partner=randomUUID();
  await query("INSERT INTO business_partners(id,tenant_id,code,name,supplier,customer) VALUES($1,$2,'RESTORE','Synthetic partner',true,true)",[partner,tenant]);
  await query("UPDATE delivery_destinations SET partner_id=$2,external_code='restore-destination' WHERE id=$1",[destination,partner]);
  await query("INSERT INTO master_barcodes(tenant_id,barcode,item_id,unit,quantity) VALUES($1,'RESTORE-EA',$2,'EA',1),($1,'RESTORE-BOX12',$2,'BOX',12)",[tenant,item]);
  await query("INSERT INTO master_barcodes(tenant_id,barcode,location_id) VALUES($1,'RESTORE-LOCATION',$2)",[tenant,location]);
  const preview=randomUUID();
  await query("INSERT INTO master_csv_previews(id,tenant_id,warehouse_id,kind,request_key,fingerprint,rows) VALUES($1,$2,$3,'items','restore-preview',$4,$5::jsonb)",[preview,tenant,warehouse,hash('preview'),JSON.stringify([{row_number:1,code:'RESTORE',valid:true}])]);
  await query("INSERT INTO master_csv_applies(tenant_id,preview_id,request_key,fingerprint,result) VALUES($1,$2,'restore-apply',$3,$4::jsonb)",[tenant,preview,hash('apply'),JSON.stringify({applied:[1],replayed:false})]);
  await query("INSERT INTO master_csv_applied_rows VALUES($1,$2,1,$3::jsonb)",[tenant,preview,JSON.stringify({id:item})]);
  const request=randomUUID(),receipt=randomUUID(),order=randomUUID(),line=randomUUID(),receiving=randomUUID(),now=new Date().toISOString();
  const stock={item_id:item,location_id:location,S:50,R:10,P:5,Q:12,B:3};
  const state={version:1,stock:[stock],ledger:[],ledger_base:[stock],receipts:[{id:receipt,version:1,lines:[{id:line,item_id:item,quantity:20,received:15,cancelled:0,shipped:0}],lots:[],closed:false,created_at:now}],orders:[{id:order,version:1,lines:[{id:randomUUID(),item_id:item,quantity:15,received:0,cancelled:0,shipped:0}],reservations:[{id:randomUUID(),line_id:line,item_id:item,location_id:location,quantity:10,picked:0,reserved_at:now}],picks:[],delivery:{destination_id:destination},created_at:now}],packages:[],shipments:[],returns:[],approvals:[{id:randomUUID(),type:'receipt.close',requester_id:user,target_id:receipt,target_version:1,quantity:5,data:{},reason:'Synthetic pending approval',status:'pending'}],counts:[],tasks:[{id:randomUUID(),object_type:'receipt',object_id:receipt,assignee_id:user,reason:'Synthetic handover',assigned_at:now},{id:randomUUID(),object_type:'order',object_id:order,assignee_id:user,reason:'Synthetic ordered second task',assigned_at:now}],shifts:[],receiving_ids:[receiving],holds:[],location_blocks:[]};
  await query('INSERT INTO v2_workflow_state(tenant_id,warehouse_id,version,state) VALUES($1,$2,1,$3::jsonb)',[tenant,warehouse,JSON.stringify(state)]);
  await query('INSERT INTO v2_workflow_stock(tenant_id,warehouse_id,item_id,location_id,s,r,p,q,b) VALUES($1,$2,$3,$4,50,10,5,12,3)',[tenant,warehouse,item,location]);
  for(const[id,kind]of [[receipt,'receipt'],[order,'order']])await query('INSERT INTO v2_workflow_objects(tenant_id,warehouse_id,id,kind,external_id) VALUES($1,$2,$3,$4,$5)',[tenant,warehouse,id,kind,`restore-${kind}`]);
  const response={result:{id:receipt,receiving_id:receiving},version:1};
  await query("INSERT INTO v2_workflow_requests(tenant_id,warehouse_id,request_id,request_hash,command,actor_id,response) VALUES($1,$2,$3,$4,'restore.fixture',$5,$6::jsonb)",[tenant,warehouse,request,hash({warehouse,request}),user,JSON.stringify(response)]);
  await query("INSERT INTO v2_workflow_performances(tenant_id,warehouse_id,request_id,actor_id,command,evidence,reason) VALUES($1,$2,$3,$4,'restore.fixture',$5::jsonb,'Synthetic restore fixture')",[tenant,warehouse,request,user,JSON.stringify({receiving_id:receiving})]);
  await query('INSERT INTO v2_workflow_receivings VALUES($1,$2,$3,$4,$5)',[tenant,warehouse,receiving,request,receipt]);
  for(const[bucket,delta]of [['S',70],['S',-20],['R',10],['P',5],['Q',12],['B',3]])await query("INSERT INTO v2_workflow_ledger(id,tenant_id,warehouse_id,item_id,location_id,request_id,actor_id,command,bucket,delta,reason) VALUES($1,$2,$3,$4,$5,$6,$7,'restore.fixture',$8,$9,'Synthetic restore fixture')",[randomUUID(),tenant,warehouse,item,location,request,user,bucket,delta]);
  await query('INSERT INTO v2_integration_limits(tenant_id,rate_per_minute,queue_limit,window_count) VALUES($1,120,1000,2)',[tenant]);
  await query("INSERT INTO v2_integration_entities(tenant_id,source_system,entity_kind,external_entity_id,warehouse_id,revision,object_id) VALUES($1,'restore-source','receipt','restore-receipt',$2,1,$3)",[tenant,warehouse,receipt]);
  const events=[];
  for(const[revision,status]of [[1,'applied'],[2,'retry_wait']]) {
    const id=randomUUID();events.push(id);
    await query(`INSERT INTO v2_integration_events(id,tenant_id,source_system,warehouse_id,actor_id,source_key_id,event_id,entity_kind,external_entity_id,revision,event_type,schema_version,occurred_at,correlation_id,run_id,request_hash,revision_hash,payload,status,result,attempts,next_attempt_at,processed_at)
      VALUES($1,$2,'restore-source',$3,$4,$5,$6,'receipt','restore-receipt',$7,$8,'2.0',CURRENT_TIMESTAMP,'restore-correlation','restore-synthetic-run',$9,$10,$11::jsonb,$12,$13::jsonb,1,CURRENT_TIMESTAMP+interval '1 minute',CASE WHEN $12::varchar='applied' THEN CURRENT_TIMESTAMP ELSE NULL END)`,[id,tenant,warehouse,`machine:${key}`,key,randomUUID(),revision,revision===1?'receipt.create':'receipt.update',hash({id}),hash({revision}),JSON.stringify({warehouse_id:warehouse,lines:[{item_id:item,quantity:20}]}),status,revision===1?JSON.stringify({id:receipt}):null]);
  }
  for(const[status,error]of [[200,'OK'],[409,'WRONG_ITEM_SCAN']])await query("INSERT INTO api_request_metrics(tenant_id,warehouse_id,request_id,actor_id,operation,command,method,status,error_code,duration_ms) VALUES($1,$2,$3,$4,'v2.workflow.command','order.pick','POST',$5,$6,12)",[tenant,warehouse,randomUUID(),user,status,error]);
  // Preserve an intentional sequence gap as well as event ordering.
  await query("SELECT nextval('v2_integration_events_sequence_seq')");
  await query('INSERT INTO v2_cutovers(tenant_id,warehouse_id,snapshot_hash,opening,actor_id,request_id) VALUES($1,$2,$3,$4::jsonb,$5,$6)',[tenant,warehouse,hash(stock),JSON.stringify([stock]),user,randomUUID()]);
  const openingImports=[];
  for(const decision of ['approve','reject']){
    const csv='item_code,location_code,bucket,quantity\nRESTORE,RESTORE,S,70\n',sourceHash=createHash('sha256').update(csv).digest('hex'),parent=randomUUID();
    const original={source_system:'synthetic-restore-source',extracted_at:now,reason:'Synthetic original opening data',csv,source_hash:sourceHash,rows:[{item_id:item,location_id:location,item_code:'RESTORE',location_code:'RESTORE',bucket:'S',quantity:70}],errors:[],fingerprint:hash({parent,csv})};
    for(const[id,phase,parentId,payload]of [[parent,'request',null,original],[randomUUID(),decision,parent,{fingerprint:hash({parent,decision}),reason:`Synthetic ${decision} decision`,source_hash:sourceHash}]]){
      const requestId=randomUUID();await query('INSERT INTO v2_opening_imports(id,tenant_id,warehouse_id,request_id,phase,parent_id,payload,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8)',[id,tenant,warehouse,requestId,phase,parentId,JSON.stringify(payload),user]);
      openingImports.push({id,request_id:requestId,phase,parent_id:parentId,payload,actor_id:user});
    }
  }
  return {request,response,receipt,order,key,previousKey,events,foreignWarehouse,foreignItem,stock,state,openingImports};
}
export async function reconcileV2Restore(client) {
  const ledger=await client.query(`WITH l AS (SELECT tenant_id,warehouse_id,item_id,location_id,
    COALESCE(sum(delta) FILTER(WHERE bucket='S'),0) s,COALESCE(sum(delta) FILTER(WHERE bucket='R'),0) r,
    COALESCE(sum(delta) FILTER(WHERE bucket='P'),0) p,COALESCE(sum(delta) FILTER(WHERE bucket='Q'),0) q,COALESCE(sum(delta) FILTER(WHERE bucket='B'),0) b
    FROM v2_workflow_ledger GROUP BY 1,2,3,4)
    SELECT count(*)::int mismatches FROM v2_workflow_stock s FULL JOIN l USING(tenant_id,warehouse_id,item_id,location_id)
    WHERE COALESCE(s.s,0)<>COALESCE(l.s,0) OR COALESCE(s.r,0)<>COALESCE(l.r,0) OR COALESCE(s.p,0)<>COALESCE(l.p,0) OR COALESCE(s.q,0)<>COALESCE(l.q,0) OR COALESCE(s.b,0)<>COALESCE(l.b,0)`);
  const state=await client.query(`WITH projected AS (SELECT s.tenant_id,s.warehouse_id,(x->>'item_id')::uuid item_id,(x->>'location_id')::uuid location_id,
    (x->>'S')::bigint s,(x->>'R')::bigint r,(x->>'P')::bigint p,(x->>'Q')::bigint q,(x->>'B')::bigint b
    FROM v2_workflow_state s CROSS JOIN LATERAL jsonb_array_elements(s.state->'stock') x)
    SELECT count(*)::int mismatches FROM projected p FULL JOIN v2_workflow_stock s USING(tenant_id,warehouse_id,item_id,location_id)
    WHERE COALESCE(s.s,0)<>COALESCE(p.s,0) OR COALESCE(s.r,0)<>COALESCE(p.r,0) OR COALESCE(s.p,0)<>COALESCE(p.p,0) OR COALESCE(s.q,0)<>COALESCE(p.q,0) OR COALESCE(s.b,0)<>COALESCE(p.b,0)`);
  return {ledger_mismatches:ledger.rows[0].mismatches,state_mismatches:state.rows[0].mismatches};
}
