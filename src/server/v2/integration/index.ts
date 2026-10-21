import type { PoolClient } from 'pg';
import type { Identity } from '../../auth/access';
import { DomainError } from '../../api';
import { AccessError } from '../../auth/access';
import { assertV2MachineKeyInTransaction } from '../access';
import { withTenant } from '../../db/tenant';
import { executeWorkflowInTransaction } from '../workflow';
import { hash, revisionHash, retryDelay, uuid, type IntegrationEvent } from './contract';
import {beginTiming,observeTimingCount,timeAsync} from '../../timing-diagnostics';

export type IntegrationIdentity = Identity & {sourceSystem?:string;keyId?:string};
type EventRow = IntegrationEvent & {id:string;sequence:string;tenant_id:string;entity_kind:string;actor_id:string;source_key_id:string;request_hash:string;revision_hash:string;status:string;reason:string|null;result:unknown;attempts:number;received_at:string;processed_at:string|null};
const visible=(row:EventRow)=>({id:row.id,sequence:row.sequence,event_id:row.event_id,source_system:row.source_system,warehouse_id:row.warehouse_id,event_type:row.event_type,external_entity_id:row.external_entity_id,revision:row.revision,status:row.status,reason:row.reason,result:row.result,attempts:row.attempts,received_at:row.received_at,processed_at:row.processed_at});
export class BackpressureError extends DomainError {constructor(public retryAfter:number){super(429,'INTEGRATION_BACKPRESSURE');}}

