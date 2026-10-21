import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import type {Order,Package} from '../../src/server/v2/workflow/types';
import {printPackage} from '../../src/app/dashboard/v2/package-print';
import {time} from '../../src/app/dashboard/v2/common';

const printedAt='2026-10-21T02:30:00.000Z',createdAt='2026-10-20T01:00:00.000Z';
const c={company:'회사 A',warehouse:'warehouse-stable-id',warehouseCode:'WH-A',warehouseName:'서울창고',items:[{id:'item',code:'SKU',name:'품목'}],snapshot:{version:42}};
const order:Order={id:'order-stable-id',external_id:'EXT-ORDER',version:8,created_at:createdAt,delivery:{id:'current-destination',recipient_name:'CURRENT RECIPIENT',address_line1:'CURRENT ADDRESS MUST NOT PRINT'},lines:[],reservations:[],picks:[{id:'pick-stable-id',line_id:'order-line-stable-id',reservation_id:'reservation',item_id:'item',location_id:'staging',quantity:2,active:2,packed:2,shipped:0,damaged:0,returned:0,cancel_pending:0}]};
const pack:Package={id:'package-stable-id',order_id:order.id,status:'complete',weight_grams:1250,created_at:createdAt,lines:[{pick_id:'pick-stable-id',quantity:2}],delivery:{delivery_destination_id:'saved-destination-id',partner_id:'saved-partner-id',name:'저장 배송지',recipient_name:'저장 수령인',postal_code:'01234',address_line1:'저장 기본주소',address_line2:'저장 상세주소',contact_name:'저장 담당자',phone:'010-1111-2222'}};
const popup={document:{write:vi.fn(),close:vi.fn()},focus:vi.fn(),print:vi.fn()};
function html(){return String(popup.document.write.mock.calls.at(-1)![0]);}
beforeEach(()=>{vi.clearAllMocks();vi.stubGlobal('window',{open:vi.fn(()=>popup)});});
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();vi.restoreAllMocks();});

describe('internal package manifest identification and saved delivery',()=>{
 it('prints stable package/order/pick references, saved delivery, warehouse and distinct output metadata without changing state',()=>{
  const before=structuredClone({c,pack,order});
  printPackage(c,pack,order,printedAt);
  const document=html();
  for(const value of ['package-stable-id','order-stable-id','EXT-ORDER','pick-stable-id','order-line-stable-id','서울창고','WH-A','warehouse-stable-id','상태 버전 42','주문 버전','1250 g','SKU · 품목','saved-destination-id','saved-partner-id','저장 수령인','저장 기본주소 저장 상세주소','01234','저장 담당자','010-1111-2222'])expect(document).toContain(value);
  expect(document).toContain(`출력 시각 ${time(printedAt)}`);
  expect(document).toContain(`<td>포장 생성 시각</td><td>${time(createdAt)}</td>`);
  expect(document).not.toContain('CURRENT');expect(document).not.toContain('current-destination');
  expect({c,pack,order}).toEqual(before);
  expect(popup.document.close).toHaveBeenCalledOnce();expect(popup.print).toHaveBeenCalledOnce();
 });
 it('captures a fresh output time on each click rather than reuse package creation time',()=>{
  vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date(printedAt));
  printPackage(c,pack,order);
  expect(html()).toContain(`출력 시각 ${time(printedAt)}`);
  const later='2026-10-21T02:31:00.000Z';vi.setSystemTime(new Date(later));
  printPackage(c,pack,order);
  expect(html()).toContain(`출력 시각 ${time(later)}`);
  expect(html()).toContain(`<td>포장 생성 시각</td><td>${time(createdAt)}</td>`);
 });
 it('distinguishes identical contents in separate packages and retains their identifiers on reprint',()=>{
  printPackage(c,pack,order,printedAt);const first=html();
  printPackage(c,{...pack,id:'other-package-stable-id'},order,printedAt);const second=html();
  expect(first).toContain('<td>포장번호</td><td>package-stable-id</td>');
  expect(second).toContain('<td>포장번호</td><td>other-package-stable-id</td>');
  printPackage(c,pack,order,printedAt);expect(html()).toBe(first);
 });
 it('passes all dynamic values through the existing HTML-escaping printSheet',()=>{
  const value='<img src=x onerror="alert(1)">&';
  printPackage({...c,company:value,warehouseName:value},{...pack,id:value,delivery:{recipient_name:value,address_line1:value}},{...order,external_id:value},printedAt);
  const document=html();
  expect(document).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&amp;');
  expect(document).not.toContain('<img');expect(document).not.toContain('onerror="alert(1)"');
 });
 it.each([{delivery:null},{delivery:'legacy scalar'},{delivery:[]}])('does not substitute current delivery when the saved snapshot is unavailable ($delivery)',({delivery})=>{
  printPackage(c,{...pack,delivery,weight_grams:undefined},order,printedAt);
  expect(html()).toContain('<td>배송지 스냅샷 ID</td><td>미기록</td>');
  expect(html()).toContain('<td>배송주소</td><td>미기록</td>');
  expect(html()).toContain('미입력');expect(html()).not.toContain('CURRENT');
 });
 it('retains the saved pick reference and quantity when a legacy source link is missing',()=>{
  printPackage(c,pack,{...order,picks:[]},printedAt);
  expect(html()).toContain('<td>원피킹 연결 확인 필요</td><td>2</td><td>pick-stable-id</td><td>미기록</td>');
 });
 it('treats a blocked print popup as a read-only no-op',()=>{
  vi.stubGlobal('window',{open:vi.fn(()=>null)});
  const before=structuredClone({c,pack,order});printPackage(c,pack,order,printedAt);
  expect(popup.document.write).not.toHaveBeenCalled();expect(popup.print).not.toHaveBeenCalled();expect({c,pack,order}).toEqual(before);
 });
});
