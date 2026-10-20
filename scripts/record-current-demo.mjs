/** Local-only synthetic 16.2 walkthrough; never records login credentials. */
import { chromium, expect } from '@playwright/test';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
const origin = new URL(process.env.DEMO_ORIGIN ?? 'http://127.0.0.1:3100').origin;
const db = new URL(process.env.MIGRATION_DATABASE_URL ?? 'invalid:');
if (!['localhost','127.0.0.1'].includes(new URL(origin).hostname) || !['localhost','127.0.0.1'].includes(db.hostname) || !['/wms_lite','/wms_test'].includes(db.pathname)) throw Error('Recording requires loopback app and isolated local wms_lite/wms_test database.');
if (!process.env.DEMO_PASSWORD) throw Error('DEMO_PASSWORD required; inject using .env.local.');
const directory = resolve(process.env.DEMO_VIDEO_DIR ?? 'artifacts/current-demo');
await mkdir(directory,{recursive:true});
const pool = new pg.Pool({connectionString:db.href,max:1});
const browser = await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined});
const auth = await browser.newContext({baseURL:origin});
const ids={documents:[],items:[],warehouses:[],locations:[]};
const prefix=`SCENE-${randomUUID().slice(0,8)}`;
const result={scenario:'16.2',synthetic:true,origin,checks:[],completed:false,capturedAt:new Date().toISOString()};
let recording;
async function call(context,path,data,status=200,method='post') {
 const r=await context.request[method](path,{headers:{origin},data});
 if(r.status()!==status) throw Error(`${method} ${path}: expected ${status}, got ${r.status()}`);
 return r.json();
}
async function login(context,email) {
 for(let i=0;i<4;i++) {const r=await context.request.post('/api/auth/sign-in/email',{headers:{origin},data:{email,password:process.env.DEMO_PASSWORD}}); if(r.ok())return; if(r.status()!==429)throw Error(`Login HTTP ${r.status()}`); await new Promise(r=>setTimeout(r,10250));}
 throw Error('Login rate limit persisted');
}
async function master(kind,name,extra={}) {const row=(await call(auth,`/api/${kind}`,{code:`${prefix}-${name}`,name,...extra},201))[kind==='items'?'item':kind==='warehouses'?'warehouse':'location'];ids[kind].push(row.id);return row.id;}
async function document(kind,quantity,extra) {const row=(await call(auth,'/api/documents',{kind,warehouse_id:warehouse,note:prefix,lines:[{item_id:item,quantity}],...extra},201)).document;ids.documents.push(row.id);return row;}
let warehouse,item,source,destination;
try {
 await login(auth,'admin.a@example.test');
 const me=await call(auth,'/api/me',undefined,200,'get');
 if(me.tenant?.id!=='00000000-0000-4000-8000-000000000001'||me.role!=='admin')throw Error('Expected synthetic tenant A admin');
 warehouse=await master('warehouses','시연창고');item=await master('items','시연품목');source=await master('locations','입고',{warehouse_id:warehouse});destination=await master('locations','이동',{warehouse_id:warehouse});
 const inbound=await document('INBOUND',100,{destination_location_id:source});
 const outbound=await document('OUTBOUND',30,{source_location_id:source,recipient_name:'합성 납품처',delivery_address:'합성 시연 배송지'});
 const transfer=await document('TRANSFER',20,{source_location_id:source,destination_location_id:destination});
 recording=await browser.newContext({baseURL:origin,storageState:await auth.storageState(),viewport:{width:1440,height:1000},recordVideo:{dir:directory,size:{width:1440,height:1000}}});
 recording.setDefaultTimeout(15000);const page=await recording.newPage();const started=Date.now();
 async function caption(text,seconds=8){await page.evaluate(text=>{let el=document.getElementById('demo-caption');if(!el){el=document.createElement('div');el.id='demo-caption';document.body.appendChild(el);}el.textContent=text;el.style.cssText='pointer-events:none;position:fixed;bottom:18px;left:18px;right:18px;z-index:99999;background:#10243a;color:white;padding:15px;border-radius:8px;font:20px sans-serif';},text);await page.waitForTimeout(seconds*1000);}
 async function stock(expected){const s=await call(recording,`/api/stock?item_id=${item}`,undefined,200,'get');expect(s.stock.map(r=>Number(r.quantity)).sort((a,b)=>a-b)).toEqual(expected.slice().sort((a,b)=>a-b));await page.goto(`/dashboard/stock?item_id=${item}`);await expect(page.getByRole('heading',{name:'현재 재고',exact:true})).toBeVisible();}
 async function postUI(doc,label,retry=false){await page.goto('/dashboard/documents');await page.getByRole('button',{name:`전표 ${doc.id} 열기`,exact:true}).click();await caption(`${label} 전표 · 수량 ${label==='입고'?100:label==='출고'?30:20} 확인`);const keys=[];if(retry)await page.route(`**/api/documents/${doc.id}/post`,async route=>{keys.push(route.request().headers()['idempotency-key']);const response=await route.fetch();expect(response.status()).toBe(200);if(keys.length===1)await route.abort('connectionreset');else await route.fulfill({response});});await page.getByRole('button',{name:`${label} 확정`,exact:true}).click();await page.getByRole('button',{name:'확정 실행',exact:true}).click();if(retry){await expect(page.getByRole('button',{name:`${label} 확정 다시 시도`,exact:true})).toBeVisible();await caption('서버는 처리 완료 · 응답 유실을 재현합니다. 같은 요청 키로 다시 시도합니다.',8);await page.getByRole('button',{name:`${label} 확정 다시 시도`,exact:true}).click();await expect.poll(()=>keys.length).toBe(2);expect(keys[0]).toBe(keys[1]);result.checks.push('same-idempotency-key retry');}await expect(page.getByText(`${label} 확정됨`,{exact:true}).first()).toBeVisible();await expect(page.getByText('읽기 전용',{exact:true})).toBeVisible();await expect(page.getByLabel('수량 1',{exact:true})).toBeDisabled();await caption(`${label} 확정 완료 · 확정 전표는 읽기 전용`,7);}
 await page.goto('/dashboard');await expect(page.locator('main')).toBeVisible();await caption('16.2 현재 업무 화면 · A사 관리자 로그인 완료 (인증정보 비녹화)',10);
 await postUI(inbound,'입고');await stock([100]);await caption('입고 100 → 현재 재고 100',10);
 await postUI(outbound,'출고',true);await stock([70]);await caption('출고 30 · 응답 유실 후 재시도해도 재고는 70 (중복 차감 없음)',12);result.checks.push('inbound 100 outbound 30 retry leaves 70');
 await postUI(transfer,'이동');await stock([20,50]);await caption('20 이동 → 출발 50 / 도착 20 · 총재고 70 보존',12);
 const ledger=await call(recording,`/api/stock-ledger?item_id=${item}&page_size=100`,undefined,200,'get');expect(ledger.entries.map(r=>Number(r.quantity_delta)).sort((a,b)=>a-b)).toEqual([-30,-20,20,100]);expect(await call(recording,'/api/stock/reconcile',undefined,200,'get')).toEqual({consistent:true,mismatches:[]});result.checks.push('transfer 50/20; ledger +100,-30,-20,+20; reconciliation');const ledgerSection=page.locator('section').filter({has:page.getByRole('heading',{name:'재고 변동 이력',exact:true})});await expect(ledgerSection.locator('tbody tr')).toHaveCount(4);await expect(ledgerSection.getByRole('columnheader',{name:'작업자',exact:true})).toBeVisible();for(const delta of ['+100','-30','-20','+20'])await expect(ledgerSection.getByRole('cell',{name:delta,exact:true})).toBeVisible();for(const row of await ledgerSection.locator('tbody tr').all()){await expect(row.locator('td').last()).not.toHaveText('작업자 정보 없음');await expect(row.locator('td').last()).not.toHaveText('');}await ledgerSection.scrollIntoViewIfNeeded();await caption('원장 +100 / -30 / -20 / +20 · 작업자 표시 · 현재 재고와 원장 합계 일치',10);await page.screenshot({path:resolve(directory,'stock-ledger.png')});
 const b=await browser.newContext({baseURL:origin});try{await login(b,'admin.b@example.test');await recording.clearCookies();await recording.addCookies(await b.cookies());await page.goto(`/dashboard/stock?item_id=${item}`);expect((await call(recording,`/api/stock?item_id=${item}`,undefined,200,'get')).stock).toEqual([]);expect((await call(recording,`/api/stock-ledger?item_id=${item}`,undefined,200,'get')).entries).toEqual([]);await call(recording,`/api/documents/${outbound.id}`,undefined,404,'get');await caption('B사 관리자 로그인 · A사 품목 재고/원장 0건 · 전표 직접 접근 404',12);result.checks.push('tenant B stock/ledger empty and A document 404');await page.screenshot({path:resolve(directory,'tenant-b-isolation.png')});}finally{await b.close();}
 // Keep the exported walkthrough near three minutes; each wait stays below 60 seconds.
 const remaining=Math.max(0,180000-(Date.now()-started));for(let left=remaining;left>0;left-=30000)await caption('검증 완료 · 입고100 → 출고30 재시도 → 이동20 · 50/20 · 테넌트 격리',Math.min(left,30000)/1000);
 const video=page.video();await recording.close();recording=undefined;const webm=await video.path();execFileSync('ffmpeg',['-y','-i',webm,'-c:v','libx264','-crf','26','-preset','fast','-r','24','-pix_fmt','yuv420p','-movflags','+faststart',resolve(directory,'walkthrough.mp4')],{stdio:'ignore'});result.durationSeconds=Number(execFileSync('ffprobe',['-v','error','-show_entries','format=duration','-of','default=noprint_wrappers=1:nokey=1',resolve(directory,'walkthrough.mp4')],{encoding:'utf8'}).trim());result.video='walkthrough.mp4';result.completed=true;
} finally {
 if(recording)await recording.close();await auth.close();await browser.close();
 try {await pool.query('BEGIN');await pool.query("SELECT set_config('app.tenant_id',$1,true)",['00000000-0000-4000-8000-000000000001']);await pool.query("DELETE FROM idempotency_requests WHERE response->'document'->>'id'=ANY($1::text[])",[ids.documents]);for(const table of ['audit_logs','stock_ledger','inventory_document_lines'])await pool.query(`DELETE FROM ${table} WHERE document_id=ANY($1::uuid[])`,[ids.documents]);await pool.query('DELETE FROM stock_balances WHERE item_id=ANY($1::uuid[])',[ids.items]);await pool.query('DELETE FROM inventory_documents WHERE id=ANY($1::uuid[])',[ids.documents]);for(const table of ['locations','warehouses','items'])await pool.query(`DELETE FROM ${table} WHERE id=ANY($1::uuid[])`,[ids[table]]);await pool.query('COMMIT');result.cleaned=true;}catch(e){await pool.query('ROLLBACK');throw e;}finally{await pool.end();await writeFile(resolve(directory,'result.json'),JSON.stringify(result,null,2)+'\n');}
}
console.log(`Current UI walkthrough verified and synthetic fixtures cleaned: ${directory}`);
