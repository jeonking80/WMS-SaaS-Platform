import {randomUUID} from 'node:crypto';
import {expect,test} from '@playwright/test';
import {emptyState} from '../../src/server/v2/workflow/types';

// Browser contract fixture; the real PostgreSQL >50-original/tenant/correction test is v2-workflow.test.ts.
test('legacy correction picker searches and selects an original beyond the first fifty candidates',async({page})=>{
 const password=process.env.DEMO_PASSWORD;if(!password)throw Error('DEMO_PASSWORD required');
 for(let attempt=0;attempt<3;attempt++){const response=await page.request.post('/api/auth/sign-in/email',{headers:{origin:'http://127.0.0.1:3100'},data:{email:'admin.a@example.test',password}});if(response.status()!==429){expect(response.status()).toBe(200);break;}if(attempt===2)throw Error('Authentication rate limit persisted');await new Promise(resolve=>setTimeout(resolve,Math.min(10,Math.max(1,Number(response.headers()['retry-after']??10)))*1000+250));}
 const me=await(await page.request.get('/api/me')).json(),warehouse=randomUUID(),item=randomUUID(),location=randomUUID();
 const sources=Array.from({length:55},(_,index)=>({id:randomUUID(),kind:'legacy',document_no:String(55-index),document_number:'WMS-'+String(55-index).padStart(6,'0'),document_kind:'INBOUND',created_at:'2026-01-01T00:00:00Z'}));
 const oldest=sources.at(-1)!,inspected:string[]=[],queries:URLSearchParams[]=[];
 await page.route('**/api/v2/**',async route=>{
  const url=new URL(route.request().url());let result:unknown;
  if(url.pathname==='/api/v2/identity/context')result={tenant:{...me.tenant,isTest:true},environment:'test',role:'admin',warehouses:[{id:warehouse,code:'PAGING',name:'Paging contract fixture',active:true}],assignees:[],automationAccounts:[]};
  else if(url.pathname==='/api/v2/workflow/ledger')result={rows:[],cursor:null,has_more:false,boundary:0};
  else if(url.pathname==='/api/v2/workflow/correction-source'){
   const original=url.searchParams.get('original_id');
   if(original){inspected.push(original);result={source:{id:original,kind:'legacy'},lines:[{item_id:item,location_id:location,bucket:'S',quantity:-1}],blocked_reason:null};}
   else{queries.push(new URLSearchParams(url.search));const q=url.searchParams.get('q')??'',filtered=sources.filter(row=>row.document_number.includes(q)),offset=url.searchParams.has('cursor')?50:0;result={sources:filtered.slice(offset,offset+50),has_more:filtered.length>offset+50,next_cursor:filtered.length>offset+50?'older-legacy-page':null};}
  }else if(url.pathname==='/api/v2/workflow')result={snapshot:{...emptyState(),reconciliation:{ok:true}}};
  else if(url.pathname.startsWith('/api/v2/masters/'))result={rows:url.pathname.endsWith('/items')?[{id:item,code:'PAGING-ITEM',name:'Paging item',active:true}]:url.pathname.endsWith('/locations')?[{id:location,code:'PAGING-STORAGE',name:'Paging storage',kind:'STORAGE',active:true}]:[],has_more:false,next_cursor:null};
  else return route.fallback();
  await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(result)});
 });
 await page.goto('/dashboard/v2');await page.getByRole('tab',{name:'재고·실사·승인',exact:true}).click();await page.getByRole('button',{name:'원장·정정',exact:true}).click();
 const picker=page.getByLabel('정정 원본 실적',{exact:true});await expect(picker).toBeEnabled();await expect(picker.locator('option')).toHaveCount(51);expect(await picker.locator(`option[value="${oldest.id}"]`).count()).toBe(0);
 await page.getByRole('button',{name:'이전 기존 전표 50개 더 불러오기'}).click();await expect(picker.locator('option')).toHaveCount(56);await picker.selectOption(oldest.id);await expect.poll(()=>inspected.at(-1)).toBe(oldest.id);
 await page.getByLabel('기존 전표번호·품목·메모 검색',{exact:true}).fill(oldest.document_number);await expect(picker.locator('option')).toHaveCount(2);await expect(picker).toHaveValue('');await picker.selectOption(oldest.id);await expect(picker).toHaveValue(oldest.id);
 await page.getByLabel('원본 실적 품목 좁히기',{exact:true}).selectOption(item);await expect.poll(()=>queries.at(-1)?.get('item_id')).toBe(item);expect(queries.some(query=>query.has('cursor'))).toBe(true);expect(queries.some(query=>query.get('q')===oldest.document_number)).toBe(true);
});
