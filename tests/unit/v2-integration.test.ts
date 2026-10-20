import { describe,it,expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { canonical,hash,parseEvent,revisionHash,retryDelay } from '../../src/server/v2/integration/contract';
const event=()=>({schema_version:'2.0',event_id:randomUUID(),source_system:'SUPPLIER',external_entity_id:'PO-1',revision:1,event_type:'receipt.create',occurred_at:'2026-10-20T00:00:00Z',correlation_id:'test',warehouse_id:randomUUID(),payload:{lines:[{item_id:randomUUID(),quantity:100}]}});
describe('integration contract and durable retry policy',()=>{
 it('hashes object order canonically but preserves line order and quantity',()=>{expect(canonical({z:1,a:{b:2,a:3}})).toBe('{"a":{"a":3,"b":2},"z":1}');expect(hash({a:1,b:2})).toBe(hash({b:2,a:1}));expect(hash([1,2])).not.toBe(hash([2,1]));});
 it('separates event identity from semantic revision identity',()=>{const first=parseEvent(event());const second={...first,event_id:randomUUID()};expect(hash(first)).not.toBe(hash(second));expect(revisionHash(first)).toBe(revisionHash(second));expect(revisionHash({...first,payload:{lines:[]}})).not.toBe(revisionHash(first));});
 it('rejects impersonated companies, future schemas and oversized unbounded payloads',()=>{expect(()=>parseEvent({...event(),tenant_id:randomUUID()})).toThrow('UNKNOWN_EVENT_FIELD');expect(()=>parseEvent({...event(),payload:{company_id:randomUUID()}})).toThrow('COMPANY_FROM_CREDENTIAL_ONLY');expect(()=>parseEvent({...event(),schema_version:'1.0'})).toThrow('INVALID_EVENT');expect(()=>parseEvent({...event(),revision:1.5})).toThrow('INVALID_EVENT');expect(()=>parseEvent({...event(),payload:{text:'x'.repeat(140000)}})).toThrow('EVENT_TOO_LARGE');});
 it('never sends earlier than Retry-After and caps exponential jitter at thirty seconds',()=>{expect(retryDelay(10,0,()=>1)).toBe(30000);expect(retryDelay(2,120,()=>0)).toBe(120000);expect(retryDelay(0,0,()=>0)).toBe(500);});
});
