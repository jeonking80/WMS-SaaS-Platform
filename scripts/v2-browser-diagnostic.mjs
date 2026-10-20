/** One instrumented read navigation. Diagnostic evidence only; never produces a performance pass. */
import {readFile,writeFile,mkdtemp,mkdir,cp,rm,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {performance} from 'node:perf_hooks';
import {setTimeout as delay} from 'node:timers/promises';
import pg from 'pg';
import {chromium,request,expect} from '@playwright/test';

const previous=JSON.parse(await readFile('docs/v2-performance-latest.json','utf8'));
if(previous.phase!=='measured'||previous.verdict!=='failed_local_read_profile')throw Error('Preserved failed measurement required');
try{await writeFile('docs/v2-performance-final-build-failure.json',JSON.stringify(previous,null,2)+'\n',{flag:'wx'});}catch(error){if(error.code!=='EEXIST')throw error;}
const currentBuild=(await readFile('.next/BUILD_ID','utf8')).trim();if(currentBuild!==previous.build_id)throw Error('Build changed');
const base=new URL(process.env.TEST_DATABASE_URL??''),credential=new URL(process.env.DATABASE_URL??'');
if(!['127.0.0.1','localhost','[::1]'].includes(base.hostname)||!decodeURIComponent(base.pathname).endsWith('_test')||!/^wms_v2_perf_[a-f0-9]{32}_test$/.test(previous.fixture.database))throw Error('Dedicated local fixture required');
base.pathname='/'+previous.fixture.database;
const owner=new pg.Client({connectionString:base.href});await owner.connect();
try{const marker=(await owner.query("SELECT shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=current_database()")).rows[0].marker;if(marker!=='wms-v2-performance:'+previous.run_id)throw Error('Fixture owner mismatch');}finally{await owner.end();}
base.username='wms_app';base.password=credential.password;
const port=3201,origin='http://127.0.0.1:'+port,tenant=previous.fixture.tenants.find(t=>t.company==='B');
const fixedLayout=process.argv.includes('--fixed-layout'),suffix=fixedLayout?'-fixed-layout':'';
let runtime,server,browser,auth;
const diagnostic={kind:'single instrumented browser navigation; not a new acceptance measurement',style_injection:fixedLayout?'stock table fixed layout with declared columns; same 1600 rows and trace buttons':'none',company:'B',build_id:currentBuild,fixture_run_id:previous.run_id,started_at:new Date().toISOString(),network:[]};
try{
 try{await fetch(origin+'/api/health',{signal:AbortSignal.timeout(1000)});throw Error('Port occupied');}catch(error){if(error.message==='Port occupied')throw error;}
 runtime=await mkdtemp(join(tmpdir(),'wms-v2-diagnostic-'));await cp('.next/standalone',runtime,{recursive:true});await mkdir(join(runtime,'.next'),{recursive:true});await cp('.next/static',join(runtime,'.next/static'),{recursive:true});if(await stat('public').then(()=>true).catch(()=>false))await cp('public',join(runtime,'public'),{recursive:true});
 server=spawn(process.execPath,[join(runtime,'server.js')],{cwd:runtime,env:{...process.env,NODE_ENV:'production',DATABASE_URL:base.href,BETTER_AUTH_URL:origin,WMS_ENVIRONMENT:'test',PORT:String(port),HOSTNAME:'127.0.0.1'},stdio:'ignore'});
 let ready=false;for(let i=0;i<100;i++){if(server.exitCode!==null)throw Error('Server exited');try{if((await fetch(origin+'/api/ready')).ok){ready=true;break;}}catch{}await delay(250);}if(!ready)throw Error('Not ready');
 auth=await request.newContext({baseURL:origin});const login=await auth.post('/api/auth/sign-in/email',{headers:{origin},data:{email:tenant.email,password:process.env.DEMO_PASSWORD}});if(!login.ok())throw Error('Login failed');
 browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH??'/usr/bin/chromium'});const context=await browser.newContext({baseURL:origin,storageState:await auth.storageState(),viewport:{width:1280,height:900}});
 await context.addInitScript(fixed=>{window.__v2diag=[];new PerformanceObserver(list=>{for(const e of list.getEntries())window.__v2diag.push({start_ms:e.startTime,duration_ms:e.duration,name:e.name});}).observe({type:'longtask',buffered:true});if(fixed)document.addEventListener('DOMContentLoaded',()=>{const style=document.createElement('style'),table='.v2 section.v2-card:has(> .v2-toolbar > h2) > .v2-table > table';style.textContent=table+'{table-layout:fixed;min-width:1240px;width:100%}'+table+' th:nth-child(1){width:220px}'+table+' th:nth-child(2){width:180px}'+table+' th:nth-child(n+3):nth-child(-n+9){width:64px}'+table+' th:nth-child(10){width:160px}'+table+' th:nth-child(11){width:220px}'+table+' td{overflow-wrap:anywhere}';document.head.append(style);});},fixedLayout);
 const page=await context.newPage();const section=()=>page.getByRole('heading',{name:'위치·품목별 재고',exact:true}).locator('xpath=ancestor::section[1]');
 await page.goto('/dashboard/v2');await page.getByRole('tab',{name:'재고·실사·승인',exact:true}).click();await expect(section().locator('tbody tr')).toHaveCount(1600);await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 const cdp=await context.newCDPSession(page);await cdp.send('Network.enable');const requests=new Map();let firstRequest;
 cdp.on('Network.requestWillBeSent',event=>{firstRequest??=event.timestamp;requests.set(event.requestId,{path:new URL(event.request.url).pathname,method:event.request.method,type:event.type,start_ms:(event.timestamp-firstRequest)*1000});});
 cdp.on('Network.responseReceived',event=>{const row=requests.get(event.requestId);if(row){row.status=event.response.status;row.headers_ms=(event.timestamp-firstRequest)*1000;const timing=event.response.timing;if(timing)row.server_wait_ms=timing.receiveHeadersEnd-timing.sendEnd;}});
 cdp.on('Network.loadingFinished',event=>{const row=requests.get(event.requestId);if(row){row.body_complete_ms=(event.timestamp-firstRequest)*1000;row.duration_ms=row.body_complete_ms-row.start_ms;row.encoded_bytes=event.encodedDataLength;}});
 await cdp.send('Tracing.start',{categories:'devtools.timeline,v8,blink.user_timing,disabled-by-default-devtools.timeline',transferMode:'ReturnAsStream'});
 const start=performance.now(),timings={};await page.goto('/dashboard/v2');timings.navigation_load_ms=performance.now()-start;
 const tab=page.getByRole('tab',{name:'재고·실사·승인',exact:true});await tab.waitFor({state:'visible'});timings.tab_visible_ms=performance.now()-start;
 await tab.click();timings.tab_click_completed_ms=performance.now()-start;
 await expect(section().locator('tbody tr')).toHaveCount(1600);await expect(section().locator('tbody tr').first()).toBeVisible();timings.stock_dom_ready_ms=performance.now()-start;
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));timings.two_frames_ms=performance.now()-start;
 diagnostic.timings=timings;diagnostic.dom=await section().evaluate(node=>({rows:node.querySelectorAll('tbody tr').length,cells:node.querySelectorAll('tbody td').length,buttons:node.querySelectorAll('button').length,descendants:node.querySelectorAll('*').length,table_layout:getComputedStyle(node.querySelector('table')).tableLayout,table_width:node.querySelector('table').getBoundingClientRect().width,column_widths:[...node.querySelectorAll('th')].map(cell=>cell.getBoundingClientRect().width)}));
 diagnostic.long_tasks=await page.evaluate(()=>window.__v2diag);diagnostic.navigation=await page.evaluate(()=>{const n=performance.getEntriesByType('navigation')[0];return {request_start_ms:n.requestStart,response_start_ms:n.responseStart,response_end_ms:n.responseEnd,dom_interactive_ms:n.domInteractive,dom_content_loaded_ms:n.domContentLoadedEventEnd,load_ms:n.loadEventEnd,transfer_bytes:n.transferSize};});
 diagnostic.network=[...requests.values()];
 const complete=new Promise(resolve=>cdp.once('Tracing.tracingComplete',resolve));await cdp.send('Tracing.end');const {stream}=await complete;let serialized='';for(;;){const chunk=await cdp.send('IO.read',{handle:stream});serialized+=chunk.base64Encoded?Buffer.from(chunk.data,'base64').toString('utf8'):chunk.data;if(chunk.eof)break;}await cdp.send('IO.close',{handle:stream});
 // Timeline structure is retained; event arguments that could contain request content are removed.
 const trace=JSON.parse(serialized),events=trace.traceEvents.map(e=>({name:e.name,cat:e.cat,ph:e.ph,ts:e.ts,dur:e.dur,pid:e.pid,tid:e.tid,args:['thread_name','process_name'].includes(e.name)?{name:e.args?.name}: {}}));
 await writeFile('docs/v2-performance-browser-timeline'+suffix+'.json',JSON.stringify({traceEvents:events}));
 diagnostic.trace_file='docs/v2-performance-browser-timeline'+suffix+'.json';const sums=new Map();for(const e of events)if(e.ph==='X'&&e.dur){const row=sums.get(e.name)??{count:0,inclusive_total_ms:0,max_ms:0};row.count++;row.inclusive_total_ms+=e.dur/1000;row.max_ms=Math.max(row.max_ms,e.dur/1000);sums.set(e.name,row);}diagnostic.trace_events=[...sums].map(([name,values])=>({name,...values})).sort((a,b)=>b.inclusive_total_ms-a.inclusive_total_ms).slice(0,35);diagnostic.trace_note='Inclusive nested durations overlap and cannot be summed into percentages. Cookies, headers, response bodies and script source are excluded.';
 const reportFile='docs/v2-performance-browser'+suffix+'-diagnostic.json';diagnostic.finished_at=new Date().toISOString();await writeFile(reportFile,JSON.stringify(diagnostic,null,2)+'\n');console.log(JSON.stringify({report:reportFile,timings,dom:diagnostic.dom}));
}finally{
 await browser?.close();await auth?.dispose();if(server&&server.exitCode===null){const exited=new Promise(resolve=>server.once('exit',resolve));server.kill('SIGTERM');await Promise.race([exited,delay(5000)]);if(server.exitCode===null){server.kill('SIGKILL');await exited;}}if(runtime)await rm(runtime,{recursive:true,force:true});
}
