/** Maximum ten read navigations, with all results retained. Never an acceptance rerun. */
import {readFile,writeFile,mkdtemp,mkdir,cp,rm,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {performance} from 'node:perf_hooks';
import {setTimeout as delay} from 'node:timers/promises';
import pg from 'pg';
import {chromium,request,expect} from '@playwright/test';
const failed=JSON.parse(await readFile('docs/v2-performance-latest-build-failure.json','utf8'));
const build=(await readFile('.next/BUILD_ID','utf8')).trim();if(failed.verdict!=='failed_local_read_profile'||build!==failed.build_id)throw Error('The preserved failed build must match');
const base=new URL(process.env.TEST_DATABASE_URL??''),credential=new URL(process.env.DATABASE_URL??'');
if(!['127.0.0.1','localhost','[::1]'].includes(base.hostname)||!decodeURIComponent(base.pathname).endsWith('_test')||!/^wms_v2_perf_[a-f0-9]{32}_test$/.test(failed.fixture.database))throw Error('Dedicated local fixture required');
base.pathname='/'+failed.fixture.database;const owner=new pg.Client({connectionString:base.href});await owner.connect();try{const marker=(await owner.query("SELECT shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=current_database()")).rows[0].marker;if(marker!=='wms-v2-performance:'+failed.run_id)throw Error('Fixture owner mismatch');}finally{await owner.end();}
base.username='wms_app';base.password=credential.password;const origin='http://127.0.0.1:3201',tenant=failed.fixture.tenants.find(t=>t.company==='A');
const reportPath='docs/v2-performance-browser-ce-spike-diagnostic.json',report={kind:'Ten instrumented A-company navigations, first one marked warmup. No pass verdict and no samples discarded.',build_id:build,fixture_run_id:failed.run_id,company:'A',started_at:new Date().toISOString(),limitations:['Instrumented diagnostics can change browser timing. They do not relabel the preserved 3730ms failure.','No trace was captured during the original failed sample; later spikes cannot prove its precise cause.','Only loopback HTTP reads and ordinary authentication/telemetry effects; no SQL fixture writes.'],samples:[]};
let runtime,server,browser,auth;
async function save(){await writeFile(reportPath,JSON.stringify(report,null,2)+'\n');}
try{
 try{await fetch(origin+'/api/health',{signal:AbortSignal.timeout(1000)});throw Error('Port occupied');}catch(error){if(error.message==='Port occupied')throw error;}
 runtime=await mkdtemp(join(tmpdir(),'wms-v2-spike-'));await cp('.next/standalone',runtime,{recursive:true});await mkdir(join(runtime,'.next'),{recursive:true});await cp('.next/static',join(runtime,'.next/static'),{recursive:true});if(await stat('public').then(()=>true).catch(()=>false))await cp('public',join(runtime,'public'),{recursive:true});
 server=spawn(process.execPath,[join(runtime,'server.js')],{cwd:runtime,env:{...process.env,NODE_ENV:'production',DATABASE_URL:base.href,BETTER_AUTH_URL:origin,WMS_ENVIRONMENT:'test',PORT:'3201',HOSTNAME:'127.0.0.1'},stdio:'ignore'});
 let ready=false;for(let i=0;i<100;i++){if(server.exitCode!==null)throw Error('Server exited');try{if((await fetch(origin+'/api/ready')).ok){ready=true;break;}}catch{}await delay(250);}if(!ready)throw Error('Server not ready');
 auth=await request.newContext({baseURL:origin});const login=await auth.post('/api/auth/sign-in/email',{headers:{origin},data:{email:tenant.email,password:process.env.DEMO_PASSWORD}});if(!login.ok())throw Error('Login failed');
 browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH??'/usr/bin/chromium'});const context=await browser.newContext({baseURL:origin,storageState:await auth.storageState(),viewport:{width:1280,height:900}});
 await context.addInitScript(()=>{window.__v2spike=[];new PerformanceObserver(list=>{for(const e of list.getEntries())window.__v2spike.push({start_ms:e.startTime,duration_ms:e.duration,name:e.name});}).observe({type:'longtask',buffered:true});});
 const page=await context.newPage(),cdp=await context.newCDPSession(page);await cdp.send('Network.enable');
 let requests=new Map(),firstRequest;
 cdp.on('Network.requestWillBeSent',e=>{firstRequest??=e.timestamp;const url=new URL(e.request.url);requests.set(e.requestId,{path:['http:','https:'].includes(url.protocol)?url.pathname.slice(0,180):url.protocol,method:e.request.method,type:e.type,start_ms:(e.timestamp-firstRequest)*1000});});
 cdp.on('Network.responseReceived',e=>{const row=requests.get(e.requestId);if(row){row.status=e.response.status;row.headers_ms=(e.timestamp-firstRequest)*1000;if(e.response.timing)row.server_wait_ms=e.response.timing.receiveHeadersEnd-e.response.timing.sendEnd;}});
 cdp.on('Network.loadingFinished',e=>{const row=requests.get(e.requestId);if(row){row.body_complete_ms=(e.timestamp-firstRequest)*1000;row.duration_ms=row.body_complete_ms-row.start_ms;row.encoded_bytes=e.encodedDataLength;}});
 for(let index=0;index<10;index++){
  requests=new Map();firstRequest=undefined;const sample={index:index+1,warmup:index===0,started_at:new Date().toISOString()},timings={};
  await cdp.send('Tracing.start',{categories:'devtools.timeline,v8,blink.user_timing,disabled-by-default-devtools.timeline',transferMode:'ReturnAsStream'});
  const start=performance.now();
  try{
   const response=await page.goto('/dashboard/v2');timings.navigation_load_ms=performance.now()-start;sample.navigation_status=response.status();
   const tab=page.getByRole('tab',{name:'재고·실사·승인',exact:true});await tab.waitFor({state:'visible'});timings.tab_visible_ms=performance.now()-start;await tab.click();timings.tab_click_completed_ms=performance.now()-start;
   const section=page.getByRole('heading',{name:'위치·품목별 재고',exact:true}).locator('xpath=ancestor::section[1]');await expect(section.locator('tbody tr').first()).toBeVisible();timings.stock_dom_ready_ms=performance.now()-start;
   await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));timings.two_frames_ms=performance.now()-start;
   sample.dom=await section.evaluate(node=>({rows:node.querySelectorAll('tbody tr').length,cells:node.querySelectorAll('tbody td').length,buttons:node.querySelectorAll('button').length,descendants:node.querySelectorAll('*').length,table_layout:getComputedStyle(node.querySelector('table')).tableLayout,table_width:node.querySelector('table').getBoundingClientRect().width}));if(sample.dom.rows!==1600)throw Error('Unexpected rendered rows');
   sample.long_tasks=await page.evaluate(()=>window.__v2spike);sample.ok=true;
  }catch(error){sample.ok=false;sample.error={code:/^[A-Z0-9_]{1,100}$/.test(error.code??'')?error.code:error.name};}
  sample.timings=timings;sample.network=[...requests.values()];
  const complete=new Promise(resolve=>cdp.once('Tracing.tracingComplete',resolve));await cdp.send('Tracing.end');const {stream}=await complete;let serialized='';for(;;){const chunk=await cdp.send('IO.read',{handle:stream});serialized+=chunk.base64Encoded?Buffer.from(chunk.data,'base64').toString('utf8'):chunk.data;if(chunk.eof)break;}await cdp.send('IO.close',{handle:stream});
  const trace=JSON.parse(serialized),events=trace.traceEvents.map(e=>({name:e.name,cat:e.cat,ph:e.ph,ts:e.ts,dur:e.dur,pid:e.pid,tid:e.tid,args:['thread_name','process_name'].includes(e.name)?{name:e.args?.name}:{}}));
  sample.trace_file=`docs/v2-performance-browser-ce-spike-timeline-${index+1}.json`;await writeFile(sample.trace_file,JSON.stringify({traceEvents:events}));const sums=new Map();for(const e of events)if(e.ph==='X'&&e.dur){const row=sums.get(e.name)??{count:0,inclusive_total_ms:0,max_ms:0};row.count++;row.inclusive_total_ms+=e.dur/1000;row.max_ms=Math.max(row.max_ms,e.dur/1000);sums.set(e.name,row);}sample.trace_events=[...sums].map(([name,values])=>({name,...values})).sort((a,b)=>b.inclusive_total_ms-a.inclusive_total_ms).slice(0,40);
  report.samples.push(sample);await save();console.log(JSON.stringify({sample:index+1,warmup:sample.warmup,ok:sample.ok,timings}));
 }
 report.finished_at=new Date().toISOString();await save();
}finally{
 await browser?.close();await auth?.dispose();if(server&&server.exitCode===null){const exited=new Promise(resolve=>server.once('exit',resolve));server.kill('SIGTERM');await Promise.race([exited,delay(5000)]);if(server.exitCode===null){server.kill('SIGKILL');await exited;}}if(runtime)await rm(runtime,{recursive:true,force:true});report.cleanup={server:'stopped',runtime:'removed',at:new Date().toISOString()};await save();
}
