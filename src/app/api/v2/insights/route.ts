import {apiError,json} from '@/server/api';
import {requireV2Identity} from '@/server/v2/access';
import {getWarehouseInsights} from '@/server/v2/insights';
import {withRequestLog} from '@/server/request-log';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export const GET=withRequestLog('v2.insights.read',async(request:Request)=>{try{const warehouse=new URL(request.url).searchParams.get('warehouse_id')??'';const identity=await requireV2Identity(request.headers,'read',warehouse);return json(await getWarehouseInsights(identity,warehouse));}catch(e){return apiError(e);}});
