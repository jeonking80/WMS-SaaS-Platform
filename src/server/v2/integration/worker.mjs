// A separately supervised process calls the authenticated drain API. The queue and all
// retry schedules remain in PostgreSQL; this process can stop at any instruction.
const origin=new URL(process.env.WMS_URL??'http://127.0.0.1:3000');
if(origin.username||origin.password||!['https:','http:'].includes(origin.protocol))throw Error('Invalid WMS_URL');
const key=process.env.WMS_INTEGRATION_PROCESS_KEY,warehouses=(process.env.WMS_INTEGRATION_WAREHOUSE_IDS??'').split(',').filter(Boolean);
if(!key||!warehouses.length||warehouses.some(x=>!/^[a-f0-9-]{36}$/i.test(x)))throw Error('A processing key and explicit warehouse scope are required.');
let stop=false;for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{stop=true;});
let delay=1000;
while(!stop){
  for(const warehouse of warehouses){
    if(stop)break;
    try{
      const response=await fetch(new URL('/api/v2/integration/process',origin),{method:'POST',headers:{authorization:'Bearer '+key,'content-type':'application/json'},body:JSON.stringify({warehouse_id:warehouse,limit:50}),signal:AbortSignal.timeout(20000),redirect:'error'});
      if([401,403].includes(response.status))throw Error('PROCESSOR_AUTHORIZATION_FAILED');
      if(response.status===429){const retry=Number(response.headers.get('retry-after'));delay=Math.max(1000,Number.isFinite(retry)?retry*1000:1000);}
      else if(!response.ok)delay=Math.min(30000,delay*2);
      else{const result=await response.json();delay=result.events?.length===50?50:1000;}
    }catch(error){if(error.message==='PROCESSOR_AUTHORIZATION_FAILED'){console.error('Integration processor authorization failed. Review the processing key and warehouse scope.');process.exitCode=1;stop=true;break;}delay=Math.min(30000,delay*2);}
  }
  await new Promise(resolve=>setTimeout(resolve,delay));
}
