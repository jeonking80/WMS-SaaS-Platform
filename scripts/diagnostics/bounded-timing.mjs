// Run only against the isolated schema-19 diagnostic clone after explicit operator go.
import {readFile,writeFile,rename,unlink} from 'node:fs/promises';
import {performance} from 'node:perf_hooks';
const [bindingPath,outputPath]=process.argv.slice(2);
if(!bindingPath||!outputPath||process.env.WMS_DIAGNOSTIC_GO!=='isolated-diag19')throw Error('Explicit isolated diagnostic activation required');
const results=[];let config,status='failed',reason_category='configuration',failureCategory='configuration';
const fail=category=>{failureCategory=category;throw Error('Bounded diagnostic stopped');};
try{
 config=JSON.parse(await readFile(bindingPath,'utf8'));
 if(config.diagnostic_only!==true||config.database_schema_version!==19||!/^[-_A-Za-z0-9]{1,150}$/.test(config.build_id)||!['off','on'].includes(config.instrumentation)||!Array.isArray(config.targets)||config.targets.length<1||config.targets.length>2)fail('configuration');
 for(const [index,t] of config.targets.entries()){
  const origin=new URL(t.url);
  if(!['localhost','127.0.0.1','[::1]'].includes(origin.hostname)||origin.port==='3021'||origin.username||origin.password)fail('target_safety');
  const key=name=>{const value=process.env[name];if(!value)fail('missing_private_binding');return value;};
  async function call(label,role,path,payload){
   const token=key(role),start=performance.now(),signal=AbortSignal.timeout(120000);let response,value;
   try{response=await fetch(new URL(path,origin),{method:payload?'POST':'GET',headers:{authorization:'Bearer '+token,'content-type':'application/json'},...(payload?{body:JSON.stringify(payload)}:{}),signal,redirect:'error'});value=await response.json();}
   catch{const category=signal.aborted?'request_timeout':response?'response_decode':'transport';results.push({target_index:index,label,status:response?.status??0,body_complete:false,elapsed_ms:performance.now()-start,reason_category:category});fail(category);}
   const row={target_index:index,label,status:response.status,body_complete:true,elapsed_ms:performance.now()-start};
   if(Array.isArray(value?.events))row.event_status_counts=Object.fromEntries(['applied','business_rejected','dependency_wait','retry_wait','quarantined','received'].map(s=>[s,value.events.filter(e=>e?.status===s).length]));
   results.push(row);if(!response.ok)fail('http_error');return value;
  }
  const info=await call('connection',t.source_key_env,'/api/v2/integration/connection');
  if(info?.environment!=='test'||info.test_company!==true||info.company_id!==t.company_id||!Array.isArray(info.warehouse_ids)||!info.warehouse_ids.includes(t.warehouse_id))fail('target_validation');
  await call('workflow_before',t.worker_key_envs[0],'/api/v2/workflow?warehouse_id='+encodeURIComponent(t.warehouse_id));
  for(const limit of [1,5,50])await call('process_limit_'+limit,t.process_key_env,'/api/v2/integration/process',{warehouse_id:t.warehouse_id,limit});
  await call('workflow_after',t.worker_key_envs[0],'/api/v2/workflow?warehouse_id='+encodeURIComponent(t.warehouse_id));
 }
 status='completed';reason_category=null;
}catch{reason_category=failureCategory;process.exitCode=1;}
finally{
 const targetCount=Array.isArray(config?.targets)?Math.min(2,config.targets.length):0;
 const report={diagnostic_only:true,qualification:false,status,reason_category,build_id:/^[-_A-Za-z0-9]{1,150}$/.test(config?.build_id)?config.build_id:null,instrumentation:['on','off'].includes(config?.instrumentation)?config.instrumentation:null,schema_version:19,generated_at:new Date().toISOString(),request_bound:targetCount*6,processing_selection_bound:targetCount*56,results,limitations:['Sequential tiny batches do not qualify congestion performance.','Limit is a maximum; dependency/retry eligibility can produce fewer events.','Client elapsed includes complete response JSON decoding.','Sequential on/off runs change backlog; overhead comparison needs equivalent restored copies and matching build/configuration.','Inclusive nested server spans must not be summed or subtracted as overhead.','Failures stop without retries; partial completed-request evidence is preserved.']};
 const temporary=outputPath+'.'+process.pid+'.tmp';
 try{await writeFile(temporary,JSON.stringify(report,null,2)+'\n',{mode:0o600,flag:'wx'});await rename(temporary,outputPath);}catch{await unlink(temporary).catch(()=>{});process.exitCode=1;console.error('Sanitized diagnostic report write failed');}
}
