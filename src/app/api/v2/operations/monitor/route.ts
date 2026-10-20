import {withRequestLog} from '@/server/request-log';
import {monitorHttp} from '@/server/v2/operations/monitor';
export const dynamic='force-dynamic';
export const GET=withRequestLog('v2.operations.monitor',monitorHttp);
