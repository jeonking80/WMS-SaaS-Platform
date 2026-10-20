import { withRequestLog } from '@/server/request-log';
import { DomainError,json,readBody,requireMutationOrigin } from '@/server/api';
import { processEvents } from '@/server/v2/integration';
import { integrationError,integrationReader } from '@/server/v2/integration/http';
export const runtime='nodejs';
export const POST=withRequestLog('v2.integration.process',async(request:Request)=>{try{if(!request.headers.has('authorization'))requireMutationOrigin(request);const body=await readBody(request);if(body.limit!==undefined&&(!Number.isInteger(body.limit)||Number(body.limit)<1||Number(body.limit)>50))throw new DomainError(400,'INVALID_LIMIT');const warehouse=String(body.warehouse_id??'');const identity=await integrationReader(request,warehouse,true);return json(await processEvents(identity,warehouse,Number(body.limit??25)));}catch(error){return integrationError(error);}});
