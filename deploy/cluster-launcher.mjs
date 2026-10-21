import cluster from'node:cluster';import{fileURLToPath}from'node:url';import{workerCount,workerEnvironment,poolPartition}from'./web-process-options.mjs';import{createSupervisor}from'./cluster-supervisor.mjs';
if(!cluster.isPrimary)throw Error('Cluster launcher must run as primary');
if(process.env.NODE_ENV!=='production')throw Error('Cluster start mode requires production');
if(process.env.WMS_DB_POOL_MAX!==undefined)throw Error('Cluster start mode assigns pool slots; remove parent WMS_DB_POOL_MAX');
const count=workerCount();for(const[index,max]of poolPartition(count).entries())workerEnvironment(process.env,index,max);
const supervisor=createSupervisor(cluster,{exec:fileURLToPath(new URL('../server.js',import.meta.url)),count});
// Register first; shutdown state is set before any child signal is forwarded.
for(const signal of['SIGTERM','SIGINT'])process.on(signal,()=>supervisor.stop(0));
supervisor.start();
