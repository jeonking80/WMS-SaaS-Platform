import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
const headers={origin:'http://127.0.0.1:3100'};
test('처음 쓰는 작업자도 홈의 시작 버튼과 지금 할 일 안내만으로 입고·출고를 진행한다',async({page})=>{
 test.setTimeout(120_000);page.setDefaultTimeout(30_000);
 const password=process.env.DEMO_PASSWORD;if(!password)throw new Error('DEMO_PASSWORD is required');
 for(let attempt=0;attempt<4;attempt++){const response=await page.request.post(`${headers.origin}/api/auth/sign-in/email`,{headers,data:{email:'admin.a@example.test',password}});if(response.status()!==429||attempt===3){expect(response.status()).toBe(200);break;}await page.waitForTimeout(Number(response.headers()['retry-after']||10)*1000);}
 const code=`GD-${randomUUID().slice(0,8)}`.toUpperCase();
 const created=await page.request.post('/api/warehouses',{headers,data:{code,name:`${code} 안내창고`}});expect(created.status()).toBe(201);const warehouse=(await created.json()).warehouse.id;
 async function master(kind:string,data:unknown){const response=await page.request.post(`/api/v2/masters/${kind}?warehouse_id=${warehouse}`,{headers,data});expect(response.status(),await response.text()).toBe(201);return (await response.json()).row.id as string;}
 await page.goto(`/dashboard/v2?warehouse_id=${warehouse}&tab=queue`);
 await expect(page.getByText('업무 시작 전 준비가 필요합니다',{exact:true})).toBeVisible();
 const item=await master('items',{code:`${code}-SKU`,name:`${code} 품목`});
 const receiving=await master('locations',{code:`${code}-RCV`,name:'수령 대기',kind:'RECEIVING'});
 await master('locations',{code:`${code}-STO`,name:'보관',kind:'STORAGE'});await master('locations',{code:`${code}-STG`,name:'포장 대기',kind:'STAGING'});
 const supplier=await master('partners',{code:`${code}-SUP`,name:'안내 공급처',supplier:true,customer:false});
 const customer=await master('partners',{code:`${code}-CUS`,name:'안내 납품처',supplier:false,customer:true});
 const destination=await master('destinations',{name:`${code} 배송지`,recipient_name:'수령인',address_line1:'서울특별시 중구 세종대로 110',partner_id:customer});
 await master('barcodes',{barcode:`${code}-L-RCV`,location_id:receiving});await master('barcodes',{barcode:`${code}-BOX12`,item_id:item,unit:'BOX',quantity:12});
 await page.reload();await expect(page.getByText('업무 시작 전 준비가 필요합니다',{exact:true})).toHaveCount(0);
 await page.getByRole('button',{name:/입고예정 등록/}).click();
 await page.getByRole('button',{name:'오늘 18:00',exact:true}).click();await expect(page.getByLabel('입고 예정일',{exact:true})).not.toHaveValue('');
 await page.getByLabel('공급처',{exact:true}).selectOption(supplier);await page.getByLabel('품목 1',{exact:true}).selectOption(item);await page.getByLabel('품목 1 예정 수량 (EA)',{exact:true}).fill('24');
 await page.getByRole('button',{name:'등록 · 재고 변동 없음',exact:true}).click();
 const next=page.locator('.v2-next');await expect(next).toContainText('수령할 수량 24 EA');
 await expect(page.getByRole('button',{name:'1 수령',exact:true})).toHaveAttribute('aria-selected','true');
 const blocker=page.locator('.v2-blocker');await expect(blocker).toContainText('도착 위치 바코드를 스캔하세요.');
 const scan=page.getByRole('textbox',{name:'도착 위치 → 품목 바코드 스캔',exact:true});
 for(const value of [`${code}-L-RCV`,`${code}-BOX12`]){await scan.fill(value);await scan.press('Enter');}
 await expect(blocker).toContainText('아래 확인란을 체크하세요');
 await page.getByRole('checkbox',{name:/선택한 1명세 · 12 EA와 실물/}).check();await expect(blocker).toHaveCount(0);
 await page.getByRole('button',{name:'실물 수령 확정',exact:true}).click();
 await expect(next).toContainText('검수할 수량 12 EA');await expect(page.getByRole('button',{name:'1 수령',exact:true})).toContainText('12 EA 남음');
 await page.getByRole('tab',{name:'출고',exact:true}).click();await page.getByRole('button',{name:'신규 등록',exact:true}).click();
 await page.getByRole('button',{name:'내일 09:00',exact:true}).click();await page.getByLabel('납품처',{exact:true}).selectOption(customer);await page.getByLabel('배송지 주소록',{exact:true}).selectOption(destination);await page.getByLabel('품목 1',{exact:true}).selectOption(item);await page.getByLabel('품목 1 예정 수량 (EA)',{exact:true}).fill('5');
 await expect(page.getByText('창고 가용 0 EA (참고) · 부족분은 입고 후 예약',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'등록 · 재고 변동 없음',exact:true}).click();
 await expect(next).toContainText('예약할 수량 5 EA');await expect(page.getByText(/가용재고가 부족한 품목이 있습니다/)).toBeVisible();
 await expect(page.getByRole('button',{name:'가능 수량만 예약',exact:true})).toHaveClass(/v2-primary/);
 await page.getByRole('tab',{name:'업무 대기열',exact:true}).click();
 const work=page.locator('section').filter({has:page.getByRole('heading',{name:'지금 처리할 작업 · 2건',exact:true})});
 await expect(work.getByRole('button',{name:/출고 작업.*예약할 수량 5 EA/})).toBeVisible();await expect(work.getByRole('button',{name:/입고 작업.*검수할 수량 12 EA/})).toBeVisible();
 await page.getByRole('button',{name:/^미출하 주문/}).click();await expect(page.getByRole('tab',{name:'출고',exact:true})).toHaveAttribute('aria-selected','true');
 await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
});
