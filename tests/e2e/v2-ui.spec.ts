import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { expect, test, type Page, type APIRequestContext } from '@playwright/test';
import type { WorkflowState } from '../../src/server/v2/workflow/types';
const headers={origin:'http://127.0.0.1:3100'};
async function signIn(request:APIRequestContext,email:string,password:string){
 for(let attempt=0;attempt<4;attempt++){
  const response=await request.post(`${headers.origin}/api/auth/sign-in/email`,{headers,data:{email,password}});
  if(response.status()!==429||attempt===3){expect(response.status(),await response.text()).toBe(200);return;}
  const retryAfter=response.headers()['retry-after'];
  const seconds=Number(retryAfter);
  const delay=retryAfter&&Number.isFinite(seconds)?seconds*1000:retryAfter?Date.parse(retryAfter)-Date.now():10_000;
  await new Promise(resolve=>setTimeout(resolve,Math.max(1000,Number.isFinite(delay)?delay:10_000)));
 }
}

async function scan(page:Page,caption:string,values:string[]){const input=page.getByRole('textbox',{name:caption,exact:true});for(const value of values){await input.fill(value);await input.press('Enter');}}
test('현장 화면에서 재검색 없이 박스 스캔 수령·검수·적치와 예약·피킹·포장·출하를 계속한다',async({page})=>{
 test.setTimeout(180_000);
 page.setDefaultTimeout(30_000);
 const password=process.env.DEMO_PASSWORD;if(!password)throw new Error('DEMO_PASSWORD is required');
 await signIn(page.request,'admin.a@example.test',password);
 let lastCommand:unknown;page.on('request',request=>{if(request.method()==='POST'&&new URL(request.url()).pathname==='/api/v2/workflow')lastCommand=request.postDataJSON();});
 const code=`UI-${randomUUID().slice(0,8)}`.toUpperCase();
 const warehouseName=`${code} 현장창고`;
 const warehouseResponse=await page.request.post('/api/warehouses',{headers,data:{code,name:warehouseName}});expect(warehouseResponse.status()).toBe(201);const warehouse=(await warehouseResponse.json()).warehouse.id;
 async function master(kind:string,data:unknown){const response=await page.request.post(`/api/v2/masters/${kind}?warehouse_id=${warehouse}`,{headers,data});expect(response.status(),await response.text()).toBe(201);return (await response.json()).row.id as string;}
 const item=await master('items',{code:`${code}-SKU`,name:`${code} 품목`});
 const receiving=await master('locations',{code:`${code}-RCV`,name:'수령 대기',kind:'RECEIVING'});
 const storage=await master('locations',{code:`${code}-STO`,name:'보관 위치',kind:'STORAGE'});
 const staging=await master('locations',{code:`${code}-STG`,name:'포장 대기',kind:'STAGING'});
 const supplier=await master('partners',{code:`${code}-SUP`,name:'테스트 공급처',supplier:true,customer:false});
 const customer=await master('partners',{code:`${code}-CUS`,name:'테스트 납품처',supplier:false,customer:true});
 const destination=await master('destinations',{name:`${code} 테스트 배송지`,recipient_name:`${code} 담당자`,address_line1:'서울특별시 종로구 세종대로 1',partner_id:customer});
 const changedAddress='서울특별시 강남구 테헤란로 999',changedRecipient=`${code} 변경 수령인`;
 const changedDestination=await master('destinations',{name:`${code} 변경 배송지`,recipient_name:changedRecipient,address_line1:changedAddress,partner_id:customer});
 const box=`${code}-BOX12`,rcv=`${code}-L-RCV`,sto=`${code}-L-STO`,stg=`${code}-L-STG`;
 for(const [barcode,location_id]of[[rcv,receiving],[sto,storage],[stg,staging]])await master('barcodes',{barcode,location_id});
 await master('barcodes',{barcode:box,item_id:item,unit:'BOX',quantity:12});
 await page.goto('/dashboard/v2');await page.getByLabel('현재 창고',{exact:true}).selectOption(warehouse);
 await page.getByRole('tab',{name:'입고',exact:true}).click();await page.getByRole('button',{name:'신규 등록',exact:true}).click();
 await page.getByLabel('외부 업무번호',{exact:true}).fill(`${code}-IN`);await page.getByLabel('입고 예정일',{exact:true}).fill('2026-10-21T10:00');
 await page.getByLabel('공급처',{exact:true}).selectOption(supplier);await page.getByLabel('품목 1',{exact:true}).selectOption(item);await page.getByLabel('품목 1 예정 수량 (EA)',{exact:true}).fill('24');
 await page.getByRole('button',{name:'등록 · 재고 변동 없음',exact:true}).click();
 await expect(page.getByRole('heading',{name:`${code}-IN`,exact:true})).toBeVisible();
 await scan(page,'도착 위치 → 품목 바코드 스캔',[rcv,box,box]);
 await page.getByRole('checkbox',{name:/선택한 1명세 · 24 EA와 실물/}).check();await page.getByRole('button',{name:'실물 수령 확정',exact:true}).click();
 await expect(page.getByRole('heading',{name:'검수 판정',exact:true})).toBeVisible();await expect(page.getByRole('heading',{name:`${code}-IN`,exact:true})).toBeVisible();
 await scan(page,'현재 위치 → 품목 바코드 스캔',[rcv,box,box]);await page.getByRole('checkbox',{name:/선택한 1명세 · 24 EA와 실물/}).check();await page.getByRole('button',{name:'검수 판정 확정',exact:true}).click();
 await expect(page.getByRole('heading',{name:'정상분 적치',exact:true})).toBeVisible();await scan(page,'도착 위치 → 품목 바코드 스캔',[sto,box,box]);await page.getByRole('checkbox',{name:/선택한 1명세 · 24 EA와 실물/}).check();await page.getByRole('button',{name:'정상분 적치 확정',exact:true}).click();
 await expect(page.getByRole('status').filter({hasText:'선택한 수량이 확정되었습니다'})).toBeVisible();
 await page.getByRole('tab',{name:'출고',exact:true}).click();await page.getByRole('button',{name:'신규 등록',exact:true}).click();await page.getByLabel('외부 업무번호',{exact:true}).fill(`${code}-OUT`);await page.getByLabel('납기',{exact:true}).fill('2026-10-22T10:00');await page.getByLabel('납품처',{exact:true}).selectOption(customer);await page.getByLabel('배송지 주소록',{exact:true}).selectOption(destination);await page.getByLabel('품목 1',{exact:true}).selectOption(item);await page.getByLabel('품목 1 예정 수량 (EA)',{exact:true}).fill('24');await page.getByRole('button',{name:'등록 · 재고 변동 없음',exact:true}).click();
 await expect(page.getByRole('heading',{name:`${code}-OUT`,exact:true})).toBeVisible();await page.getByRole('button',{name:'잔량 전체 예약',exact:true}).click();await expect(page.getByRole('heading',{name:'피킹',exact:true})).toBeVisible();
 await scan(page,'출발 위치 → 도착 위치 → 품목 바코드 스캔',[sto,stg,box,box]);await page.getByRole('checkbox',{name:/선택한 1명세 · 24 EA와 실물/}).check();await page.getByRole('button',{name:'피킹 확정',exact:true}).click();
 await expect(page.getByRole('heading',{name:'포장 검수·완료',exact:true})).toBeVisible();await expect(page.getByRole('heading',{name:`${code}-OUT`,exact:true})).toBeVisible();await scan(page,'현재 위치 → 품목 바코드 스캔',[stg,box,box]);await page.getByLabel('포장 무게 (g, 선택)',{exact:true}).fill('875');await page.getByRole('checkbox',{name:/선택한 1명세 · 24 EA와 실물/}).check();await page.getByRole('button',{name:'포장 검수·완료 확정',exact:true}).click();
 await expect(page.getByRole('heading',{name:'완료 포장 전체 인계',exact:true})).toBeVisible();
 await test.step('포장 후 주문 주소를 바꿔도 저장된 배송지와 고유번호를 재출력하고 재고를 보존한다',async()=>{
  await page.getByText('예정 수량·주문 배송지 수정',{exact:true}).click();
  await page.getByLabel('변경할 배송지',{exact:true}).selectOption(changedDestination);
  await page.getByLabel('수정 사유',{exact:true}).fill('완료 포장 배송지 스냅샷과 변경 주문의 분리 확인');
  await page.getByRole('button',{name:'현재 버전 확인·변경 저장',exact:true}).click();
  await expect(page.getByRole('button',{name:'현재 버전 확인·변경 저장',exact:true})).toBeHidden();
  const readPrintState=async()=>{const response=await page.request.get(`/api/v2/workflow?warehouse_id=${warehouse}`);expect(response.status()).toBe(200);return (await response.json()).snapshot as WorkflowState;};
  const company=await page.locator('.v2-context strong').innerText();
  const beforePrint=await readPrintState(),savedPack=beforePrint.packages.find(row=>row.status==='complete')!,savedOrder=beforePrint.orders.find(row=>row.id===savedPack.order_id)!;
  expect(savedOrder.delivery).toMatchObject({id:changedDestination,address_line1:changedAddress});
  expect(savedPack.delivery).toMatchObject({id:destination,address_line1:'서울특별시 종로구 세종대로 1'});
  for(let copy=0;copy<2;copy++){
   const from=await page.evaluate(()=>Date.now()),popupReady=page.waitForEvent('popup');
   await page.getByRole('button',{name:'명세 인쇄',exact:true}).click();const popup=await popupReady;
   try{
    await expect(popup.getByRole('heading',{name:'내부 포장명세',exact:true})).toBeVisible();
    for(const id of [savedPack.id,savedPack.order_id,`${code}-OUT`,destination,customer])await expect(popup.getByRole('cell',{name:id,exact:true})).toHaveCount(1);
    await expect(popup.locator('small')).toContainText(company);await expect(popup.locator('small')).toContainText(`창고 ${warehouseName} (${code})`);await expect(popup.locator('small')).toContainText(`창고 ID ${warehouse}`);
    await expect(popup.locator('small')).toContainText(`상태 버전 ${beforePrint.version}`);
    await expect(popup.getByRole('cell',{name:`${code} 담당자`,exact:true})).toBeVisible();await expect(popup.getByRole('cell',{name:'서울특별시 종로구 세종대로 1',exact:true})).toBeVisible();
    await expect(popup.locator('body')).not.toContainText(changedAddress);await expect(popup.locator('body')).not.toContainText(changedRecipient);await expect(popup.locator('body')).not.toContainText(changedDestination);
    const created=await page.evaluate(at=>new Date(at).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'}),savedPack.created_at);
    const creationRow=popup.getByRole('row').filter({has:popup.getByRole('cell',{name:'포장 생성 시각',exact:true})});await expect(creationRow.getByRole('cell').nth(1)).toHaveText(created);
    const printed=(await popup.locator('small').innerText()).split('출력 시각 ')[1]?.split(' (Asia/Seoul)')[0],to=await page.evaluate(()=>Date.now());
    const possibleTimes=await page.evaluate(({from,to})=>Array.from({length:Math.ceil((to-from)/1000)+1},(_,second)=>new Date(from+second*1000).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'})),{from,to});expect(possibleTimes).toContain(printed);
    const line=popup.getByRole('row').filter({has:popup.getByRole('cell',{name:savedPack.lines[0].pick_id,exact:true})});await expect(line.getByRole('cell').nth(1)).toHaveText('24');
    await expect(popup.getByRole('cell',{name:'875 g',exact:true})).toBeVisible();
   }finally{await popup.close();}
  }
  const afterPrint=await readPrintState();expect(afterPrint.version).toBe(beforePrint.version);expect(afterPrint.stock).toEqual(beforePrint.stock);expect(afterPrint.ledger_count).toBe(beforePrint.ledger_count);expect(afterPrint.orders).toEqual(beforePrint.orders);expect(afterPrint.packages).toEqual(beforePrint.packages);
 });
 await page.getByRole('checkbox',{name:/포장 1 · 1명세 · 24 EA/}).check();await page.getByLabel('운송사 · 운송수단',{exact:true}).fill('시험 운송차량');await page.getByLabel('실제 인계자 이름',{exact:true}).fill('현장 담당자');await page.getByRole('checkbox',{name:'선택한 포장 전체를 실제 인계했습니다.',exact:true}).check();await page.getByRole('button',{name:'인계·출하 확정',exact:true}).click();
 await expect(page.getByRole('status').filter({hasText:'선택한 수량이 확정되었습니다'})).toBeVisible();const snapshot=(await(await page.request.get(`/api/v2/workflow?warehouse_id=${warehouse}`)).json()).snapshot;
 expect(snapshot.shipments).toHaveLength(1);expect(snapshot.shipments[0].lines[0].quantity).toBe(24);expect(snapshot.stock.reduce((sum:number,row:{H:number})=>sum+row.H,0)).toBe(0);expect(snapshot.orders[0].lines[0].shipped).toBe(24);
 await expect(page.getByText('무게 875 g',{exact:false}).first()).toBeVisible();expect(snapshot.packages[0].weight_grams).toBe(875);
 await page.getByRole('combobox',{name:'출하 1 배송 상태',exact:true}).selectOption('delivered');await page.getByRole('button',{name:'배송 사건 기록',exact:true}).click();await expect(page.getByRole('heading',{name:'출하 1 · 배송 완료',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'배송 사건 기록',exact:true})).toHaveCount(0);
 await page.getByRole('button',{name:'배송 상태 정정',exact:true}).click();await page.getByRole('combobox',{name:'출하 1 정정할 배송 상태',exact:true}).selectOption('lost');await page.getByLabel('출하 1 배송 정정 사유',{exact:true}).fill('운송사 최종 분실 통보에 따른 기록 오류 정정');await expect(page.getByRole('button',{name:'배송 상태 정정 확정',exact:true})).toBeDisabled();await page.getByRole('checkbox',{name:'현재 상태와 실제 배송 상태, 정정 사유를 확인했습니다.',exact:true}).check();await page.getByRole('button',{name:'배송 상태 정정 확정',exact:true}).click();await expect(page.getByRole('heading',{name:'출하 1 · 분실',exact:true})).toBeVisible();
 await page.getByText('배송 사건·정정 이력 (2건)',{exact:true}).click();await expect(page.getByRole('cell',{name:'명시적 정정',exact:true})).toBeVisible();await expect(page.getByRole('cell').filter({hasText:'운송사 최종 분실 통보에 따른 기록 오류 정정'})).toBeVisible();const corrected=(await(await page.request.get(`/api/v2/workflow?warehouse_id=${warehouse}`)).json()).snapshot;
 expect(corrected.shipments[0]).toMatchObject({status:'lost',revision:2});expect(corrected.shipments[0].events[1]).toMatchObject({correction:true,previous_status:'delivered',previous_revision:1,revision:2});expect(corrected.stock).toEqual(snapshot.stock);expect(corrected.orders[0].lines[0].shipped).toBe(24);expect(corrected.ledger_count).toBe(snapshot.ledger_count);

 await page.getByLabel('업무 검색',{exact:true}).fill(`${code}-OUT`);const orderDownload=page.waitForEvent('download');await page.getByRole('button',{name:'현재 검색 목록 CSV',exact:true}).click();const orderFile=await orderDownload;const orderCsv=await readFile((await orderFile.path())!,'utf8');expect(orderCsv).toContain('업무번호·품목검색필터');expect(orderCsv).toContain(`${code}-OUT`);expect(orderCsv).toContain('누적출하EA');expect(orderCsv).toContain('"명세행수","1"');
 const shipmentDownload=page.waitForEvent('download');await page.getByRole('button',{name:'현재 검색 주문의 출하 CSV',exact:true}).click();const shipmentFile=await shipmentDownload;const shipmentCsv=await readFile((await shipmentFile.path())!,'utf8');expect(shipmentCsv).toContain('분실');expect(shipmentCsv).toContain('처리경계버전');expect(shipmentCsv).toContain('"단위","EA"');expect(shipmentCsv).toContain('"명세행수","1"');
 await page.setViewportSize({width:390,height:844});await expect(page.getByRole('heading',{name:'현장 운영',exact:true})).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
 const me=await(await page.request.get('/api/me')).json();const pendingKey=`wms-v2:${me.tenant.id}:${me.user.id}:request`;
 await page.evaluate(({pendingKey,lastCommand})=>localStorage.setItem(pendingKey,JSON.stringify(lastCommand)),{pendingKey,lastCommand});
 // The warning is sampled every second; advance through one sample after the 14-minute boundary.
 // Resume does not realign the interval, so exactly 14 minutes can still display 61 seconds.
 await page.clock.install({time:new Date()});await page.clock.runFor(14*60_000+1000);await expect(page.getByRole('alert').filter({hasText:'공용 단말이 자동 잠깁니다'})).toBeVisible();await page.getByRole('button',{name:'계속 작업',exact:true}).click();await page.clock.runFor(14*60_000+1000);await expect(page.getByRole('alert').filter({hasText:'공용 단말이 자동 잠깁니다'})).toBeVisible();await page.clock.runFor(60_000);await expect(page).toHaveURL('/login');
 expect(await page.evaluate(pendingKey=>localStorage.getItem(pendingKey),pendingKey)).toBe(JSON.stringify(lastCommand));const revoked=await page.request.get('/api/me');expect(revoked.status()).toBe(401);
});

test('일반 입고·반품 보류 해제와 일정 변경, 잔여 예약 피킹리스트와 재고 연결 추적을 실제 화면에서 처리한다',async({page})=>{
 test.setTimeout(180_000);page.setDefaultTimeout(30_000);
 const password=process.env.DEMO_PASSWORD;if(!password)throw new Error('DEMO_PASSWORD is required');
 await signIn(page.request,'admin.a@example.test',password);
 const code=`TRACE-UI-${randomUUID().slice(0,8)}`.toUpperCase();
 const createdWarehouse=await page.request.post('/api/warehouses',{headers,data:{code,name:code}});expect(createdWarehouse.status()).toBe(201);const warehouse=(await createdWarehouse.json()).warehouse.id;
 async function master(kind:string,data:unknown){const response=await page.request.post(`/api/v2/masters/${kind}?warehouse_id=${warehouse}`,{headers,data});expect(response.status(),await response.text()).toBe(201);return (await response.json()).row.id as string;}
 const longItemName=`${code} 품목 ${'긴이름'.repeat(20)} 마지막`;
 const item=await master('items',{code:`${code}-SKU`,name:longItemName});
 const receiving=await master('locations',{code:`${code}-RCV`,name:'반입 검수',kind:'RECEIVING'}),storage=await master('locations',{code:`${code}-STO`,name:'실제 예약 보관',kind:'STORAGE'}),staging=await master('locations',{code:`${code}-STG`,name:'실제 피킹 대기',kind:'STAGING'});
 const partner=await master('partners',{code:`${code}-PARTNER`,name:`${code} 거래처`,supplier:true,customer:true});
 const destination=await master('destinations',{name:`${code} 배송지`,recipient_name:`${code} 수령인`,address_line1:'서울특별시 종로구 세종대로 1',partner_id:partner});
 async function run(command:string,payload:Record<string,unknown>){const physical=['receipt.receive','receipt.inspect','receipt.putaway','order.pick','package.create','return.receive','return.inspect'];const verified=physical.includes(command)?{...payload,manual_entry_reason:'실제 시험자료의 실물·위치 대조 완료',...(Array.isArray(payload.lines)?{lines:payload.lines.map(line=>({...line,input_mode:'search'}))}:{})}:payload;const response=await page.request.post('/api/v2/workflow',{headers,data:{warehouse_id:warehouse,request_id:randomUUID(),command,payload:verified}});expect(response.status(),await response.text()).toBe(200);return await response.json() as {result:{id:string};snapshot:WorkflowState};}
 async function snapshot(){const response=await page.request.get(`/api/v2/workflow?warehouse_id=${warehouse}`);expect(response.status()).toBe(200);return (await response.json()).snapshot as WorkflowState;}
 const receiptResult=await run('receipt.create',{external_id:`${code}-IN`,supplier_id:partner,expected_at:new Date(Date.now()-86_400_000).toISOString(),lines:[{item_id:item,quantity:12}]});const receiptId=receiptResult.result.id;
 await test.step('홈 입고 지연에서 실제 업무를 열고 예정일을 수정한다',async()=>{
  await page.goto(`/dashboard/v2?warehouse_id=${warehouse}&tab=queue`);const delayed=page.locator('section').filter({has:page.getByRole('heading',{name:'입고 지연 · 1건',exact:true})});await delayed.getByRole('button',{name:new RegExp(`${code}-IN`)}).click();await expect(page.getByRole('heading',{name:`${code}-IN`,exact:true})).toBeVisible();
  await page.getByText('예정 수량·주문 배송지 수정',{exact:true}).click();await page.getByLabel('변경 입고 예정일',{exact:true}).fill('2027-01-15T10:30');await page.getByLabel('수정 사유',{exact:true}).fill('공급처와 확인한 반입 일정 변경');await page.getByRole('button',{name:'현재 버전 확인·변경 저장',exact:true}).click();await expect(page.getByRole('status').filter({hasText:'선택한 수량이 확정되었습니다'})).toBeVisible();expect((await snapshot()).receipts.find(row=>row.id===receiptId)?.expected_at).toBe('2027-01-15T01:30:00.000Z');
 });
 let state=(await run('receipt.receive',{receipt_id:receiptId,receiving_id:randomUUID(),lines:[{line_id:receiptResult.snapshot.receipts[0].lines[0].id,quantity:12,location_id:receiving}]})).snapshot;const receiptLot=state.receipts[0].lots[0].id;
 await run('receipt.inspect',{receipt_id:receiptId,lines:[{lot_id:receiptLot,quantity:12,outcome:'hold'}]});
 await test.step('일반 입고 품질 보류를 화면에서 일부 해제하고 검수 단계로 이어간다',async()=>{
  await page.goto(`/dashboard/v2?warehouse_id=${warehouse}&tab=receipts&object_id=${receiptId}`);await page.getByRole('button',{name:'과납·잔량·보류',exact:true}).click();const release=page.locator('form').filter({has:page.getByRole('heading',{name:'품질 보류 해제·검수 대기 이동',exact:true})});await release.getByRole('checkbox',{name:'스캔 실패 · 검색 선택으로 실물 대조',exact:true}).check();await release.getByRole('spinbutton').fill('4');await release.getByRole('combobox',{name:'처리 도착 위치 · 우선순위 추천순',exact:true}).selectOption(receiving);await release.getByLabel('검색 대체 사유 (필수)',{exact:true}).fill('입고 품질 보류 중 정상화 확인한 실물 4개 재검수');await release.getByRole('checkbox',{name:/선택한 1명세 · 4 EA와 실물/}).check();await release.getByRole('button',{name:'품질 보류 해제·검수 대기 이동 확정',exact:true}).click();await expect(page.getByRole('heading',{name:'검수 판정',exact:true})).toBeVisible();expect((await snapshot()).receipts[0].lots[0]).toMatchObject({hold:8,pending:4});
 });
 await run('receipt.inspect',{receipt_id:receiptId,lines:[{lot_id:receiptLot,quantity:4,outcome:'normal'}]});await run('receipt.putaway',{receipt_id:receiptId,lines:[{lot_id:receiptLot,quantity:4,location_id:storage}]});
 const orderResult=await run('order.create',{external_id:`${code}-OUT`,delivery:{partner_id:partner,delivery_destination_id:destination},due_at:'2027-01-16T10:30:00.000Z',lines:[{item_id:item,quantity:3}]});const orderId=orderResult.result.id;
 await test.step('주문 납기를 수정하고 실제 예약에서 일부 피킹 후 남은 위치·수량을 인쇄한다',async()=>{
  await page.goto(`/dashboard/v2?warehouse_id=${warehouse}&tab=orders&object_id=${orderId}`);await page.getByText('예정 수량·주문 배송지 수정',{exact:true}).click();await page.getByLabel('변경 납기',{exact:true}).fill('2027-01-17T11:45');await page.getByLabel('수정 사유',{exact:true}).fill('고객과 합의한 출고 납기 변경');await page.getByRole('button',{name:'현재 버전 확인·변경 저장',exact:true}).click();await expect(page.getByRole('status').filter({hasText:'선택한 수량이 확정되었습니다'})).toBeVisible();expect((await snapshot()).orders[0].due_at).toBe('2027-01-17T02:45:00.000Z');
  state=(await run('order.reserve',{order_id:orderId,partial:false})).snapshot;const reservation=state.orders[0].reservations[0];expect(reservation).toMatchObject({location_id:storage,quantity:3});await run('order.pick',{order_id:orderId,lines:[{reservation_id:reservation.id,quantity:1,location_id:staging}]});await page.reload();
  const popupReady=page.waitForEvent('popup');await page.getByRole('button',{name:'명세 인쇄 / PDF',exact:true}).click();const popup=await popupReady;await expect(popup.getByRole('heading',{name:'피킹리스트',exact:true})).toBeVisible();const reservationRow=popup.getByRole('row').filter({hasText:`${code}-STO`});await expect(reservationRow).toHaveCount(1);await expect(reservationRow.getByRole('cell').nth(2)).toHaveText(`${code}-STO · 실제 예약 보관`);await expect(reservationRow.getByRole('cell').nth(3)).toHaveText('2');await expect(reservationRow.getByRole('cell').nth(4)).toHaveText('1');await popup.close();
 });
 await test.step('재고 행에서 연결 주문과 같은 품목·위치 원장을 추적한다',async()=>{
  await page.getByRole('tab',{name:'재고',exact:true}).click();const stockRow=page.getByRole('row').filter({has:page.getByRole('cell',{name:`${code}-STO · 실제 예약 보관`,exact:true})});const stockTable=page.locator('.v2-stock-table');await expect(stockTable).toHaveCSS('table-layout','fixed');await expect(stockRow.getByRole('cell').first()).toHaveText(`${code}-SKU · ${longItemName}`);
  await page.setViewportSize({width:390,height:844});const stockViewport=page.locator('.v2-table').filter({has:stockTable});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);expect(await stockViewport.evaluate(element=>element.scrollWidth>element.clientWidth)).toBe(true);expect(await stockRow.getByRole('cell').first().evaluate(element=>getComputedStyle(element).overflowWrap==='anywhere'&&element.scrollWidth<=element.clientWidth+1)).toBe(true);await stockViewport.evaluate(element=>{element.scrollLeft=element.scrollWidth;});expect(await stockViewport.evaluate(element=>element.scrollLeft)).toBeGreaterThan(0);await expect(stockRow.getByRole('button',{name:'연결 주문',exact:true})).toBeVisible();await expect(stockRow.getByRole('button',{name:'원장 추적',exact:true})).toBeVisible();await page.setViewportSize({width:1280,height:720});
  await stockRow.getByRole('button',{name:'연결 주문',exact:true}).click();const linked=page.locator('section').filter({has:page.getByRole('heading',{name:new RegExp(`${code}-STO.*연결 주문`)})});await linked.getByRole('button',{name:new RegExp(`${code}-OUT`)}).click();await expect(page.getByRole('tab',{name:'출고',exact:true})).toHaveAttribute('aria-selected','true');await expect(page.getByRole('heading',{name:`${code}-OUT`,exact:true})).toBeVisible();
  await page.getByRole('tab',{name:'재고',exact:true}).click();const ledgerReady=page.waitForResponse(response=>{const url=new URL(response.url());return url.pathname==='/api/v2/workflow/ledger'&&url.searchParams.get('item_id')===item&&url.searchParams.get('location_id')===storage;});await stockRow.getByRole('button',{name:'원장 추적',exact:true}).click();const ledgerResponse=await ledgerReady;expect(ledgerResponse.status()).toBe(200);const ledger=await ledgerResponse.json();expect(ledger.rows.length).toBeGreaterThan(0);expect(ledger.rows.every((row:{item_id:string;location_id:string})=>row.item_id===item&&row.location_id===storage)).toBe(true);await expect(page.getByRole('combobox',{name:'원장 품목 필터',exact:true})).toHaveValue(item);await expect(page.getByRole('combobox',{name:'원장 위치 필터',exact:true})).toHaveValue(storage);
 });
 state=await snapshot();await run('order.pick',{order_id:orderId,lines:[{reservation_id:state.orders[0].reservations[0].id,quantity:2,location_id:staging}]});state=await snapshot();const packed=await run('package.create',{order_id:orderId,lines:state.orders[0].picks.map(pick=>({pick_id:pick.id,quantity:pick.active}))});const shipment=(await run('shipment.create',{package_ids:[packed.result.id],carrier:'실제 반품 검증 운송',handover_by:'현장 담당자'})).snapshot.shipments[0];
 const returnResult=await run('return.request',{shipment_id:shipment.id,lines:[{shipment_line_id:shipment.lines[0].id,quantity:1}],reason:'회수 실물 검수 요청'});const returnId=returnResult.result.id;const returnObject=returnResult.snapshot.returns[0];state=(await run('return.receive',{return_id:returnId,receiving_id:randomUUID(),lines:[{line_id:returnObject.lines[0].id,quantity:1,location_id:receiving}]})).snapshot;const returnLot=state.returns[0].lots[0].id;await run('return.inspect',{return_id:returnId,lines:[{lot_id:returnLot,quantity:1,outcome:'hold'}]});
 await test.step('일반 반품 품질 보류 해제도 실제 반품 검수로 연결된다',async()=>{
  await page.goto(`/dashboard/v2?warehouse_id=${warehouse}&tab=returns&object_id=${returnId}`);await page.getByRole('button',{name:'과납·잔량·보류',exact:true}).click();const release=page.locator('form').filter({has:page.getByRole('heading',{name:'품질 보류 해제·검수 대기 이동',exact:true})});await release.getByRole('checkbox',{name:'스캔 실패 · 검색 선택으로 실물 대조',exact:true}).check();await release.getByRole('spinbutton').fill('1');await release.getByRole('combobox',{name:'처리 도착 위치 · 우선순위 추천순',exact:true}).selectOption(receiving);await release.getByLabel('검색 대체 사유 (필수)',{exact:true}).fill('반품 보류 실물 1개 재검수 승인 확인');await release.getByRole('checkbox',{name:/선택한 1명세 · 1 EA와 실물/}).check();await release.getByRole('button',{name:'품질 보류 해제·검수 대기 이동 확정',exact:true}).click();await expect(page.getByRole('heading',{name:'검수 판정',exact:true})).toBeVisible();const final=await snapshot();expect(final.returns[0].lots[0]).toMatchObject({hold:0,pending:1});expect(final.receipts[0].lots[0].hold).toBe(8);expect(final.stock.reduce((sum,row)=>sum+row.S+row.P+row.Q+row.B,0)).toBe(10);
 });
});

test('외부 개시재고 CSV 원본·오류 회차를 보존하고 다른 관리자가 승인해 재고를 한 번 반영한다',async({page,browser})=>{
 test.setTimeout(180_000);
 const password=process.env.DEMO_PASSWORD;if(!password)throw new Error('DEMO_PASSWORD is required');
 await signIn(page.request,'admin.a@example.test',password);
 const code=`OPEN-UI-${randomUUID().slice(0,8)}`.toUpperCase();
 const warehouseResponse=await page.request.post('/api/warehouses',{headers,data:{code,name:code}});expect(warehouseResponse.status()).toBe(201);const warehouse=(await warehouseResponse.json()).warehouse.id;
 async function master(kind:string,data:unknown){const response=await page.request.post(`/api/v2/masters/${kind}?warehouse_id=${warehouse}`,{headers,data});expect(response.status(),await response.text()).toBe(201);return (await response.json()).row.id as string;}
 const item=await master('items',{code:`${code}-SKU`,name:`${code} 개시 품목`});await master('locations',{code:`${code}-S`,name:'외부 정상 보관',kind:'STORAGE'});await master('locations',{code:`${code}-B`,name:'외부 보류 위치',kind:'HOLD'});
 const approverEmail=`opening-${randomUUID()}@example.test`,approverPassword=`Temporary-${randomUUID()}-9!`;
 const invitation=await page.request.post('/api/v2/identity/users',{headers,data:{name:'외부 개시 검토 관리자',email:approverEmail,role:'admin',warehouseIds:[warehouse]}});expect(invitation.status()).toBe(201);const issued=await invitation.json();
 const approverContext=await browser.newContext();const approverPage=await approverContext.newPage();
 try{
  const token=new URL(issued.link,headers.origin).searchParams.get('token');expect(token).toBeTruthy();expect((await approverPage.request.post(`${headers.origin}/api/v2/identity/accept`,{headers,data:{token,password:approverPassword}})).status()).toBe(200);await signIn(approverPage.request,approverEmail,approverPassword);
  await page.goto(`/dashboard/v2?warehouse_id=${warehouse}&tab=cutover`);await expect(page.getByRole('heading',{name:'외부 자료 개시재고 · 별도 검토',exact:true})).toBeVisible();await page.getByLabel('외부 원천 시스템',{exact:true}).fill('외부 시스템 샘플');await page.getByLabel('원본 자료 추출 시각',{exact:true}).fill('2026-10-19T10:00');await page.getByLabel('개시재고 반입 근거·사유',{exact:true}).fill('실물 확인을 완료한 외부 시스템 최초 개시 자료');
  const invalid=`item_code,location_code,bucket,quantity\r\n${code}-SKU,${code}-S,S,7\r\nMISSING-${code},${code}-S,S,1\r\n`;
  await page.getByLabel('외부 개시재고 CSV 파일',{exact:true}).setInputFiles({name:'opening-invalid.csv',mimeType:'text/csv',buffer:Buffer.from(invalid)});await page.getByRole('button',{name:'외부 자료 형식·코드·수량 검증',exact:true}).click();await expect(page.getByRole('heading',{name:'오류 행 · 승인 불가',exact:true})).toBeVisible();await page.getByRole('button',{name:'원본·오류 포함 회차 보존·검토 요청',exact:true}).click();await expect(page.getByText('개시재고 회차 1 · 외부 시스템 샘플 · 검토 대기',{exact:true})).toBeVisible();
  const savedInvalid=(await(await page.request.get(`/api/v2/operations/opening-import?warehouse_id=${warehouse}`)).json()).imports.find((record:{phase:string})=>record.phase==='request');expect(savedInvalid.payload.csv).toBe(invalid);expect(savedInvalid.payload.errors).toHaveLength(1);
  await approverPage.goto(`${headers.origin}/dashboard/v2?warehouse_id=${warehouse}&tab=cutover`);await approverPage.getByText('개시재고 회차 1 · 외부 시스템 샘플 · 검토 대기',{exact:true}).click();await approverPage.getByLabel('개시재고 회차 1 검토 사유',{exact:true}).fill('오류 품목 코드를 수정한 새 파일로 제출 요청');const invalidCard=approverPage.locator('details').filter({hasText:'개시재고 회차 1 · 외부 시스템 샘플'});await invalidCard.getByRole('checkbox').check();await expect(invalidCard.getByRole('button',{name:'검토한 외부 개시재고 승인',exact:true})).toBeDisabled();await invalidCard.getByRole('button',{name:'사유 남기고 회차 반려',exact:true}).click();await expect(approverPage.getByText('개시재고 회차 1 · 외부 시스템 샘플 · 반려됨',{exact:true})).toBeVisible();
  const valid=`item_code,location_code,bucket,quantity\r\n${code}-SKU,${code}-S,S,7\r\n${code}-SKU,${code}-B,B,3\r\n`;
  await page.getByLabel('외부 개시재고 CSV 파일',{exact:true}).setInputFiles({name:'opening-reviewed.csv',mimeType:'text/csv',buffer:Buffer.from(valid)});await page.getByRole('button',{name:'외부 자료 형식·코드·수량 검증',exact:true}).click();await expect(page.getByRole('heading',{name:'개시재고 검증 미리보기',exact:true})).toBeVisible();await page.getByRole('button',{name:'원본·오류 포함 회차 보존·검토 요청',exact:true}).click();await expect(page.getByText('개시재고 회차 2 · 외부 시스템 샘플 · 검토 대기',{exact:true})).toBeVisible();
  await approverPage.reload();await approverPage.getByText('개시재고 회차 2 · 외부 시스템 샘플 · 검토 대기',{exact:true}).click();const validCard=approverPage.locator('details').filter({hasText:'개시재고 회차 2 · 외부 시스템 샘플'});await validCard.getByLabel('개시재고 회차 2 검토 사유',{exact:true}).fill('추출 시각과 정상 7·보류 3 실물 및 빈 창고 확인');await validCard.getByRole('checkbox').check();
  let approvalRequest:unknown;approverPage.on('request',request=>{if(request.method()==='POST'&&new URL(request.url()).pathname==='/api/v2/operations/opening-import'){const body=request.postDataJSON();if(body.action==='approve')approvalRequest=body;}});
  await validCard.getByRole('button',{name:'검토한 외부 개시재고 승인',exact:true}).click();await expect(approverPage.getByText('개시재고 회차 2 · 외부 시스템 샘플 · 승인됨',{exact:true})).toBeVisible();
  const snapshot=(await(await approverPage.request.get(`${headers.origin}/api/v2/workflow?warehouse_id=${warehouse}`)).json()).snapshot;const quantities=snapshot.stock.filter((row:{item_id:string})=>row.item_id===item);expect(quantities.reduce((sum:number,row:{H:number})=>sum+row.H,0)).toBe(10);expect(quantities.reduce((sum:number,row:{S:number})=>sum+row.S,0)).toBe(7);expect(quantities.reduce((sum:number,row:{B:number})=>sum+row.B,0)).toBe(3);
  expect(approvalRequest).toBeTruthy();const replay=await approverPage.request.post(`${headers.origin}/api/v2/operations/opening-import`,{headers,data:approvalRequest});expect(replay.status()).toBe(200);expect((await replay.json()).replayed).toBe(true);const repeated=(await(await approverPage.request.get(`${headers.origin}/api/v2/workflow?warehouse_id=${warehouse}`)).json()).snapshot;expect(repeated.stock).toEqual(snapshot.stock);expect(repeated.ledger_count).toBe(snapshot.ledger_count);
  const history=(await(await approverPage.request.get(`${headers.origin}/api/v2/operations/opening-import?warehouse_id=${warehouse}`)).json()).imports;expect(history.filter((record:{phase:string})=>record.phase==='approve')).toHaveLength(1);expect(history.find((record:{phase:string;payload:{csv?:string}})=>record.phase==='request'&&record.payload.csv===valid)).toBeTruthy();
 }finally{await approverContext.close();}
});
