/** Public synthetic workflow. Uses application APIs only; preserves immutable audit history. */
import { chromium, expect as baseExpect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const url = new URL(process.env.PUBLIC_DEPLOYMENT_URL ?? 'invalid:');
if (url.protocol !== 'https:' || url.username || url.password || ['localhost','127.0.0.1','::1'].includes(url.hostname)) throw Error('PUBLIC_DEPLOYMENT_URL must be public HTTPS without credentials.');
if (process.env.WMS_PUBLIC_WORKFLOW !== 'synthetic-only') throw Error('Set WMS_PUBLIC_WORKFLOW=synthetic-only to create and reverse dedicated test documents.');
const origin = url.origin;
const expect = baseExpect.configure({ timeout: 30000 });
const directory = resolve(process.env.PUBLIC_WORKFLOW_DIR ?? 'artifacts/public-workflow');
await mkdir(directory, { recursive: true, mode: 0o700 });
const passwords = {};
const privateText = process.env.DEMO_CREDENTIALS_FILE ? await readFile(process.env.DEMO_CREDENTIALS_FILE, 'utf8') : '';
for (const role of ['admin','worker','viewer']) {
  passwords[role] = process.env[`DEMO_${role.toUpperCase()}_PASSWORD`] ?? privateText.match(new RegExp(`\\(${role}\\)\\n이메일: [^\\n]+\\n비밀번호: ([^\\n]+)`))?.[1];
  if (!passwords[role]) throw Error(`Missing demo ${role} credential.`);
}
const proxy = process.env.NODE_USE_ENV_PROXY === '1' ? process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY : undefined;
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined, ...(proxy ? { proxy: { server: proxy } } : {}) });
const contexts = {};
const prefix = `PUBLIC-${new Date().toISOString().slice(0,10)}-${randomUUID().slice(0,8)}`;
const report = { origin, startedAt: new Date().toISOString(), synthetic: true, prefix, checks: [], documents: [], masters: [], completed: false, restored: false,
  limitations: ['Public second-tenant isolation requires a separate deployed tenant identity; not established by a missing UUID.', 'The public app does not expose a deployment commit SHA.'] };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
