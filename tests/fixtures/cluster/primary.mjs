import cluster from'node:cluster';import{fileURLToPath}from'node:url';import{createSupervisor}from'../../../deploy/cluster-supervisor.mjs';
const supervisor=createSupervisor(cluster,{exec:fileURLToPath(new URL('./worker.mjs',import.meta.url)),count:2,environment:{PATH:process.env.PATH,NODE_ENV:'production',PORT:'0'}});
cluster.on('message',(_worker,m)=>{if(m?.type==='fixture.slow.started'||m?.type==='fixture.received'||m?.type==='fixture.orphan.finished')process.send?.(m);});
cluster.on('listening',(_worker,address)=>process.send?.({type:'listening',port:address.port}));
process.on('message',message=>{if(message?.type==='status')process.send?.({type:'status',...supervisor.snapshot()});if(message?.type==='kill-slot'){const slot=supervisor.snapshot().slots.find(s=>s.slot===message.slot),worker=slot&&cluster.workers?.[slot.workerId];worker?.process.kill('SIGKILL');}});
for(const signal of['SIGTERM','SIGINT'])process.on(signal,()=>supervisor.stop());supervisor.start();
