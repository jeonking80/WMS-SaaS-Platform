import { createHash } from 'node:crypto';
import { DomainError } from '../../api';

export const EVENT_TYPES = ['receipt.create','receipt.update','receipt.cancel','order.create','order.update','order.cancel','shipment.delivery','return.request'] as const;
export type EventType = typeof EVENT_TYPES[number];
export type IntegrationEvent = {schema_version:'2.0';event_id:string;source_system:string;external_entity_id:string;revision:number;event_type:EventType;occurred_at:string;correlation_id:string;run_id?:string;warehouse_id:string;payload:Record<string,unknown>};
export const uuid = (v:unknown):v is string => typeof v==='string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
export function canonical(value:unknown):string {
  if(Array.isArray(value)) return '['+value.map(canonical).join(',')+']';
  if(value && typeof value==='object') return '{'+Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>JSON.stringify(k)+':'+canonical(v)).join(',')+'}';
  return JSON.stringify(value);
}
export const hash=(value:unknown)=>createHash('sha256').update(canonical(value)).digest('hex');
export function parseEvent(value:Record<string,unknown>):IntegrationEvent {
  const text=(v:unknown,max=160)=>typeof v==='string'&&v.trim().length>0&&v.length<=max;
  if(value.schema_version!=='2.0'||!uuid(value.event_id)||!uuid(value.warehouse_id)||!text(value.source_system,100)||!text(value.external_entity_id)||!text(value.correlation_id)||!Number.isSafeInteger(value.revision)||Number(value.revision)<1||!EVENT_TYPES.includes(value.event_type as EventType)||!text(value.occurred_at)||!Number.isFinite(Date.parse(String(value.occurred_at)))||!value.payload||typeof value.payload!=='object'||Array.isArray(value.payload)||value.run_id!==undefined&&!text(value.run_id)) throw new DomainError(400,'INVALID_EVENT');
  if(Buffer.byteLength(JSON.stringify(value))>128*1024) throw new DomainError(413,'EVENT_TOO_LARGE');
  const allowed=new Set(['schema_version','event_id','source_system','external_entity_id','revision','event_type','occurred_at','correlation_id','run_id','warehouse_id','payload']);
  if(Object.keys(value).some(k=>!allowed.has(k))) throw new DomainError(400,'UNKNOWN_EVENT_FIELD');
  const result=value as IntegrationEvent;
  if('tenant_id' in result.payload||'company_id' in result.payload) throw new DomainError(400,'COMPANY_FROM_CREDENTIAL_ONLY');
  return result;
}
export function revisionHash(event:IntegrationEvent) {return hash({warehouse_id:event.warehouse_id,event_type:event.event_type,payload:event.payload});}
export function retryDelay(attempt:number,retryAfterSeconds=0,random=Math.random) {return Math.max(retryAfterSeconds*1000,Math.min(30_000,1000*2**Math.min(attempt,5))*(0.5+random()*0.5));}
