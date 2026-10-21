import{randomUUID}from'node:crypto';import{clusterLifecycleReady}from'./cluster-request-lifecycle.mjs';
// IPC contains only local readiness and an untrusted-to-business correlation token.
export function clusterReadiness(localReady,runtime=process){
 if(runtime.env.WMS_CLUSTER_MANAGED!=='1')return Promise.resolve(localReady);
 if(!clusterLifecycleReady(runtime)||!runtime.connected||typeof runtime.send!=='function')return Promise.resolve(false);
 return new Promise(resolve=>{const nonce=randomUUID();let timer;const finish=value=>{clearTimeout(timer);runtime.removeListener('message',message);runtime.removeListener('disconnect',disconnect);resolve(value);};const disconnect=()=>finish(false);const message=value=>{if(value?.type==='wms.cluster.health.result'&&value.nonce===nonce)finish(localReady&&value.ready===true);};runtime.on('message',message);runtime.once('disconnect',disconnect);timer=setTimeout(()=>finish(false),1000);try{runtime.send({type:'wms.cluster.health.report',nonce,healthy:localReady},error=>{if(error)finish(false);});}catch{finish(false);}});
}