// Limits are locked before all enqueue decisions; two API instances cannot spend the same budget.
export async function acceptEvent(identity:IntegrationIdentity,event:IntegrationEvent) {
  if(identity.sourceSystem!==event.source_system) throw new DomainError(403,'SOURCE_SYSTEM_FORBIDDEN');
  return withTenant(identity.tenant.id,async client=>{
    await client.query('INSERT INTO v2_integration_limits(tenant_id) VALUES($1) ON CONFLICT DO NOTHING',[identity.tenant.id]);
    const {rows:[limit]}=await client.query('SELECT *,now() AS server_now FROM v2_integration_limits WHERE tenant_id=$1 FOR UPDATE',[identity.tenant.id]);
    const prior=await client.query<EventRow>('SELECT * FROM v2_integration_events WHERE tenant_id=$1 AND source_system=$2 AND event_id=$3',[identity.tenant.id,event.source_system,event.event_id]);
    if(prior.rows[0]) {if(prior.rows[0].request_hash!==hash(event))throw new DomainError(409,'EVENT_CONTENT_CONFLICT');return {event:visible(prior.rows[0]),replayed:true};}
    const kind=event.event_type.split('.')[0];
    const previousRevision=await client.query<EventRow>('SELECT * FROM v2_integration_events WHERE tenant_id=$1 AND source_system=$2 AND entity_kind=$3 AND external_entity_id=$4 AND revision=$5',[identity.tenant.id,event.source_system,kind,event.external_entity_id,event.revision]);
    if(previousRevision.rows[0]) {if(previousRevision.rows[0].revision_hash!==revisionHash(event))throw new DomainError(409,'REVISION_CONTENT_CONFLICT');return {event:visible(previousRevision.rows[0]),replayed:true};}
    const now=new Date(limit.server_now).getTime(),start=new Date(limit.window_start).getTime();
    const inWindow=now-start<60000;
    if(inWindow && limit.window_count>=limit.rate_per_minute)throw new BackpressureError(Math.max(1,Math.ceil((start+60000-now)/1000)));
    const {rows:[pending]}=await client.query(`SELECT count(*)::int AS count FROM v2_integration_events WHERE tenant_id=$1 AND status IN ('accepted','dependency_wait','retry_wait')`,[identity.tenant.id]);
    if(pending.count>=limit.queue_limit)throw new BackpressureError(5);
    await client.query('UPDATE v2_integration_limits SET window_count=$2,window_start=CASE WHEN $3 THEN window_start ELSE now() END WHERE tenant_id=$1',[identity.tenant.id,inWindow?limit.window_count+1:1,inWindow]);
    if(!identity.keyId)throw new DomainError(403,'MACHINE_KEY_REQUIRED');
    const inserted=await client.query<EventRow>(`INSERT INTO v2_integration_events(tenant_id,source_system,warehouse_id,actor_id,source_key_id,event_id,entity_kind,external_entity_id,revision,event_type,schema_version,occurred_at,correlation_id,run_id,request_hash,revision_hash,payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,[identity.tenant.id,event.source_system,event.warehouse_id,identity.user.id,identity.keyId,event.event_id,kind,event.external_entity_id,event.revision,event.event_type,event.schema_version,event.occurred_at,event.correlation_id,event.run_id??null,hash(event),revisionHash(event),event.payload]);
    return {event:visible(inserted.rows[0]),replayed:false};
  });
}

export const EVENT_STATUSES = ['accepted','dependency_wait','applied','business_rejected','retry_wait','quarantined'] as const;
export type EventListOptions = {eventId?:string;externalId?:string;sourceSystem?:string;statuses?:string[];cursor?:string;limit?:number};
export async function listEvents(identity:IntegrationIdentity,warehouseId:string,options:EventListOptions={}) {
  const cursor=options.cursor??'0',limit=options.limit??100;
  if(!uuid(warehouseId))throw new DomainError(400,'WAREHOUSE_REQUIRED');
  if(!/^\d{1,19}$/.test(cursor)||BigInt(cursor)>9223372036854775807n)throw new DomainError(400,'INVALID_CURSOR');
  if(!Number.isInteger(limit)||limit<1||limit>100)throw new DomainError(400,'INVALID_LIMIT');
  if(options.eventId!==undefined&&!uuid(options.eventId))throw new DomainError(400,'INVALID_EVENT_ID');
  if(options.externalId!==undefined&&(!options.externalId.trim()||options.externalId.length>160))throw new DomainError(400,'INVALID_EXTERNAL_ID');
  if(options.sourceSystem!==undefined&&(!options.sourceSystem.trim()||options.sourceSystem.length>100))throw new DomainError(400,'INVALID_SOURCE_SYSTEM');
  if(options.statuses!==undefined&&(!options.statuses.length||options.statuses.some(status=>!EVENT_STATUSES.includes(status as typeof EVENT_STATUSES[number]))))throw new DomainError(400,'INVALID_EVENT_STATUS');
  if(identity.sourceSystem&&options.sourceSystem!==undefined&&options.sourceSystem!==identity.sourceSystem)throw new DomainError(403,'SOURCE_SYSTEM_FORBIDDEN');
  return withTenant(identity.tenant.id,async client=>{
    // One statement gives page and full-scope counts the same MVCC snapshot.
    // Materialize only lightweight identifiers; payload/results are fetched for the page.
    const result=await client.query<EventRow & {total_count:number;filtered_count:number;status_counts:Record<string,number>;has_more:boolean}>(`
      WITH scope AS MATERIALIZED (
        SELECT id,sequence,status FROM v2_integration_events
        WHERE tenant_id=$1 AND warehouse_id=$2
          AND ($3::text IS NULL OR source_system=$3)
          AND ($4::uuid IS NULL OR event_id=$4 OR id=$4)
          AND ($5::text IS NULL OR external_entity_id=$5)
      ), filtered AS MATERIALIZED (
        SELECT * FROM scope WHERE $6::text[] IS NULL OR status=ANY($6)
      ), page AS MATERIALIZED (
        SELECT * FROM filtered WHERE sequence>$7::bigint ORDER BY sequence LIMIT ($8::int+1)
      ), summary AS (
        SELECT (SELECT count(*)::int FROM scope) AS total_count,
          (SELECT count(*)::int FROM filtered) AS filtered_count,
          COALESCE((SELECT jsonb_object_agg(status,n) FROM (SELECT status,count(*)::int AS n FROM scope GROUP BY status) counts),'{}'::jsonb) AS status_counts,
          (SELECT count(*)>$8::int FROM page) AS has_more
      )
      SELECT events.*,summary.total_count,summary.filtered_count,summary.status_counts,summary.has_more
      FROM summary LEFT JOIN (
        SELECT e.* FROM (SELECT * FROM page ORDER BY sequence LIMIT $8::int) p
        JOIN v2_integration_events e ON e.id=p.id
      ) events ON true ORDER BY events.sequence`,
      [identity.tenant.id,warehouseId,identity.sourceSystem??options.sourceSystem??null,options.eventId??null,options.externalId??null,options.statuses??null,cursor,limit]);
    const summary=result.rows[0],rows=result.rows.filter(row=>row.id!==null);
    const counts:Record<string,number>=Object.fromEntries(EVENT_STATUSES.map(status=>[status,0]));
    Object.assign(counts,summary.status_counts);
    return {events:rows.map(visible),cursor:rows.at(-1)?.sequence??cursor,has_more:summary.has_more,total_count:summary.total_count,filtered_count:summary.filtered_count,status_counts:counts};
  });
}

async function resolveInput(client:PoolClient,event:EventRow,objectId:string|null) {
  const payload={...event.payload};
  if(event.event_type.endsWith('.create')) payload.external_id=`${event.source_system}:${event.external_entity_id}`;
  if(event.event_type.startsWith('receipt.')&&!event.event_type.endsWith('.create')) payload.receipt_id=objectId;
  if(event.event_type.startsWith('order.')&&!event.event_type.endsWith('.create')) payload.order_id=objectId;
  if(event.event_type==='shipment.delivery') {
    // Shipments originate from physical handover, never from an external message.
    const target=event.payload.shipment_id;
    if(typeof target!=='string')throw new DomainError(409,'SHIPMENT_REFERENCE_REQUIRED');
    payload.shipment_id=target;payload.revision=event.revision;
  }
  if(event.event_type==='return.request' && typeof event.payload.shipment_id!=='string')throw new DomainError(409,'SHIPMENT_REFERENCE_REQUIRED');
  void client;
  return {warehouse_id:event.warehouse_id,command:event.event_type,request_id:event.id,payload};
}

// One warehouse is serialized by a transaction-scoped advisory lock. No processing state lives in RAM.
export async function processEvents(identity:IntegrationIdentity,warehouseId:string,limit=25) {
  const endBatch=beginTiming('integration.batch');try{
  const output=[];
  for(let i=0;i<Math.max(1,Math.min(50,limit));i++) {
    const item=await withTenant(identity.tenant.id,async client=>{
      const endEvent=beginTiming('integration.event');try{
      const lock=await timeAsync('integration.queue_sql',()=>client.query<{locked:boolean}>(`SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS locked`,['v2-integration:'+identity.tenant.id+':'+warehouseId]));
      if(!lock.rows[0].locked) return null;
      const pending=await timeAsync('integration.queue_sql',()=>client.query<EventRow>(`SELECT * FROM v2_integration_events WHERE tenant_id=$1 AND warehouse_id=$2 AND status IN ('accepted','dependency_wait','retry_wait') AND next_attempt_at<=now() ORDER BY next_attempt_at,sequence FOR UPDATE SKIP LOCKED LIMIT 1`,[identity.tenant.id,warehouseId]));
      const event=pending.rows[0];if(!event)return null;observeTimingCount('integration.events',1);
      await timeAsync('integration.entity_sql',()=>client.query(`INSERT INTO v2_integration_entities(tenant_id,source_system,entity_kind,external_entity_id,warehouse_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,[identity.tenant.id,event.source_system,event.entity_kind,event.external_entity_id,warehouseId]));
      const {rows:[entity]}=await timeAsync('integration.entity_lock',()=>client.query(`SELECT * FROM v2_integration_entities WHERE tenant_id=$1 AND source_system=$2 AND entity_kind=$3 AND external_entity_id=$4 FOR UPDATE`,[identity.tenant.id,event.source_system,event.entity_kind,event.external_entity_id]));
      let status='applied',reason:string|null=null,result:unknown=null;
      if(entity.warehouse_id!==warehouseId) {status='business_rejected';reason='EXTERNAL_ENTITY_WAREHOUSE_CONFLICT';}
      else if(event.revision>entity.revision+1) {status='dependency_wait';reason='MISSING_PREVIOUS_REVISION';}
      else if(event.revision<=entity.revision) {status='business_rejected';reason='STALE_REVISION';}
      else {
        await client.query('SAVEPOINT integration_business');
        try {
          const sourceIdentity=await timeAsync('integration.source_authorization',()=>assertV2MachineKeyInTransaction(client,identity.tenant.id,event.source_key_id,'integration:event',warehouseId));
          if(!entity.object_id && event.event_type.match(/^(receipt|order)\.(update|cancel)$/)) throw new DomainError(409,'EXTERNAL_ENTITY_NOT_CREATED');
          if(entity.object_id&&event.event_type.endsWith('.create')) throw new DomainError(409,'EXTERNAL_ENTITY_ALREADY_CREATED');
          const input=await timeAsync('integration.resolve',()=>resolveInput(client,event,entity.object_id));
          const actor={...sourceIdentity,user:{id:event.actor_id,name:'External integration',email:''},role:'worker' as const};
          const applied=await executeWorkflowInTransaction(client,actor,input,{includeSnapshot:false});
          result=applied.result;
          const id=typeof applied.result==='object'&&applied.result&&'id' in applied.result?String(applied.result.id):entity.object_id;
          await client.query('UPDATE v2_integration_entities SET revision=$5,object_id=COALESCE(object_id,$6::uuid) WHERE tenant_id=$1 AND source_system=$2 AND entity_kind=$3 AND external_entity_id=$4',[identity.tenant.id,event.source_system,event.entity_kind,event.external_entity_id,event.revision,id]);
          await client.query('RELEASE SAVEPOINT integration_business');
        }catch(error){
          await client.query('ROLLBACK TO SAVEPOINT integration_business');
          if(error instanceof DomainError && error.code==='NOT_FOUND' && ['shipment.delivery','return.request'].includes(event.event_type)) {status='dependency_wait';reason='MISSING_SHIPMENT_DEPENDENCY';}
          else if((error instanceof DomainError && error.status<500)||error instanceof AccessError) {status='business_rejected';reason=error.code;
            // A business rejection consumes its revision; corrected intent needs a new revision.
            await client.query('UPDATE v2_integration_entities SET revision=$5 WHERE tenant_id=$1 AND source_system=$2 AND entity_kind=$3 AND external_entity_id=$4',[identity.tenant.id,event.source_system,event.entity_kind,event.external_entity_id,event.revision]);
          } else {status=event.attempts>=5?'quarantined':'retry_wait';reason='RETRYABLE_PROCESSING_FAILURE';}
        }
      }
      const delay=status==='dependency_wait'?1000:status==='retry_wait'?retryDelay(event.attempts):0;
      const updated=await timeAsync('integration.status_sql',()=>client.query<EventRow>(`UPDATE v2_integration_events SET status=$2::varchar,reason=$3,result=$4,attempts=attempts+CASE WHEN $2::varchar='dependency_wait' THEN 0 ELSE 1 END,next_attempt_at=now()+$5::double precision*interval '1 millisecond',processed_at=CASE WHEN $2::varchar IN ('applied','business_rejected','quarantined') THEN now() ELSE NULL END WHERE id=$1 RETURNING *`,[event.id,status,reason,result,delay]));
      if(status==='applied'||status==='business_rejected')await client.query(`UPDATE v2_integration_events SET next_attempt_at=now() WHERE tenant_id=$1 AND source_system=$2 AND entity_kind=$3 AND external_entity_id=$4 AND status='dependency_wait'`,[identity.tenant.id,event.source_system,event.entity_kind,event.external_entity_id]);
      return visible(updated.rows[0]);
      }catch(error){endEvent(true);throw error;}finally{endEvent();}
    });
    if(!item)break;output.push(item);const outcome=({applied:'integration.applied',business_rejected:'integration.business_rejected',dependency_wait:'integration.dependency_wait',retry_wait:'integration.retry_wait',quarantined:'integration.quarantined'} as Record<string,string>)[item.status];if(outcome)observeTimingCount(outcome,1);
  }
  return {events:output};
  }catch(error){endBatch(true);throw error;}finally{endBatch();}
}

export async function retryEvent(identity:IntegrationIdentity,warehouseId:string,id:string) {
  return withTenant(identity.tenant.id,async client=>{
    const updated=await client.query<EventRow>(`UPDATE v2_integration_events SET status='retry_wait',reason='OPERATOR_RETRY',attempts=0,next_attempt_at=now(),processed_at=NULL WHERE tenant_id=$1 AND warehouse_id=$2 AND id=$3 AND status IN ('quarantined','dependency_wait','retry_wait') RETURNING *`,[identity.tenant.id,warehouseId,id]);
    if(!updated.rows[0])throw new DomainError(409,'EVENT_NOT_RETRYABLE');return {event:visible(updated.rows[0])};
  });
}