let item, warehouse, source, destination, delivery, page, baseline;
const documents = [];
function check(name) { report.checks.push(name); console.log(`Passed: ${name}`); }
async function api(context, path, { method='GET', data, status=200, headers={} }={}) {
  const response = await context.request.fetch(path, { method, data, headers: { Origin: origin, ...headers }, timeout: 30000 });
  if (response.status() !== status) throw Error(`${method} ${path}: expected ${status}, got ${response.status()}`);
  if (!uuid.test(response.headers()['x-request-id'] ?? '')) throw Error(`${method} ${path}: missing request UUID`);
  return response.json();
}
async function detail(doc) { return (await api(contexts.admin, `/api/documents/${doc.id}`)).document; }
async function navigate(page, path) {
  for(let attempt=0;attempt<3;attempt++) {
    try { await page.goto(path); return; }
    catch(error) { if(attempt===2||!/net::ERR_(NETWORK_CHANGED|CONNECTION_RESET)/.test(error.message))throw error; }
  }
}
async function master(kind, label, extra={}) {
  const row = (await api(contexts.admin, `/api/${kind}`, { method:'POST', status:201, data:{code:`${prefix}-${label}`,name:`공개 검증 ${label}`, ...extra} }))[{items:'item',warehouses:'warehouse',locations:'location'}[kind]];
  report.masters.push({kind,id:row.id}); return row;
}
async function stock(expected) {
  const rows = (await api(contexts.admin, `/api/stock?item_id=${item.id}&page_size=100`)).stock;
  const quantities = [source,destination].map(location => rows.filter(row=>row.location_id===location.id).reduce((sum,row)=>sum+Number(row.quantity),0));
  expect(quantities).toEqual(expected);
  expect(await api(contexts.admin,'/api/stock/reconcile')).toEqual({consistent:true,mismatches:[]});
  return rows;
}
async function createUI(kind, quantity) {
  await navigate(page,'/dashboard/documents');
  await page.getByRole('button',{name:'새 전표',exact:true}).click();
  await page.getByRole('combobox',{name:'전표 유형',exact:true}).selectOption(kind);
  await page.getByRole('combobox',{name:'창고',exact:true}).selectOption(warehouse.id);
  if (kind !== 'INBOUND') await page.getByRole('combobox',{name:'출발 보관위치',exact:true}).selectOption(source.id);
  if (kind !== 'OUTBOUND') await page.getByRole('combobox',{name:'도착 보관위치',exact:true}).selectOption(kind==='INBOUND'?source.id:destination.id);
  await page.getByLabel('품목 1 검색',{exact:true}).fill(item.code);
  await page.getByRole('combobox',{name:'품목 1 검색 결과',exact:true}).selectOption(item.id);
  await page.getByLabel('수량 1',{exact:true}).fill(String(quantity));
  await page.getByRole('textbox',{name:'메모',exact:true}).fill(`${prefix} 합성 공개 배포 검증`);
  if (kind==='OUTBOUND') {
    await page.getByLabel('거래처·배송지 검색',{exact:true}).fill(prefix);
    await page.getByRole('button',{name:new RegExp(`${prefix} ·`)}).click();
  }
  const responsePromise=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/documents'&&r.request().method()==='POST');
  await page.getByRole('button',{name:'전표 저장',exact:true}).click();
  const response=await responsePromise;
  if(response.status()!==201)throw Error(`UI create ${kind}: HTTP ${response.status()}`);
  const doc=(await response.json()).document;
  documents.push(doc); report.documents.push({id:doc.id,number:doc.document_number,kind});
  expect(doc.document_number).toMatch(/^[A-Z]+-\d+/);
  check(`${kind} created and saved through public UI with document number`);
  return doc;
}
async function postUI(doc, label, retry=false) {
  const keys=[];
  const path=`**/api/documents/${doc.id}/post`;
  if(retry)await page.route(path,async route=>{
    keys.push(route.request().headers()['idempotency-key']);
    const response=await route.fetch();
    expect(response.status()).toBe(200);
    if(keys.length===1)await route.abort('connectionreset');else await route.fulfill({response});
  });
  await page.getByRole('button',{name:`${label} 확정`,exact:true}).click();
  if(doc.kind==='OUTBOUND')await expect(page.getByRole('dialog')).toContainText(prefix);
  await page.getByRole('button',{name:'확정 실행',exact:true}).click();
  if(retry){
    await page.getByRole('button',{name:`${label} 확정 다시 시도`,exact:true}).click();
    await expect.poll(()=>keys.length).toBe(2);expect(keys[0]).toBeTruthy();expect(keys[1]).toBe(keys[0]);
  }
  await expect(page.getByText(`${label} 확정됨`,{exact:true}).first()).toBeVisible();
  await expect(page.getByText('읽기 전용',{exact:true})).toBeVisible();
  await expect(page.getByLabel('수량 1',{exact:true})).toBeDisabled();
  if(retry)await page.unroute(path);
  check(`${doc.kind} posted through public UI${retry?' with committed-response loss and same-key retry':''}`);
}
try {
  for(const role of ['admin','worker','viewer']) {
    const context=await browser.newContext({baseURL:origin,viewport:{width:1440,height:1000}});
    context.setDefaultTimeout(30000); contexts[role]=context;
    if(role==='admin') {
      page=await context.newPage();
      // Login has no screenshots, tracing, video, storage-state export or request logging.
      try {
        await navigate(page,'/login');
        await page.getByLabel('이메일',{exact:true}).fill(`${role}@wms-demo.example.test`);
        await page.getByLabel('비밀번호',{exact:true}).fill(passwords[role]);
        await page.getByRole('button',{name:'로그인',exact:true}).click();
        await page.waitForURL('**/dashboard');
      } catch { throw Error('Public admin login UI failed.'); }
      check('admin login through public browser UI with TLS verification');
    } else {
      const response=await context.request.post('/api/auth/sign-in/email',{headers:{Origin:origin},data:{email:`${role}@wms-demo.example.test`,password:passwords[role]}});
      if(!response.ok())throw Error(`${role} login HTTP ${response.status()}`);
    }
    const identity=await api(context,'/api/me');
    expect(identity.role).toBe(role);expect(identity.tenant.id).toBe('70000000-0000-4000-8000-000000000001');
  }
  baseline=(await api(contexts.admin,'/api/stock?page_size=100')).stock;
  expect(await api(contexts.admin,'/api/stock/reconcile')).toEqual({consistent:true,mismatches:[]});
  item=await master('items','품목');warehouse=await master('warehouses','창고');
  source=await master('locations','입고위치',{warehouse_id:warehouse.id});destination=await master('locations','이동위치',{warehouse_id:warehouse.id});
  delivery=(await api(contexts.admin,'/api/delivery-destinations',{method:'POST',status:201,data:{recipient_name:prefix,name:'합성 검증 배송지',postal_code:'04524',address_line1:'서울 합성 검증 주소 100',address_line2:'실배송 금지'}})).destination;
  report.deliveryDestinationId=delivery.id;
  check('dedicated synthetic masters and address-book entry created');
  const inbound=await createUI('INBOUND',100);await postUI(inbound,'입고');await stock([100,0]);check('inbound stock 100/0');
  page=await contexts.worker.newPage();
  const outbound=await createUI('OUTBOUND',30);await postUI(outbound,'출고',true);await stock([70,0]);check('worker outbound retry leaves stock 70/0 without duplicate deduction');
  const transfer=await createUI('TRANSFER',20);await postUI(transfer,'이동');await stock([50,20]);check('transfer stock 50/20 preserves total 70');
  const ledger=(await api(contexts.admin,`/api/stock-ledger?item_id=${item.id}&page_size=100`)).entries;
  expect(ledger.map(row=>Number(row.quantity_delta)).sort((a,b)=>a-b)).toEqual([-30,-20,20,100]);
  expect(ledger.every(row=>typeof row.actor_name==='string'&&row.actor_name.length>0)).toBe(true);
  await navigate(page,`/dashboard/stock?item_id=${item.id}`);
  await expect(page.getByText('현재 재고와 변동 이력의 수량이 일치합니다.',{exact:true})).toBeVisible();
  const ledgerSection=page.locator('section').filter({has:page.getByRole('heading',{name:'재고 변동 이력',exact:true})});
  await expect(ledgerSection.locator('tbody tr')).toHaveCount(4);
  await page.screenshot({path:resolve(directory,'stock-ledger.png'),fullPage:true});
  report.ledgerDeltas=ledger.map(row=>Number(row.quantity_delta));check('four ledger entries, actor names and public stock UI reconciliation');
  for(const role of ['viewer','worker']) {
    await api(contexts[role],`/api/documents/${outbound.id}/reverse`,{method:'POST',status:403,data:{version:2},headers:{'Idempotency-Key':randomUUID()}});
    await api(contexts[role],'/api/items',{method:'POST',status:403,data:{}});
    await api(contexts[role],'/api/audit-logs',{status:403});
  }
  await api(contexts.viewer,'/api/documents',{method:'POST',status:403,data:{}});
  await api(contexts.viewer,`/api/documents/${inbound.id}/post`,{method:'POST',status:403,data:{version:1},headers:{'Idempotency-Key':randomUUID()}});
  const history=await api(contexts.viewer,`/api/documents/${outbound.id}?view=history`);
  expect(history.document.recipient_name).toBe(prefix);expect(history.document.delivery_address).toContain('실배송 금지');
  const viewerPage=await contexts.viewer.newPage();await navigate(viewerPage,'/dashboard/history');
  await viewerPage.getByRole('button',{name:`전표 ${outbound.id} 열기`,exact:true}).click();
  await expect(viewerPage.getByText('읽기 전용',{exact:true})).toBeVisible();
  await expect(viewerPage.getByRole('button',{name:'전표 저장',exact:true})).toHaveCount(0);
  await viewerPage.screenshot({path:resolve(directory,'viewer-history.png'),fullPage:true});
  check('viewer history UI and delivery snapshot; worker/viewer mutation restrictions');
  report.completed=true;
} catch(error) {
  report.error=error.message;console.error(`Public workflow failed: ${error.message}`);process.exitCode=1;
} finally {
  try {
    // Recover persisted state even when a browser response was lost. Reverse only this run's documents.
    for(const doc of [...documents].reverse()) {
      const current=await detail(doc);
      if(current.status==='DRAFT')await api(contexts.admin,`/api/documents/${doc.id}/cancel`,{method:'POST',data:{version:current.version}});
      else if(current.status==='POSTED'){
        const reversed=await api(contexts.admin,`/api/documents/${doc.id}/reverse`,{method:'POST',data:{version:current.version},headers:{'Idempotency-Key':randomUUID()}});
        report.documents.find(row=>row.id===doc.id).reversalId=reversed.reversal.id;
      }
    }
    if(item&&source&&destination){await stock([0,0]);check('synthetic stock restored to zero by linked reversal documents');}
    if(delivery)await api(contexts.admin,`/api/delivery-destinations/${delivery.id}`,{method:'PATCH',data:{active:false}});
    for(const row of [...report.masters].reverse())await api(contexts.admin,`/api/${row.kind}/${row.id}`,{method:'PATCH',data:{active:false}});
    if(baseline){
      const after=(await api(contexts.admin,'/api/stock?page_size=100')).stock.filter(row=>row.item_id!==item?.id);
      const fingerprint=rows=>rows.map(row=>`${row.item_id}:${row.location_id}:${row.quantity}`).sort();
      expect(fingerprint(after)).toEqual(fingerprint(baseline));check('pre-existing stock unchanged');
    }
    report.restored=true;
  } catch(error) {report.restorationError=error.message;console.error(`Restoration failed: ${error.message}`);process.exitCode=1;}
  report.finishedAt=new Date().toISOString();
  await writeFile(resolve(directory,'result.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
  for(const context of Object.values(contexts))await context.close();await browser.close();
}
console.log(`Public workflow evidence: ${directory}/result.json`);
