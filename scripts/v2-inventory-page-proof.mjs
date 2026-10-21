/** Read-only inventory pagination proof against the independent fixture manifest. */
import {createHash} from 'node:crypto';
import {expect} from '@playwright/test';
export const INVENTORY_PAGE_SIZE=100;
export const INVENTORY_DISPLAY_PROFILE='inventory-pages-v1';
const buckets=['H','S','A','R','P','Q','B'];
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const key=row=>row.item_id+':'+row.location_id;
const label=row=>`${row.code?row.code+' · ':''}${row.name||row.code||'선택 항목'}`;
function numeric(text){const value=String(text??'').replaceAll(',','').trim();requireValue(/^-?\d+$/.test(value)&&Number.isSafeInteger(Number(value)),'INVENTORY_INVALID_QUANTITY');return Number(value);}
function requireValue(condition,code){if(!condition)throw Object.assign(new Error(code),{code});}
function expectedRow(row){return {...row,H:row.S+row.P+row.Q+row.B,A:row.S-row.R};}
function totals(rows){return Object.fromEntries(buckets.map(bucket=>[bucket,rows.reduce((sum,row)=>sum+row[bucket],0)]));}
function sameTotals(a,b){return buckets.every(bucket=>a[bucket]===b[bucket]);}
export function parseInventoryCsv(text){
 const rows=[];let row=[],cell='',quoted=false;const value=text.replace(/^\uFEFF/,'');
 for(let i=0;i<value.length;i++){
  const char=value[i];if(char==='"'){if(quoted&&value[i+1]==='"'){cell+='"';i++;}else quoted=!quoted;}
  else if(char===','&&!quoted){row.push(cell);cell='';}
  else if((char==='\r'||char==='\n')&&!quoted){if(char==='\r'&&value[i+1]==='\n')i++;row.push(cell);rows.push(row);row=[];cell='';}
  else cell+=char;
 }
 requireValue(!quoted,'UNTERMINATED_INVENTORY_CSV');if(cell.length||row.length){row.push(cell);rows.push(row);}return rows;
}
async function tableRows(table){return table.locator('tbody tr').evaluateAll(rows=>rows.map(row=>({item_id:row.getAttribute('data-item-id'),location_id:row.getAttribute('data-location-id'),cells:[...row.querySelectorAll('td')].map(cell=>cell.textContent?.trim()??''),buttons:[...row.querySelectorAll('button')].map(button=>button.textContent?.trim()??'')})));}
function verifyRows(rows,expected,withButtons=true){
 for(const row of rows){const reference=expected.get(key(row));requireValue(!!reference,'INVENTORY_UNEXPECTED_POSITION');requireValue(row.cells.length===(withButtons?11:10),'INVENTORY_CELL_COUNT');
  for(const [index,bucket]of buckets.entries())requireValue(numeric(row.cells[index+2])===reference[bucket],'INVENTORY_BUCKET_VALUE_MISMATCH');
  if(withButtons)requireValue(row.buttons.length===2&&row.buttons.includes('연결 주문')&&row.buttons.includes('원장 추적'),'INVENTORY_TRACE_BUTTONS_MISSING');
 }
}
async function readTotals(page){const entries=await page.locator('[data-stock-metric]').evaluateAll(nodes=>nodes.map(node=>[node.getAttribute('data-stock-metric'),node.querySelector('strong')?.textContent]));requireValue(entries.length===buckets.length&&new Set(entries.map(([bucket])=>bucket)).size===buckets.length&&entries.every(([bucket])=>buckets.includes(bucket)),'INVENTORY_TOTAL_BUCKETS_MISSING');return Object.fromEntries(entries.map(([bucket,value])=>[bucket,numeric(value)]));}
async function expectPage(table,index,total,visible){await expect(table).toHaveAttribute('data-stock-page-index',String(index),{timeout:10000});await expect(table).toHaveAttribute('data-stock-total',String(total));await expect(table).toHaveAttribute('data-stock-page-size',String(INVENTORY_PAGE_SIZE));await expect(table.locator('tbody tr')).toHaveCount(visible);}
async function csvProof(page,section,tenant,expected,{pageIndex=15,itemFilter='전체',locationFilter='전체'}={}){
 const waiting=page.waitForEvent('download');await section.getByRole('button',{name:'현재 필터 재고 CSV',exact:true}).click();const download=await waiting,stream=await download.createReadStream();requireValue(!!stream,'INVENTORY_CSV_DOWNLOAD_FAILED');const chunks=[];for await(const chunk of stream)chunks.push(chunk);const bytes=Buffer.concat(chunks),rows=parseInventoryCsv(bytes.toString('utf8'));
 requireValue(rows.length>=2,'INVENTORY_CSV_HEADER_MISSING');const metadata=rows[0],header=rows[1],body=rows.slice(2),value=caption=>{const index=metadata.indexOf(caption);requireValue(index>=0&&index%2===0,'INVENTORY_CSV_METADATA_MISSING');return metadata[index+1];};
 requireValue(value('회사')===`Performance company ${tenant.company}`&&value('창고코드')==='PERF'&&value('창고명')==='Performance warehouse'&&value('창고ID')===tenant.warehouse_id&&value('품목필터')===itemFilter&&value('위치필터')===locationFilter&&value('단위')==='EA'&&numeric(value('총행수'))===expected.size&&Number.isFinite(Date.parse(value('조회시각'))),'INVENTORY_CSV_METADATA_MISMATCH');
 requireValue(numeric(value('버전'))===tenant.expected_version,'INVENTORY_CSV_VERSION_MISMATCH');
 requireValue(header.join('|')===['품목','위치',...buckets,'잠금'].join('|')&&body.length===expected.size,'INVENTORY_CSV_INCOMPLETE');
 const items=new Map(tenant.items.map(row=>[label(row),row.id])),locations=new Map(tenant.locations.map(row=>[label(row),row.id]));requireValue(items.size===tenant.items.length&&locations.size===tenant.locations.length,'INVENTORY_REFERENCE_LABEL_COLLISION');
 const decoded=body.map(cells=>({item_id:items.get(cells[0]),location_id:locations.get(cells[1]),cells}));verifyRows(decoded,expected,false);const keys=decoded.map(key),unique=new Set(keys);requireValue(unique.size===expected.size&&keys.length===unique.size&&[...expected.keys()].every(id=>unique.has(id)),'INVENTORY_CSV_KEYS_MISMATCH');
 return {passed:true,downloaded_from_page_index:pageIndex,downloaded_from_page:pageIndex+1,rows:body.length,unique_positions:unique.size,duplicates:keys.length-unique.size,missing_positions:0,extra_positions:0,keys_sha256:digest([...unique].sort()),file_sha256:createHash('sha256').update(bytes).digest('hex'),metadata_verified:true,values_match_independent_manifest:true};
}
export async function verifyInventoryPagePreservation({browser,origin,storageState,tenant}){
 const evidence={company:tenant.company,display_profile:INVENTORY_DISPLAY_PROFILE,underlying_positions:tenant.expected_positions.length,page_size:INVENTORY_PAGE_SIZE,passed:false,pages:[],checks:{},source:'Independent baseline expected_positions and master reference metadata; WMS stock quantities are not used as expectations.'};
 const context=await browser.newContext({baseURL:origin,storageState,viewport:{width:1280,height:900}}),page=await context.newPage();
 try{
  evidence.current_stage='independent_manifest';
  const expected=new Map(tenant.expected_positions.map(row=>[key(row),expectedRow(row)])),wholeTotals=totals([...expected.values()]),seen=[],pages=Math.ceil(expected.size/INVENTORY_PAGE_SIZE);
  requireValue(expected.size===1600&&pages===16,'INVENTORY_PROOF_FIXTURE_SIZE');
  const response=await page.goto('/dashboard/v2');requireValue(response?.ok(),'INVENTORY_PROOF_NAVIGATION_FAILED');await page.getByRole('tab',{name:'재고·실사·승인',exact:true}).click();
  const section=page.getByRole('heading',{name:'위치·품목별 재고',exact:true}).locator('xpath=ancestor::section[1]'),table=section.getByRole('table',{name:'위치·품목별 재고 목록',exact:true}),nav=section.getByRole('navigation',{name:'재고 목록 페이지 이동',exact:true}),previous=nav.getByRole('button',{name:'이전 재고 페이지',exact:true}),next=nav.getByRole('button',{name:'다음 재고 페이지',exact:true}),choosePage=nav.getByRole('combobox',{name:'재고 목록 페이지',exact:true});
  evidence.current_stage='all_pages';let lastRow;
  for(let index=0;index<pages;index++){
   await expectPage(table,index,expected.size,INVENTORY_PAGE_SIZE);if(index===0)await expect(previous).toBeDisabled();const rows=await tableRows(table);verifyRows(rows,expected);const keys=rows.map(key);seen.push(...keys);lastRow=rows.at(-1);
   const displayedTotals=await readTotals(page);requireValue(sameTotals(displayedTotals,wholeTotals),'INVENTORY_GLOBAL_TOTALS_CHANGED_WITH_PAGE');
   evidence.pages.push({index,rows:rows.length,first_key:keys[0],last_key:keys.at(-1),keys_sha256:digest(keys),all_values_match:true,trace_buttons:rows.length*2,global_totals:displayedTotals});
   if(index<pages-1){await expect(next).toBeEnabled();await next.click();}else await expect(next).toBeDisabled();
  }
  const unique=new Set(seen),missing=[...expected.keys()].filter(id=>!unique.has(id)),extra=[...unique].filter(id=>!expected.has(id));
  evidence.union={rows_seen:seen.length,unique_positions:unique.size,duplicates:seen.length-unique.size,missing,extra,expected_keys_sha256:digest([...expected.keys()].sort()),observed_keys_sha256:digest([...unique].sort())};
  requireValue(seen.length===expected.size&&unique.size===seen.length&&!missing.length&&!extra.length,'INVENTORY_PAGE_UNION_MISMATCH');
  evidence.current_stage='full_csv';evidence.csv=await csvProof(page,section,tenant,expected);
  // Select the pair from the final page, then filter the full data, not that page.
  evidence.current_stage='full_scope_filters';const chosenItem=tenant.items.find(row=>row.id===lastRow.item_id),chosenLocation=tenant.locations.find(row=>row.id===lastRow.location_id);
  await page.getByRole('textbox',{name:'재고 품목 검색',exact:true}).fill(chosenItem.code);await page.getByRole('combobox',{name:'재고 품목',exact:true}).selectOption(chosenItem.id);
  const itemPositions=[...expected.values()].filter(row=>row.item_id===chosenItem.id),itemExpected=new Map(itemPositions.map(row=>[key(row),row]));await expectPage(table,0,itemPositions.length,itemPositions.length);const itemRows=await tableRows(table);verifyRows(itemRows,itemExpected);const itemKeys=new Set(itemRows.map(key));requireValue(itemKeys.size===itemPositions.length&&itemPositions.every(row=>itemKeys.has(key(row)))&&sameTotals(await readTotals(page),totals(itemPositions)),'INVENTORY_ITEM_FILTER_INCOMPLETE');
  evidence.filtered_csv=await csvProof(page,section,tenant,itemExpected,{pageIndex:0,itemFilter:label(chosenItem)});
  await page.getByRole('textbox',{name:'재고 위치 검색',exact:true}).fill(chosenLocation.code);await page.getByRole('combobox',{name:'재고 위치',exact:true}).selectOption(chosenLocation.id);
  await expectPage(table,0,1,1);const pair=await tableRows(table);verifyRows(pair,expected);requireValue(key(pair[0])===key(lastRow)&&sameTotals(await readTotals(page),totals([expected.get(key(lastRow))])),'INVENTORY_PAIR_FILTER_MISMATCH');
  evidence.checks.full_scope_search={passed:true,selected_from_page_index:15,selected_from_page:16,item_id:chosenItem.id,location_id:chosenLocation.id,item_matches:itemPositions.length,pair_matches:1,totals_verified:true,page_reset_to_zero:true};
  await page.getByRole('textbox',{name:'재고 품목 검색',exact:true}).fill('');await page.getByRole('combobox',{name:'재고 품목',exact:true}).selectOption('');await page.getByRole('textbox',{name:'재고 위치 검색',exact:true}).fill('');await page.getByRole('combobox',{name:'재고 위치',exact:true}).selectOption('');await expectPage(table,0,expected.size,INVENTORY_PAGE_SIZE);
  evidence.current_stage='last_page_traces';await choosePage.selectOption(String(pages-1));await expectPage(table,pages-1,expected.size,INVENTORY_PAGE_SIZE);const traced=table.locator('tbody tr').last();
  await traced.getByRole('button',{name:'연결 주문',exact:true}).click();await expect(page.getByRole('heading',{name:label(chosenItem)+' · '+label(chosenLocation)+' 연결 주문',exact:true})).toBeVisible();await page.getByRole('button',{name:'연결 조회 닫기',exact:true}).click();
  const ledgerResponse=page.waitForResponse(response=>{const u=new URL(response.url());return response.request().method()==='GET'&&u.pathname==='/api/v2/workflow/ledger'&&u.searchParams.get('item_id')===chosenItem.id&&u.searchParams.get('location_id')===chosenLocation.id;});
  await traced.getByRole('button',{name:'원장 추적',exact:true}).click();const ledger=await ledgerResponse,body=await ledger.json();requireValue(ledger.ok()&&body.warehouse_id===tenant.warehouse_id&&body.rows.length>0&&body.rows.every(row=>row.item_id===chosenItem.id&&row.location_id===chosenLocation.id),'INVENTORY_LEDGER_TRACE_FILTER_MISMATCH');
  evidence.checks.last_page_traces={passed:true,linked_order_context_verified:true,ledger_item_id:chosenItem.id,ledger_location_id:chosenLocation.id,ledger_status:ledger.status(),ledger_rows:body.rows.length};
  evidence.passed=true;delete evidence.current_stage;
 }catch(error){evidence.error={stage:evidence.current_stage,code:String(error.code??error.name)};}
 finally{await context.close();}
 return evidence;
}
