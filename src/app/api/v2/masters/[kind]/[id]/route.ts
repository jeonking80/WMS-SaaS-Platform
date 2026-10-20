import { withRequestLog } from '@/server/request-log';
import { masterHttp } from '@/server/v2/masters/http';
export const PATCH=withRequestLog('v2.masters.detail.patch',(request:Request,context:{params:Promise<{kind:string;id:string}>})=>masterHttp(request,context,'detail'));
