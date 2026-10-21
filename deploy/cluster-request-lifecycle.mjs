import{AsyncLocalStorage}from'node:async_hooks';import{randomUUID}from'node:crypto';
export class ClusterUnavailableError extends Error{constructor(){super('SERVICE_UNAVAILABLE');this.name='ClusterUnavailableError';this.code='SERVICE_UNAVAILABLE';this.status=503;}}
const key=Symbol.for('wms.cluster.request-lifecycle.v1');
function stateFor(runtime,globals){const state=globals[key];return runtime.env.WMS_CLUSTER_MANAGED==='1'&&state?.preloaded===true&&typeof state.draining==='boolean'&&typeof state.ack==='function'&&typeof state.context?.run==='function'&&typeof state.context?.getStore==='function'&&Number.isSafeInteger(state.active)&&state.active>=0?state:null;}
export function installClusterLifecycle(runtime=process,globals=globalThis){
 if(runtime.env.WMS_CLUSTER_MANAGED!=='1')return;if(stateFor(runtime,globals))return;
 const state={preloaded:true,active:0,draining:false,nonce:null,context:new AsyncLocalStorage()};globals[key]=state;
 state.ack=()=>{if(!state.draining||state.active!==0||!state.nonce||!runtime.connected)return;try{runtime.send({type:'wms.cluster.drain.ready',nonce:state.nonce},()=>{});}catch{}};
 runtime.on('message',message=>{if(message?.type!=='wms.cluster.drain'||typeof message.nonce!=='string'||message.nonce.length>100)return;state.draining=true;state.nonce=message.nonce;state.ack();});
}
export function clusterLifecycleReady(runtime=process,globals=globalThis){if(runtime.env.WMS_CLUSTER_MANAGED!=='1')return true;const state=stateFor(runtime,globals);return!!state&&!state.draining&&runtime.connected===true;}
export function trackClusterOperation(operation,unavailable,runtime=process,globals=globalThis){
 if(runtime.env.WMS_CLUSTER_MANAGED!=='1')return operation();
 const state=stateFor(runtime,globals);
 // Only live admission tokens authorize nested work after drain. Detached
 // descendants can retain ALS after their parent settles, but its token expires.
 const parent=state?.context.getStore(),nested=!!state&&parent?.state===state&&parent.live===true;
 if(!state||!nested&&!clusterLifecycleReady(runtime,globals))return Promise.resolve().then(unavailable);
 // Every child has its own count: an unawaited child must outlive its parent's
 // count without allowing the primary to acknowledge an early drain.
 const admission={state,live:true};state.active++;const finish=()=>{admission.live=false;state.active--;state.ack();};
 try{return Promise.resolve(state.context.run(admission,operation)).finally(finish);}catch(error){finish();throw error;}
}
export function trackClusterRequest(operation,runtime=process,globals=globalThis){return trackClusterOperation(operation,()=>{const requestId=randomUUID();try{console.info(JSON.stringify({event:'cluster_request_rejected',request_id:requestId,status:503,code:'SERVICE_UNAVAILABLE'}));}catch{}return Response.json({error:'SERVICE_UNAVAILABLE'},{status:503,headers:{'Cache-Control':'no-store','x-request-id':requestId}});},runtime,globals);}
