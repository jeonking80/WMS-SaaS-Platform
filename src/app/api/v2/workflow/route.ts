import { apiError, json, readBody, requireMutationOrigin } from '@/server/api';
import { requireV2Identity } from '@/server/v2/access';
import { recordRequestCommand, withRequestLog } from '@/server/request-log';
import { executeWorkflow, getWorkflowRequest, getWorkflowSnapshot, parseWorkflowInput, workflowPermission } from '@/server/v2/workflow';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export const GET=withRequestLog('v2.workflow.read',async(request:Request)=>{try{const params=new URL(request.url).searchParams;const warehouse=params.get('warehouse_id')??'';const id=params.get('request_id');const identity=await requireV2Identity(request.headers,'read',warehouse);return json(id?await getWorkflowRequest(identity,warehouse,id):{snapshot:await getWorkflowSnapshot(identity,warehouse)});}catch(e){return apiError(e);}});
export const POST=withRequestLog('v2.workflow.command',async(request:Request)=>{try{const input=parseWorkflowInput(await readBody(request));recordRequestCommand(input.command);const identity=await requireV2Identity(request.headers,workflowPermission(input.command),input.warehouse_id);if(!request.headers.has('authorization'))requireMutationOrigin(request);return json(await executeWorkflow(identity,input));}catch(e){return apiError(e);}});
