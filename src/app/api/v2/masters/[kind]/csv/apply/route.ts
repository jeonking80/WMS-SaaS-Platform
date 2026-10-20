import { withRequestLog } from '@/server/request-log';
import { masterHttp } from '@/server/v2/masters/http';
export const POST=withRequestLog('v2.masters.apply.post',(request:Request,context:{params:Promise<{kind:string}>})=>masterHttp(request,context,'apply'));
