import {apiError,json} from '@/server/api';
import {requireV2Identity} from '@/server/v2/access';
import {withRequestLog} from '@/server/request-log';
import {inspectWorkflowCorrectionSource} from '@/server/v2/workflow/correction-source';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export const GET=withRequestLog('v2.workflow.correction-source',async(request:Request)=>{try{const p=new URL(request.url).searchParams;const warehouse=p.get('warehouse_id')??'';const identity=await requireV2Identity(request.headers,'read',warehouse);return json(await inspectWorkflowCorrectionSource(identity,warehouse,p.get('original_id')??undefined,{q:p.get('q')??undefined,item_id:p.get('item_id')??undefined,cursor:p.get('cursor')??undefined,limit:p.has('limit')?Number(p.get('limit')):undefined}));}catch(error){return apiError(error);}});
