import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
const headers={origin:'http://127.0.0.1:3100'};
// Runs without ANTHROPIC_API_KEY, so the quick question exercises the direct-tool fallback.
test('운영 관제는 실제 원장의 오늘 처리량·품절 예측·납기 위험·배치도를 보여주고 AI 키 없이도 빠른 질문에 답한다',async({page})=>{
 test.setTimeout(120_000);page.setDefaultTimeout(30_000);
 const password=process.env.DEMO_PASSWORD;if(!password)throw new Error('DEMO_PASSWORD is required');
 for(let attempt=0;attempt<4;attempt++){const response=await page.request.post(`${headers.origin}/api/auth/sign-in/email`,{headers,data:{email:'admin.a@example.test',password}});if(response.status()!==429||attempt===3){expect(response.status()).toBe(200);break;}await page.waitForTimeout(Number(response.headers()['retry-after']||10)*1000);}
 const code=`CT-${randomUUID().slice(0,8)}`.toUpperCase();
 const created=await page.request.post('/api/warehouses',{headers,data:{code,name:`${code} 관제창고`}});expect(created.status()).toBe(201);const warehouse=(await created.json()).warehouse.id;
 async function master(kind:string,data:unknown){const response=await page.request.post(`/api/v2/masters/${kind}?warehouse_id=${warehouse}`,{headers,data});expect(response.status(),await response.text()).toBe(201);return (await response.json()).row.id as string;}
 const item=await master('items',{code:`${code}-SKU`,name:`${code} 테이프`});
 const receiving=await master('locations',{code:`${code}-RCV`,name:'수령',kind:'RECEIVING'}),storage=await master('locations',{code:`${code}-STO`,name:'보관',kind:'STORAGE'}),staging=await master('locations',{code:`${code}-STG`,name:'포장 대기',kind:'STAGING'});
 const partner=await master('partners',{code:`${code}-P`,name:`${code} 거래처`,supplier:true,customer:true});
 const destination=await master('destinations',{name:`${code} 배송지`,recipient_name:'수령인',address_line1:'부산광역시 강서구 신항로 1',partner_id:partner});
 async function run(command:string,payload:Record<string,unknown>){const physical=['receipt.receive','receipt.inspect','receipt.putaway','order.pick','package.create'].includes(command);const body=physical?{...payload,manual_entry_reason:'관제 시험 실물 대조',lines:(payload.lines as Record<string,unknown>[]).map(line=>({...line,input_mode:'search'}))}:payload;const response=await page.request.post('/api/v2/workflow',{headers,data:{warehouse_id:warehouse,request_id:randomUUID(),command,payload:body}});expect(response.status(),await response.text()).toBe(200);return await response.json() as {result:{id:string};snapshot:{receipts:{lines:{id:string}[];lots:{id:string}[]}[];orders:{id:string;reservations:{id:string}[];picks:{id:string;active:number}[]}[]}};}
 const receipt=await run('receipt.create',{supplier_id:partner,expected_at:new Date().toISOString(),lines:[{item_id:item,quantity:10}]});
 let state=(await run('receipt.receive',{receipt_id:receipt.result.id,receiving_id:randomUUID(),lines:[{line_id:receipt.snapshot.receipts[0].lines[0].id,quantity:10,location_id:receiving}]})).snapshot;const lot=state.receipts[0].lots[0].id;
 await run('receipt.inspect',{receipt_id:receipt.result.id,lines:[{lot_id:lot,quantity:10,outcome:'normal'}]});await run('receipt.putaway',{receipt_id:receipt.result.id,lines:[{lot_id:lot,quantity:10,location_id:storage}]});
 const shipped=await run('order.create',{external_id:`${code}-SHIP`,delivery:{partner_id:partner,delivery_destination_id:destination},due_at:new Date(Date.now()+86_400_000).toISOString(),lines:[{item_id:item,quantity:8}]});
 state=(await run('order.reserve',{order_id:shipped.result.id,partial:false})).snapshot;
 state=(await run('order.pick',{order_id:shipped.result.id,lines:[{reservation_id:state.orders[0].reservations[0].id,quantity:8,location_id:staging}]})).snapshot;
 const pack=await run('package.create',{order_id:shipped.result.id,lines:[{pick_id:state.orders[0].picks[0].id,quantity:8}]});
 await run('shipment.create',{package_ids:[pack.result.id],carrier:'관제 시험 운송',handover_by:'현장 담당자'});
 await run('order.create',{external_id:`${code}-LATE`,delivery:{partner_id:partner,delivery_destination_id:destination},due_at:new Date(Date.now()-3_600_000).toISOString(),lines:[{item_id:item,quantity:5}]});

 const insights=await(await page.request.get(`/api/v2/insights?warehouse_id=${warehouse}`)).json();
 expect(insights.daily_outbound).toEqual([expect.objectContaining({item_id:item,quantity:8})]);
 expect(insights.hourly.reduce((sum:number,row:{flow:string;quantity:number})=>sum+(row.flow==='ship'?row.quantity:0),0)).toBe(8);
 expect(insights.actors[0]).toMatchObject({actor_name:expect.any(String)});

 await page.goto(`/dashboard/v2?warehouse_id=${warehouse}&tab=control`);
 await expect(page.getByRole('tab',{name:'운영 관제',exact:true})).toHaveAttribute('aria-selected','true');
 await expect(page.getByRole('heading',{name:'운영 관제',exact:true})).toBeVisible();
 await expect(page.getByRole('button',{name:/^납기 초과\s*1/})).toHaveAttribute('data-hot','true');
 await expect(page.locator('.v2-alerts')).toContainText(`${code}-LATE 납기 1시간 초과`);
 await expect(page.locator('.v2-alerts')).toContainText(`${code}-SKU · ${code} 테이프 약`);
 await expect(page.getByRole('img',{name:'출하 시간대별 수량, 합계 8 EA'})).toBeVisible();
 const forecast=page.locator('section').filter({has:page.getByRole('heading',{name:'품절 예측',exact:true})});
 await expect(forecast.getByRole('row').filter({hasText:`${code}-SKU`})).toContainText('2 EA');
 await expect(page.locator('.v2-cell').filter({hasText:`${code}-STO`})).toHaveAttribute('data-state','stocked');
 await page.getByRole('button',{name:'곧 품절될 품목은?',exact:true}).click();
 await expect(page.locator('.v2-turn[data-role=assistant]').last()).toContainText(`${code}-SKU · ${code} 테이프: 가용 2 EA`);
 await expect(page.getByLabel('도우미에게 질문',{exact:true})).toBeDisabled();
 await page.locator('.v2-alerts li').filter({hasText:`${code}-LATE`}).getByRole('button',{name:'열기',exact:true}).click();
 await expect(page.getByRole('heading',{name:`${code}-LATE`,exact:true})).toBeVisible();
 await page.setViewportSize({width:390,height:844});await page.getByRole('tab',{name:'운영 관제',exact:true}).click();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
});
