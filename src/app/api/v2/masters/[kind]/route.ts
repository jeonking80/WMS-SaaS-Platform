import { withRequestLog } from '@/server/request-log';
import { masterHttp } from '@/server/v2/masters/http';
type Context={params:Promise<{kind:string}>};
export const GET=withRequestLog('v2.masters.collection.get',(request:Request,context:Context)=>masterHttp(request,context,'collection'));
export const POST=withRequestLog('v2.masters.collection.post',(request:Request,context:Context)=>masterHttp(request,context,'collection'));
