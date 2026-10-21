import{fork,type ChildProcess}from'node:child_process';import{once}from'node:events';import{describe,it,expect}from'vitest';
const delay=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function message(child:ChildProcess,type:string){return new Promise<any>((resolve,reject)=>{const timeout=setTimeout(()=>{child.off('message',listener);reject(Error('Fixture IPC timeout'));},10000);const listener=(m:any)=>{if(m?.type===type){clearTimeout(timeout);child.off('message',listener);resolve(m);}};child.on('message',listener);});}
describe('real cluster fixture (no database)',()=>{
 it('shares one port, samples both workers, replaces an exited slot and drains an in-flight response on termination',async()=>{
  const child=fork(new URL('../fixtures/cluster/primary.mjs',import.meta.url),[],{stdio:['ignore','ignore','ignore','ipc'],execArgv:[],env:{PATH:process.env.PATH,NODE_ENV:'production',NEXT_MANUAL_SIG_HANDLE:'1',NEXT_PRIVATE_WORKER:'1',NEXT_PRIVATE_PROMPT_OUTPUT:'1',__NEXT_PRIVATE_STANDALONE_CONFIG:'poison'}});
  try{const{port}=await message(child,'listening');const origin='http://127.0.0.1:'+port;let ready=false;for(let i=0;i<12&&!ready;i++){const response=await fetch(origin+'/api/ready',{headers:{connection:'close'}});await response.arrayBuffer();ready=response.ok;}expect(ready).toBe(true);
   const seen=new Map();for(let i=0;i<12&&seen.size<2;i++){const response=await fetch(origin+'/',{headers:{connection:'close'}});const body=await response.json();seen.set(body.slot,body);}expect([...seen.values()].map(x=>x.pool).sort()).toEqual([2,3]);for(const body of seen.values()){expect(body.unsafeFlagsPresent).toBe(false);expect(body.operationsBindingPresent).toBe(false);}const old=seen.get('0').pid;
   child.send({type:'kill-slot',slot:0});let replacement=false;for(let i=0;i<40&&!replacement;i++){await delay(100);try{const response=await fetch(origin+'/',{headers:{connection:'close'},signal:AbortSignal.timeout(1000)});const body=await response.json();replacement=body.slot==='0'&&body.pid!==old&&body.pool===3;}catch{}}expect(replacement).toBe(true);
   const received:unknown[]=[];const collect=(m:any)=>{if(m?.type==='fixture.received')received.push(m);};child.on('message',collect);await fetch(origin+'/received-then-crash',{method:'POST',body:'fixed-request',headers:{connection:'close'}}).catch(()=>{});await delay(1000);expect(received).toHaveLength(1);child.off('message',collect);
   const started=message(child,'fixture.slow.started');const slow=fetch(origin+'/slow',{headers:{connection:'close'}});await started;const exit=once(child,'exit');child.kill('SIGTERM');expect((await slow).status).toBe(200);expect((await exit)[0]).toBe(0);
  }finally{if(child.exitCode===null){if(!child.killed)child.kill('SIGTERM');await Promise.race([once(child,'exit'),delay(3000)]);if(child.exitCode===null)child.kill('SIGKILL');}}
 },20000);
 it('waits for a disconnected original request Promise before planned worker termination',async()=>{
  const child=fork(new URL('../fixtures/cluster/primary.mjs',import.meta.url),[],{stdio:['ignore','ignore','ignore','ipc'],execArgv:[],env:{PATH:process.env.PATH,NODE_ENV:'production'}});
  try{const{port}=await message(child,'listening');const controller=new AbortController();const started=message(child,'fixture.slow.started'),finished=message(child,'fixture.orphan.finished');const abandoned=fetch('http://127.0.0.1:'+port+'/orphan',{signal:controller.signal,headers:{connection:'close'}}).catch(()=>null);await started;controller.abort();await abandoned;const exit=once(child,'exit');child.kill('SIGTERM');await finished;expect((await exit)[0]).toBe(0);
  }finally{if(child.exitCode===null){if(!child.killed)child.kill('SIGTERM');await Promise.race([once(child,'exit'),delay(3000)]);if(child.exitCode===null)child.kill('SIGKILL');}}
 },15000);

});
