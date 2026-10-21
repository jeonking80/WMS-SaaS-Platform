import {apiError,json,readBody,requireMutationOrigin} from '@/server/api';
import {requireV2Identity} from '@/server/v2/access';
import {askAssistant,runDirectTool,type Turn} from '@/server/v2/assistant';
import {withRequestLog} from '@/server/request-log';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export const maxDuration=60;
// Read-only operator assistant. POST keeps questions out of URLs and logs; the origin check stops cross-site spend.
export const POST=withRequestLog('v2.assistant.ask',async(request:Request)=>{try{requireMutationOrigin(request);const body=await readBody(request) as {warehouse_id?:unknown;question?:unknown;history?:unknown;tool?:unknown;input?:unknown};const warehouse=typeof body.warehouse_id==='string'?body.warehouse_id:'';const identity=await requireV2Identity(request.headers,'read',warehouse);
 if(typeof body.tool==='string')return json(await runDirectTool(identity,warehouse,body.tool,body.input&&typeof body.input==='object'?body.input as Record<string,unknown>:{}));
 const history=Array.isArray(body.history)?body.history.filter((turn):turn is Turn=>Boolean(turn)&&typeof turn==='object'&&['user','assistant'].includes((turn as Turn).role)&&typeof (turn as Turn).content==='string'):[];
 return json(await askAssistant(identity,warehouse,typeof body.question==='string'?body.question:'',history));
}catch(e){return apiError(e);}});
