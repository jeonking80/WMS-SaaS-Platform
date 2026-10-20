import { withRequestLog } from '@/server/request-log';
import { json,readBody,requireMutationOrigin } from '@/server/api';
import { retryEvent } from '@/server/v2/integration';
import { integrationError,integrationReader } from '@/server/v2/integration/http';
import { uuid } from '@/server/v2/integration/contract';
export const runtime='nodejs';
export const POST=withRequestLog('v2.integration.retry',async(request:Request,context:{params:Promise<{id:string}>})=>{try{if(!request.headers.has('authorization'))requireMutationOrigin(request);const {id}=await context.params;if(!uuid(id))return json({error:'INVALID_EVENT_ID'},400);const body=await readBody(request);const warehouse=String(body.warehouse_id??'');const identity=await integrationReader(request,warehouse,true);return json(await retryEvent(identity,warehouse,id));}catch(error){return integrationError(error);}});
