import { withRequestLog } from '@/server/request-log';
import { masterHttp } from '@/server/v2/masters/http';
export const GET=withRequestLog('v2.masters.errors.get',(request:Request,context:{params:Promise<{kind:string}>})=>masterHttp(request,context,'errors'));
