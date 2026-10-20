import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve,dirname } from 'node:path';
import { openStore } from './store.mjs';
import { createRunner,HttpFailure } from './runner.mjs';
import { scenarios,resolveRefs } from './planner.mjs';
import { compareReports } from './scheduling.mjs';
const root=dirname(fileURLToPath(import.meta.url));
const host=process.env.SIM_HOST??'127.0.0.1',port=Number(process.env.SIM_PORT??4310),token=process.env.SIM_UI_TOKEN??'';
if(!['127.0.0.1','localhost','::1'].includes(host)&&token.length<24)throw Error('원격배포에는 24자 이상 SIM_UI_TOKEN 이 필요합니다.');
const url=new URL(process.env.WMS_URL??'http://127.0.0.1:3000');if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw Error('Invalid WMS_URL');
const store=openStore(resolve(root,process.env.SIM_DATABASE??'data/simulator.sqlite'));
const runner=createRunner(store,{url:url.origin,companyId:process.env.WMS_COMPANY_ID,sourceKey:process.env.WMS_SOURCE_KEY,processKey:process.env.WMS_PROCESS_KEY,workerKey:process.env.WMS_WORKER_KEY,workerKeys:(process.env.WMS_WORKER_KEYS??'').split(',').filter(Boolean),approverKey:process.env.WMS_APPROVER_KEY,supervisorKey:process.env.WMS_SUPERVISOR_KEY,prepareKey:process.env.WMS_PREPARE_KEY});
const equal=(a,b)=>{const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y);};
function send(res,value,status=200,headers={}){res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store',...headers});res.end(JSON.stringify(value));}
async function body(req){let input='';for await(const data of req){input+=data;if(Buffer.byteLength(input)>65536)throw new HttpFailure(413,'BODY_TOO_LARGE');}try{return JSON.parse(input||'{}');}catch{throw new HttpFailure(400,'INVALID_JSON');}}
const server=createServer(async(req,res)=>{
  try{
    const requestUrl=new URL(req.url,'http://'+req.headers.host);
    const allowedOrigin=process.env.SIM_PUBLIC_ORIGIN??`http://${req.headers.host}`;
    const allowedHosts=new Set(['127.0.0.1','localhost','[::1]',...(process.env.SIM_PUBLIC_ORIGIN?[new URL(process.env.SIM_PUBLIC_ORIGIN).hostname]:[])]);
    if(!allowedHosts.has(requestUrl.hostname))throw new HttpFailure(403,'HOST_FORBIDDEN');
    if(req.method==='POST'&&req.headers.origin!==allowedOrigin)throw new HttpFailure(403,'ORIGIN_FORBIDDEN');
    if(req.method==='POST'&&requestUrl.pathname==='/api/login'){
      const data=await body(req);if(!token||!equal(String(data.token??''),token))throw new HttpFailure(401,'INVALID_ACCESS_TOKEN');
      return send(res,{ok:true},200,{'set-cookie':`sim_access=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/${allowedOrigin.startsWith('https:')?'; Secure':''}`});
    }
    if(requestUrl.pathname.startsWith('/api/')&&token){const cookie=req.headers.cookie?.split(';').map(x=>x.trim()).find(x=>x.startsWith('sim_access='))?.slice(11)??'';if(!equal(decodeURIComponent(cookie),token))throw new HttpFailure(401,'SIMULATOR_LOGIN_REQUIRED');}
    if(req.method==='GET'&&requestUrl.pathname==='/api/state')return send(res,{settings:{wms_url:url.origin,company_id:process.env.WMS_COMPANY_ID??'',configured:{source:!!process.env.WMS_SOURCE_KEY,process:!!process.env.WMS_PROCESS_KEY,worker:!!(process.env.WMS_WORKER_KEY||process.env.WMS_WORKER_KEYS),approver:!!process.env.WMS_APPROVER_KEY,supervisor:!!process.env.WMS_SUPERVISOR_KEY,prepare:!!process.env.WMS_PREPARE_KEY}},scenarios,runs:store.list().map(run=>({...run,context:undefined,handover_pending:run.context.handover_pending??null,operations:store.operations(run.id).map(op=>{let payload;try{payload=resolveRefs(op.input,run.context);}catch{payload=op.input;}return {id:op.id,ordinal:op.ordinal,label:op.label,kind:op.kind,role:op.role,status:op.status,attempts:op.attempts,next_at:op.next_at,error:op.error,input:payload,result:op.kind==='event'?{status:op.result?.status,reason:op.result?.reason,id:op.result?.id}:undefined};}),observations:store.observations(run.id).slice(-100)}))});
    if(req.method==='GET'&&requestUrl.pathname==='/api/compare'){const left=store.run(requestUrl.searchParams.get('left')),right=store.run(requestUrl.searchParams.get('right'));if(!left||!right)throw new HttpFailure(404,'RUN_NOT_FOUND');return send(res,compareReports(left,right));}
    if(req.method==='GET'&&requestUrl.pathname==='/api/connection')return send(res,await runner.connection());
    if(req.method==='GET'&&requestUrl.pathname==='/api/masters'){
      const wh=requestUrl.searchParams.get('warehouse_id');if(!/^[a-f0-9-]{36}$/i.test(wh??''))throw new HttpFailure(400,'WAREHOUSE_REQUIRED');
      const [items,locations,partners,destinations]=await Promise.all(['items','locations','partners','destinations'].map(kind=>runner.api('worker',`/api/v2/masters/${kind}?warehouse_id=${wh}&active=true`)));return send(res,{items:items.rows,locations:locations.rows,partners:partners.rows,destinations:destinations.rows});
    }
    if(req.method==='POST'&&requestUrl.pathname==='/api/prepare-item'){
      const data=await body(req);if(typeof data.code!=='string'||typeof data.name!=='string'||!data.code.trim()||!data.name.trim()||data.code.length>64||data.name.length>128)throw new HttpFailure(400,'CODE_NAME_REQUIRED');
      return send(res,await runner.api('prepare','/api/v2/masters/items?warehouse_id='+data.warehouse_id,{code:data.code,name:data.name}));
    }
    if(req.method==='POST'&&requestUrl.pathname==='/api/runs')return send(res,await runner.create(await body(req)),201);
    const match=requestUrl.pathname.match(/^\/api\/runs\/([a-f0-9-]{36})\/(resume|pause|human|handover|report)$/i);
    if(match){const [,id,action]=match;if(!store.run(id))throw new HttpFailure(404,'RUN_NOT_FOUND');
      if(req.method==='GET'&&action==='report'){const report=store.run(id).report;if(!report)throw new HttpFailure(409,'PAUSE_AND_GENERATE_REPORT_FIRST');return send(res,report,200,{'content-disposition':`attachment; filename="wms-simulator-${id}.json"`});}
      if(req.method==='POST'){if(action==='resume')return send(res,await runner.resume(id));if(action==='pause'){runner.pause(id);return send(res,{ok:true});}if(action==='handover')return send(res,await runner.handover(id,await body(req)));if(action==='human')return send(res,await runner.humanComplete(id,await body(req)));if(action==='report'){runner.pause(id);if(store.operations(id).some(x=>x.status==='unconfirmed'))throw new HttpFailure(409,'RESOLVE_UNCONFIRMED_REQUESTS_FIRST');return send(res,await runner.finish(id));}}
    }
    const assets={'/':'index.html','/app.js':'app.js','/style.css':'style.css'};if(req.method==='GET'&&assets[requestUrl.pathname]){res.writeHead(200,{'content-type':requestUrl.pathname.endsWith('.js')?'text/javascript':requestUrl.pathname.endsWith('.css')?'text/css':'text/html; charset=utf-8','cache-control':'no-store','content-security-policy':"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",'x-content-type-options':'nosniff'});res.end(await readFile(resolve(root,'public',assets[requestUrl.pathname])));return;}
    send(res,{error:'NOT_FOUND'},404);
  }catch(error){send(res,{error:error instanceof HttpFailure?error.message:error instanceof Error&&/^[가-힣]/.test(error.message)?error.message:'SIMULATOR_UNAVAILABLE'},error.status??503);}
});
runner.start();server.listen(port,host,()=>console.log(`WMS simulator listening on ${host}:${port}. Credentials are environment-only.`));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{runner.stop();server.close(()=>{store.close();process.exit(0);});});
