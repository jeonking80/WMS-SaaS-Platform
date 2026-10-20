import { withRequestLog } from '@/server/request-log';
import { DomainError, json, readBody } from '@/server/api';
import { authenticateV2Machine } from '@/server/v2/access';
import { acceptEvent,listEvents } from '@/server/v2/integration';
import { parseEvent } from '@/server/v2/integration/contract';
import { integrationError,integrationReader } from '@/server/v2/integration/http';
export const runtime='nodejs';
export const POST=withRequestLog('v2.integration.submit',async(request:Request)=>{try{const event=parseEvent(await readBody(request));const identity=await authenticateV2Machine(request.headers,'integration:event',event.warehouse_id);return json(await acceptEvent(identity,event),202);}catch(error){return integrationError(error);}});
export const GET=withRequestLog('v2.integration.list',async(request:Request)=>{
  try {
    const query=new URL(request.url).searchParams,warehouse=query.get('warehouse_id')??'';
    const identity=await integrationReader(request,warehouse);
    const external=query.get('external_entity_id'),alias=query.get('external_id');
    if(external!==null&&alias!==null&&external!==alias)throw new DomainError(400,'CONFLICTING_EXTERNAL_ID');
    const limit=query.get('limit');
    return json(await listEvents(identity,warehouse,{
      eventId:query.get('event_id')??undefined,externalId:external??alias??undefined,
      sourceSystem:query.get('source_system')??undefined,statuses:query.has('status')?query.get('status')!.split(','):undefined,
      cursor:query.get('cursor')??undefined,limit:limit===null?undefined:/^\d+$/.test(limit)?Number(limit):NaN,
    }));
  }catch(error){return integrationError(error);}
});
