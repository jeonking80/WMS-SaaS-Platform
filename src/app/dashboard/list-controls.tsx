"use client";
import { useState } from "react";
import { ItemPicker } from "./components/item-picker";
import { control, type MasterRow } from "./api-client";
export type Pagination={page:number;page_size:number;total:number;total_pages:number};
export const seoulTime=(value:string)=>new Date(value).toLocaleString("ko-KR",{timeZone:"Asia/Seoul"});
export function Pager({value,onChange,pending=false}:{value:Pagination|null;onChange:(page:number)=>void;pending?:boolean}){return value&&<div className="my-4 flex flex-wrap items-center gap-3"><span>총 {value.total}건 · {value.page} / {Math.max(1,value.total_pages)} 페이지</span><button className={control} disabled={pending||value.page<=1} onClick={()=>onChange(value.page-1)}>이전 페이지</button><button className={control} disabled={pending||value.page>=value.total_pages} onClick={()=>onChange(value.page+1)}>다음 페이지</button></div>;}
export type Filters={q:string;warehouse_id:string;location_id:string;item_id:string;kind:string;status:string;date_from:string;date_to:string;date_field:string;originals_only:string};
export const emptyFilters:Filters={q:"",warehouse_id:"",location_id:"",item_id:"",kind:"",status:"",date_from:"",date_to:"",date_field:"",originals_only:""};
export function query(filters:Filters,page:number,extra:Record<string,string>={}){const params=new URLSearchParams({...extra,page:String(page),page_size:"25"});Object.entries(filters).forEach(([k,v])=>{if(v)params.set(k,v)});return params.toString();}
const field="flex min-w-0 flex-col gap-1.5 text-sm",caption="text-xs font-semibold text-slate-600";
const input=`${control} h-11 w-full text-slate-900`;
const kinds:Record<string,string>={INBOUND:"입고",OUTBOUND:"출고",TRANSFER:"이동"};
const states:Record<string,string>={DRAFT:"초안",CANCELLED:"취소됨",POSTED:"확정됨",REVERSED:"확정 취소됨"};
const dateFields:Record<string,string>={created_at:"작성 시각",posted_at:"확정 시각",reversed_at:"확정 취소 시각"};
// Frequent conditions stay on one line; the rest fold under 상세 필터 and every chosen condition shows as a removable chip.
export function FilterForm({value,setValue,onSubmit,warehouses,locations,documents=false,history=false,dates=true,ledger=false,datePrefix="",embedded=false}:{value:Filters;setValue:(f:Filters)=>void;onSubmit:()=>void;warehouses:MasterRow[];locations:MasterRow[];documents?:boolean;history?:boolean;dates?:boolean;ledger?:boolean;datePrefix?:string;embedded?:boolean}){
 const typed=documents||ledger;
 const detailKeys:(keyof Filters)[]=["location_id","item_id",...(typed?["kind","status"] as const:[]),...(documents?["date_field","originals_only"] as const:[])];
 const detailCount=detailKeys.filter(key=>value[key]).length;
 const [open,setOpen]=useState(detailCount>0);
 function change(key:keyof Filters,v:string){setValue({...value,[key]:v,...(key==="warehouse_id"?{location_id:""}:{})})}
 const warehouse=warehouses.find(w=>w.id===value.warehouse_id),location=locations.find(l=>l.id===value.location_id);
 const chips:[string,string,(keyof Filters)[]][]=[
  ...(value.q?[["검색어",value.q,["q"]] as [string,string,(keyof Filters)[]]]:[]),
  ...(value.warehouse_id?[["창고",warehouse?`${warehouse.code} · ${warehouse.name}`:"선택한 창고",["warehouse_id","location_id"]] as [string,string,(keyof Filters)[]]]:[]),
  ...(value.location_id?[["로케이션",location?location.code:"선택한 로케이션",["location_id"]] as [string,string,(keyof Filters)[]]]:[]),
  ...(value.item_id?[["품목","선택한 품목",["item_id"]] as [string,string,(keyof Filters)[]]]:[]),
  ...(typed&&value.kind?[["유형",kinds[value.kind]||value.kind,["kind"]] as [string,string,(keyof Filters)[]]]:[]),
  ...(typed&&value.status?[["상태",states[value.status]||value.status,["status"]] as [string,string,(keyof Filters)[]]]:[]),
  ...(documents&&value.date_field?[["날짜 기준",dateFields[value.date_field]||value.date_field,["date_field"]] as [string,string,(keyof Filters)[]]]:[]),
  ...(dates&&(value.date_from||value.date_to)?[[`${datePrefix}기간`,`${value.date_from||"처음"} ~ ${value.date_to||"오늘"}`,["date_from","date_to"]] as [string,string,(keyof Filters)[]]]:[]),
  ...(documents&&value.originals_only?[["취소 전표","자동 생성분 제외",["originals_only"]] as [string,string,(keyof Filters)[]]]:[]),
 ];
 return <form className={`my-5 flex min-w-0 max-w-full flex-col gap-3 text-sm ${embedded?"":"rounded-xl border border-slate-200 bg-white p-4"}`} onSubmit={e=>{e.preventDefault();onSubmit()}}>
  <div className="grid min-w-0 grid-cols-1 items-end gap-3 md:grid-cols-2 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1.5fr)_auto_auto]">
   <label className={field}><span className={caption}>검색어</span><input className={input} value={value.q} onChange={e=>change("q",e.target.value)} placeholder="코드·이름·전표 검색"/></label>
   <label className={field}><span className={caption}>창고 필터</span><select className={input} value={value.warehouse_id} onChange={e=>change("warehouse_id",e.target.value)}><option value="">전체 창고</option>{warehouses.map(w=><option key={w.id} value={w.id}>{w.code} · {w.name}</option>)}</select></label>
   {dates?<fieldset className={field} title="서울 시간 기준 시작일 00:00부터 종료일 23:59까지 포함합니다."><legend className={`${caption} mb-1.5`}>{datePrefix}기간 (서울)</legend><div className="flex min-w-0 items-center gap-2"><input aria-label={`${datePrefix}시작일 (서울)`} className={input} type="date" value={value.date_from} onChange={e=>change("date_from",e.target.value)}/><span aria-hidden="true" className="text-slate-400">~</span><input aria-label={`${datePrefix}종료일 (서울)`} className={input} type="date" value={value.date_to} onChange={e=>change("date_to",e.target.value)}/></div></fieldset>:<span className="hidden xl:block"/>}
   <button type="button" className={`${control} h-11 whitespace-nowrap px-4 font-semibold`} aria-expanded={open} aria-controls="filter-details" onClick={()=>setOpen(!open)}>상세 필터{detailCount?` ${detailCount}`:""} {open?"▴":"▾"}</button>
   <button className="primary-action h-11 whitespace-nowrap px-5">검색 적용</button>
  </div>
  {open&&<div id="filter-details" className="grid min-w-0 grid-cols-1 items-start gap-3 border-t border-slate-100 pt-3 md:grid-cols-2 xl:grid-cols-4">
   <label className={field}><span className={caption}>로케이션 필터</span><select className={input} value={value.location_id} onChange={e=>change("location_id",e.target.value)}><option value="">전체 로케이션</option>{locations.filter(l=>!value.warehouse_id||l.warehouse_id===value.warehouse_id).map(l=><option key={l.id} value={l.id}>{l.code} · {l.name}</option>)}</select></label>
   {typed&&<label className={field}><span className={caption}>유형 필터</span><select className={input} value={value.kind} onChange={e=>change("kind",e.target.value)}><option value="">전체 유형</option><option value="INBOUND">입고</option><option value="OUTBOUND">출고</option><option value="TRANSFER">이동</option></select></label>}
   {typed&&<label className={field}><span className={caption}>상태 필터</span><select className={input} value={value.status} onChange={e=>change("status",e.target.value)}><option value="">전체 상태</option>{!history&&<><option value="DRAFT">초안</option><option value="CANCELLED">취소됨</option></>}<option value="POSTED">확정됨</option><option value="REVERSED">확정 취소됨</option></select></label>}
   {documents&&<label className={field}><span className={caption}>날짜 기준</span><select className={input} value={value.date_field} onChange={e=>change("date_field",e.target.value)}><option value="">작성 시각 (기본)</option><option value="created_at">작성 시각</option><option value="posted_at">확정 시각</option><option value="reversed_at">확정 취소 시각</option></select></label>}
   <div className="min-w-0 md:col-span-2"><ItemPicker label="품목 필터" value={value.item_id} onChange={id=>change("item_id",id)} activeOnly={false}/></div>
   {documents&&<label className="flex h-11 items-center gap-2 self-end text-sm"><input type="checkbox" className="h-5 w-5" checked={value.originals_only==="true"} onChange={e=>change("originals_only",e.target.checked?"true":"")}/>자동 생성된 취소 전표 제외</label>}
  </div>}
  {chips.length>0&&<div className="flex min-w-0 flex-wrap items-center gap-2"><span className="text-xs font-semibold text-slate-600">선택한 조건</span>{chips.map(([name,text,keys])=><span key={name} className="inline-flex h-7 max-w-full items-center gap-1 rounded-full bg-blue-50 pl-3 pr-1 text-xs font-semibold text-blue-800"><span className="truncate">{name}: {text}</span><button type="button" aria-label={`${name} 조건 지우기`} className="grid h-6 w-6 place-items-center rounded-full hover:bg-blue-100" onClick={()=>setValue({...value,...Object.fromEntries(keys.map(key=>[key,""]))})}>×</button></span>)}<button type="button" className="h-7 px-2 text-xs font-semibold text-blue-800 hover:underline" onClick={()=>setValue({...emptyFilters})}>필터 초기화</button><span className="text-xs text-slate-500">조건을 바꾼 뒤 검색 적용을 누르세요.</span></div>}
 </form>;
}
