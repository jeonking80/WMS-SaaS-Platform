import {apiError,json,readBody,requireMutationOrigin} from '@/server/api';
import {requireIdentity} from '@/server/auth/access';
import {withRequestLog} from '@/server/request-log';
import {listOpeningImports,openingImport} from '@/server/v2/operations/opening-import';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export const GET=withRequestLog('v2.opening.list',async(request:Request)=>{
 try{return json(await listOpeningImports(await requireIdentity(request.headers),new URL(request.url).searchParams.get('warehouse_id')));}catch(e){return apiError(e);}
});
export const POST=withRequestLog('v2.opening.apply',async(request:Request)=>{
 try{requireMutationOrigin(request);return json(await openingImport(await requireIdentity(request.headers),await readBody(request)));}catch(e){return apiError(e);}
});
