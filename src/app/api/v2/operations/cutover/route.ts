import { apiError,json,readBody,requireMutationOrigin } from '@/server/api';
import { requireIdentity } from '@/server/auth/access';
import { withRequestLog } from '@/server/request-log';
import { activateCutover,previewCutover } from '@/server/v2/operations/cutover';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export const GET=withRequestLog('v2.cutover.preview',async(request:Request)=>{
 try{return json(await previewCutover(await requireIdentity(request.headers),new URL(request.url).searchParams.get('warehouse_id')??''));}catch(e){return apiError(e);}
});
export const POST=withRequestLog('v2.cutover.activate',async(request:Request)=>{
 try{requireMutationOrigin(request);return json(await activateCutover(await requireIdentity(request.headers),await readBody(request)));}catch(e){return apiError(e);}
});
