"use client";
import { useEffect, useRef, useState } from "react";
import { request, errorText, control, type MasterRow, RequestError } from "../api-client";
import { FilterForm, Pager, emptyFilters, query, seoulTime, type Pagination } from "../list-controls";
type Kind="INBOUND"|"OUTBOUND"|"TRANSFER";
type Line={item_id:string;quantity:number;item_code?:string;item_name?:string};
type Doc={id:string;kind:Kind;status:string;warehouse_id:string;source_location_id:string|null;destination_location_id:string|null;version:number;note:string|null;lines:Line[];created_at:string;updated_at:string;posted_at?:string|null;reversed_at?:string|null;reversal_of_id?:string|null;reversal_document_id?:string|null};
type PostOperation = { documentId: string; version: number; key: string };
// Keep the original key so pending inbound confirmations survive this UI upgrade.
const operationStorageKey = (id: string) => `wms:inbound-post:${id}`;
const reverseStorageKey = (id: string) => `wms:document-reverse:${id}`;
const statusLabel = (status: string, kind: Kind) => status === "DRAFT" ? "초안" : status === "CANCELLED" ? "취소됨" : status === "REVERSED" ? "확정 취소됨" : status === "POSTED" ? `${kinds[kind]} 확정됨` : status;
const kinds={INBOUND:"입고",OUTBOUND:"출고",TRANSFER:"이동"};
export default function Documents({role,history=false}:{role:string;history?:boolean}){
 const listRequest=useRef(0);
 const [filters,setFilters]=useState(emptyFilters),[applied,setApplied]=useState(emptyFilters),[page,setPage]=useState(1),[pagination,setPagination]=useState<Pagination|null>(null),[confirmation,setConfirmation]=useState<"post"|"reverse"|null>(null);
 const [docs,setDocs]=useState<Doc[]>([]),[items,setItems]=useState<MasterRow[]>([]),[warehouses,setWarehouses]=useState<MasterRow[]>([]),[locations,setLocations]=useState<MasterRow[]>([]);
 const [selected,setSelected]=useState<Doc|null>(null),[editing,setEditing]=useState(false),[kind,setKind]=useState<Kind>("INBOUND"),[warehouse,setWarehouse]=useState(""),[source,setSource]=useState(""),[destination,setDestination]=useState(""),[note,setNote]=useState(""),[lines,setLines]=useState<Line[]>([{item_id:"",quantity:1}]);
 const [stockSnapshot,setStockSnapshot]=useState<{scope:string;quantities:Record<string,string>;error:string;loading:boolean}>({scope:"",quantities:{},error:"",loading:false});
 const [stockRefresh,setStockRefresh]=useState(0);
 const stockItemIds=[...new Set(lines.map(line=>line.item_id).filter(Boolean))].sort().join(",");
 const stockScope=`${source}:${stockItemIds}`;
 useEffect(()=>{
  if((kind!=="OUTBOUND"&&kind!=="TRANSFER")||!source||!stockItemIds||(selected?.status && selected.status!=="DRAFT"))return;
  let active=true;
  setStockSnapshot({scope:stockScope,quantities:{},error:"",loading:true});
  Promise.all(stockItemIds.split(",").slice(0,20).map(async itemId=>{
   const data=await request<{stock:{location_id:string;item_id:string;quantity:string}[]}>(`/api/stock?location_id=${encodeURIComponent(source)}&item_id=${encodeURIComponent(itemId)}`);
   return [itemId,data.stock.find(row=>row.location_id===source&&row.item_id===itemId)?.quantity ?? "0"] as const;
  })).then(rows=>{if(active)setStockSnapshot({scope:stockScope,quantities:Object.fromEntries(rows),error:"",loading:false});}).catch(e=>{if(active)setStockSnapshot({scope:stockScope,quantities:{},error:errorText(e),loading:false});});
  return ()=>{active=false;};
 },[kind,source,stockItemIds,stockScope,stockRefresh,selected?.status]);
 const [reverseOperation,setReverseOperation]=useState<PostOperation|null>(null);
 const [postOperation, setPostOperation] = useState<PostOperation | null>(null);
 const [pending,setPending]=useState(false),[error,setError]=useState(""),[notice,setNotice]=useState(""),[conflict,setConflict]=useState(false),[loaded,setLoaded]=useState(false);
 async function reload(){const generation=++listRequest.current;setLoaded(false);setDocs([]);setPagination(null);try{const [d,lookups]=await Promise.all([request<{documents:Doc[];pagination:Pagination}>(`/api/documents?${query(applied,page,history?{view:"history"}:{})}`),request<{items?:MasterRow[];warehouses:MasterRow[];locations:MasterRow[]}>("/api/lookups")]);if(generation!==listRequest.current)return;setDocs(d.documents);setPagination(d.pagination);setWarehouses(lookups.warehouses);setLocations(lookups.locations);if(!history){const i=await request<{items:MasterRow[]}>("/api/items");if(generation!==listRequest.current)return;setItems(i.items)}else if(lookups.items)setItems(lookups.items);setLoaded(true);}catch(e){if(generation!==listRequest.current)return;setDocs([]);setPagination(null);setLoaded(true);setError(errorText(e));}}
 useEffect(()=>{setError("");void reload();},[applied,page,history]);
 useEffect(()=>{if(history){const id=new URLSearchParams(window.location.search).get("id");if(id)void open(id)}},[history]);
 function populate(d:Doc|null){
  if(history&&d)setItems(d.lines.map(l=>({id:l.item_id,code:l.item_code??l.item_id,name:l.item_name??l.item_id,active:true})));
  let operation: PostOperation | null = null;
  if (d) {
   const stored = sessionStorage.getItem(operationStorageKey(d.id));
   if (stored && d.status === "DRAFT") {
    try {
     const parsed = JSON.parse(stored) as PostOperation;
     if (parsed.documentId === d.id && typeof parsed.version === "number" && typeof parsed.key === "string") operation = parsed;
    } catch { /* Ignore an invalid local record. */ }
   } else if (stored) sessionStorage.removeItem(operationStorageKey(d.id));
  }
  let reverse: PostOperation | null = null;
  if(d){
   const stored=sessionStorage.getItem(reverseStorageKey(d.id));
   if(stored&&d.status==="POSTED"&&!d.reversal_of_id){
    try{const parsed=JSON.parse(stored) as PostOperation;if(parsed.documentId===d.id&&typeof parsed.version==="number"&&typeof parsed.key==="string")reverse=parsed;}catch{/* Ignore invalid local records. */}
   }else if(stored)sessionStorage.removeItem(reverseStorageKey(d.id));
  }
  setReverseOperation(reverse);
  setPostOperation(operation);
setSelected(d);setKind(d?.kind||"INBOUND");setWarehouse(d?.warehouse_id||"");setSource(d?.source_location_id||"");setDestination(d?.destination_location_id||"");setNote(d?.note||"");setLines(d?.lines.map(l=>({item_id:l.item_id,quantity:Number(l.quantity)}))||[{item_id:"",quantity:1}]);setEditing(true);setConflict(false);setError("");setNotice("");}
 async function open(id:string){setPending(true);setError("");try{const r=await request<{document:Doc}>(`/api/documents/${id}${history?"?view=history":""}`);populate(r.document);}catch(e){setError(errorText(e));}finally{setPending(false);}}
 function fail(e:unknown){if(e instanceof RequestError&&e.code==="INSUFFICIENT_STOCK"){setError("재고가 부족합니다. 출발 로케이션의 재고와 출고 수량을 확인한 후 전표를 수정·저장하세요.");return;}setError(errorText(e));if(e instanceof RequestError&&e.status===409){setConflict(true);if(e.code === "CONFLICT" || e.code === "VERSION_CONFLICT")setError("다른 사용자가 전표를 변경했거나 현재 상태에서 처리할 수 없습니다. 최신 전표를 다시 불러오세요.");}}
 async function save(){if(new Set(lines.map(l=>l.item_id)).size!==lines.length){setError("같은 품목은 한 번만 추가할 수 있습니다.");return;}if(kind==="TRANSFER"&&source===destination){setError("출발 로케이션과 도착 로케이션은 달라야 합니다.");return;}setPending(true);setError("");setNotice("");try{const body={kind,warehouse_id:warehouse,...(kind!=="INBOUND"?{source_location_id:source}:{}),...(kind!=="OUTBOUND"?{destination_location_id:destination}:{}),note,lines,...(selected?{version:selected.version}:{})};const r=await request<{document:Doc}>(`/api/documents${selected?`/${selected.id}`:""}`,selected?"PATCH":"POST",body);populate(r.document);await reload();setNotice("전표를 저장했습니다.");}catch(e){fail(e);}finally{setPending(false);}}
 async function cancel(){if(!selected)return;setPending(true);setError("");try{const r=await request<{document:Doc}>(`/api/documents/${selected.id}/cancel`,"POST",{version:selected.version});populate(r.document);await reload();setNotice("전표를 취소했습니다.");}catch(e){fail(e);}finally{setPending(false);}}
 async function postDocument() {
  if (!selected || selected.status !== "DRAFT" || (!postOperation && dirty)) return;
  setPending(true);
  setError("");
  setNotice("");
  let operation = postOperation;
  try {
   if (!operation) {
    operation = { documentId: selected.id, version: selected.version, key: crypto.randomUUID() };
    // Persist before sending so a lost response or page reload cannot create a second operation.
    sessionStorage.setItem(operationStorageKey(selected.id), JSON.stringify(operation));
    setPostOperation(operation);
   }
   const response = await fetch(`/api/documents/${operation.documentId}/post`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", "Idempotency-Key": operation.key },
    body: JSON.stringify({ version: operation.version }),
   });
   const data = await response.json();
   if (!response.ok) throw new RequestError(response.status, typeof data.error === "string" ? data.error : data.error?.code || "UNKNOWN");
   sessionStorage.removeItem(operationStorageKey(selected.id));
   setPostOperation(null);
   // The posting response is a summary; fetch the full document for its read-only detail.
   setSelected({ ...selected, ...data.document });
   const detail = await request<{ document: Doc }>(`/api/documents/${selected.id}`);
   populate(detail.document);
   await reload();
   setNotice(`${kinds[selected.kind]}를 확정했습니다. 재고에 반영되었습니다.`);
  } catch (e) {
   if (e instanceof RequestError && e.status < 500 && e.code !== "RETRYABLE_TRANSACTION") {
    sessionStorage.removeItem(operationStorageKey(selected.id));
    setPostOperation(null);
    fail(e);
   } else {
    setError(`${errorText(e)} 처리 결과를 확인하지 못했다면 같은 요청으로 다시 시도하세요. 확인 전에는 전표를 수정할 수 없습니다.`);
   }
  } finally {
   setPending(false);
  }
 }
 async function reverseDocument(){
  if(!selected||role!=="admin"||selected.status!=="POSTED"||selected.reversal_of_id)return;
  setPending(true);setError("");setNotice("");
  let operation=reverseOperation;
  try{
   if(!operation){
    operation={documentId:selected.id,version:selected.version,key:crypto.randomUUID()};
    sessionStorage.setItem(reverseStorageKey(selected.id),JSON.stringify(operation));
    setReverseOperation(operation);
   }
   const response=await fetch(`/api/documents/${operation.documentId}/reverse`,{method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json","Idempotency-Key":operation.key},body:JSON.stringify({version:operation.version})});
   const data=await response.json();
   if(!response.ok)throw new RequestError(response.status,typeof data.error==="string"?data.error:data.error?.code||"UNKNOWN");
   sessionStorage.removeItem(reverseStorageKey(selected.id));setReverseOperation(null);
   setSelected({...selected,...data.document,reversal_document_id:data.reversal.id});
   const detail=await request<{document:Doc}>(`/api/documents/${selected.id}`);
   populate(detail.document);await reload();setNotice("확정을 취소했습니다. 반대 전표가 생성되어 재고에 반영되었습니다.");
  }catch(e){
   if(e instanceof RequestError&&e.status<500&&e.code!=="RETRYABLE_TRANSACTION"){
    sessionStorage.removeItem(reverseStorageKey(selected.id));setReverseOperation(null);
    if(e.code==="INSUFFICIENT_STOCK")setError("취소에 필요한 재고가 부족합니다. 재고를 확인한 후 다시 시도하세요.");else fail(e);
   }else setError(`${errorText(e)} 처리 결과를 확인하지 못했다면 같은 요청으로 다시 시도하세요.`);
  }finally{setPending(false);}
 }
 const dirty = !!selected && (
  kind !== selected.kind || warehouse !== selected.warehouse_id ||
  source !== (selected.source_location_id || "") ||
  destination !== (selected.destination_location_id || "") ||
  note !== (selected.note || "") ||
  lines.length !== selected.lines.length ||
  lines.some((line, index) => line.item_id !== selected.lines[index]?.item_id ||
   line.quantity !== Number(selected.lines[index]?.quantity))
 );
 const readonly=history||!!selected&&selected.status!=="DRAFT";const disabled=pending||readonly||conflict||!!postOperation||!!reverseOperation;
 function options(rows:MasterRow[],value:string){return rows.filter(r=>r.active||r.id===value).map(r=><option key={r.id} value={r.id} disabled={!r.active}>{r.code} · {r.name}{!r.active?" (비활성)":""}</option>);}
 function locationSelect(label:string,value:string,set:(v:string)=>void){return <label>{label}<select className={`${control} block w-full`} required value={value} onChange={e=>set(e.target.value)} disabled={disabled}><option value="">선택하세요</option>{options(locations.filter(l=>l.warehouse_id===warehouse),value)}</select></label>;}
 return <>{confirmation&&selected&&<div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"><section role="dialog" aria-modal="true" aria-labelledby="confirm-title" className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-xl bg-white p-6"><h2 id="confirm-title" className="text-xl font-bold">{confirmation==="post"?" 전표 확정 확인":"확정 취소 확인"}</h2><p className="my-3">저장된 {kinds[selected.kind]} 전표 · {selected.id}</p><p>창고: {warehouses.find(w=>w.id===selected.warehouse_id)?.name??selected.warehouse_id}</p><p>출발: {locations.find(l=>l.id===selected.source_location_id)?.code??"없음"} · 도착: {locations.find(l=>l.id===selected.destination_location_id)?.code??"없음"}</p><ul className="my-4">{selected.lines.map(l=><li key={l.item_id}>{items.find(i=>i.id===l.item_id)?.name??l.item_id} · 수량 {l.quantity}</li>)}</ul><p>{confirmation==="post"?"이 수량을 재고에 반영합니다.":"반대 전표를 생성하여 확정을 취소합니다."}</p><div className="mt-4 flex gap-3"><button autoFocus className={control} onClick={()=>setConfirmation(null)}>돌아가기</button><button className={control} onClick={()=>{const action=confirmation;setConfirmation(null);void(action==="post"?postDocument():reverseDocument())}}>{confirmation==="post"?"확정 실행":"취소 실행"}</button></div></section></div>}<h1 className="text-3xl font-bold">{history?"확정 이력":"입출고 전표"}</h1><p className="my-4">{history?"확정 및 확정 취소된 전표를 조회합니다. 처리 시각은 서울 기준입니다.":"초안 전표를 작성·수정·취소하고 입고·출고·이동을 확정하여 재고에 반영할 수 있습니다. 관리자는 확정 취소로 반대 전표를 생성할 수 있습니다."}</p><div className="flex gap-3">{!history&&<button className={control} disabled={pending} onClick={()=>populate(null)}>새 전표</button>}<button className={control} disabled={pending} onClick={()=>{setError("");reload().catch(e=>setError(errorText(e)));}}>목록 새로고침</button></div>{error&&<p role="alert" className="my-4 text-red-700">{error}</p>}{notice&&<p role="status" className="my-4 text-green-800">{notice}</p>}{conflict&&selected&&<button className={control} disabled={pending} onClick={()=>void open(selected.id)}>최신 전표 다시 불러오기</button>}
 <FilterForm value={filters} setValue={setFilters} onSubmit={()=>{setError("");setPage(1);setApplied({...filters})}} warehouses={warehouses} locations={locations} documents history={history}/><section className="my-6 overflow-x-auto rounded-xl border bg-white p-5"><h2 className="mb-4 text-xl font-bold">전표 목록</h2>{!loaded?<p role="status">불러오는 중…</p>:error?null:docs.length===0?<p>등록된 전표가 없습니다.</p>:<table className="w-full text-left"><thead><tr><th className="p-2">전표 ID</th><th>유형</th><th>창고</th><th>상태</th><th>열기</th></tr></thead><tbody>{docs.map(d=><tr key={d.id} className="border-t"><td className="p-2">{d.id}</td><td>{kinds[d.kind]}</td><td>{warehouses.find(w=>w.id===d.warehouse_id)?.name||d.warehouse_id}</td><td>{statusLabel(d.status,d.kind)}</td><td><button className={control} disabled={pending} onClick={()=>void open(d.id)} aria-label={`전표 ${d.id} 열기`}>열기</button></td></tr>)}</tbody></table>}<Pager value={pagination} onChange={setPage} pending={!loaded}/></section>
 {editing&&<section className="min-w-0 max-w-full rounded-xl border bg-white p-5 [overflow-wrap:anywhere]"><h2 className="mb-4 text-xl font-bold">{selected?"전표 상세 / 수정":"새 전표 작성"}</h2>{selected&&<p className="mb-4">전표 ID: {selected.id} · 버전: {selected.version} · {readonly?`${statusLabel(selected.status,selected.kind)} · 읽기 전용`:"초안"}</p>}{selected&&<div className="mb-4 space-y-2">{selected.posted_at&&<p>확정 시각: {seoulTime(selected.posted_at)}</p>}{selected.reversed_at&&<p>확정 취소 시각: {seoulTime(selected.reversed_at)}</p>}{selected.reversal_of_id&&<p>원본 전표: {selected.reversal_of_id} <button type="button" className={control} disabled={pending} onClick={()=>void open(selected.reversal_of_id!)}>원본 전표 열기</button></p>}{selected.reversal_document_id&&<p>반대 전표: {selected.reversal_document_id} <button type="button" className={control} disabled={pending} onClick={()=>void open(selected.reversal_document_id!)}>반대 전표 열기</button></p>}</div>}{reverseOperation&&<p role="status" className="mb-4 text-amber-800">확정 취소 결과를 확인 중입니다. 같은 요청으로 다시 시도하거나 최신 전표를 다시 불러오세요.</p>}{reverseOperation&&selected&&<button type="button" className={control} disabled={pending} onClick={()=>void open(selected.id)}>확정 취소 상태 다시 불러오기</button>}{dirty && !postOperation && !!selected && !readonly && <p className="mb-4 text-amber-800">변경 내용을 저장한 후 확정하세요.</p>}{postOperation && <p role="status" className="mb-4 text-amber-800">{kinds[selected?.kind || kind]} 확정 결과를 확인 중입니다. 같은 요청으로 다시 시도하거나 최신 전표를 다시 불러오세요. 확인 전에는 수정과 취소가 제한됩니다.</p>}{postOperation && selected && <button type="button" className={control} disabled={pending} onClick={() => void open(selected.id)}>확정 상태 다시 불러오기</button>}<form onSubmit={e=>{e.preventDefault();void save();}}><fieldset disabled={disabled} className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2 [&_label]:min-w-0 [&_label]:max-w-full"><legend className="sr-only">전표 기본정보</legend><label>전표 유형<select className={`${control} block w-full`} value={kind} onChange={e=>setKind(e.target.value as Kind)}>{Object.entries(kinds).map(([v,l])=><option key={v} value={v}>{l}</option>)}</select></label><label>창고<select className={`${control} block w-full`} required value={warehouse} onChange={e=>{setWarehouse(e.target.value);setSource("");setDestination("");}}><option value="">선택하세요</option>{options(warehouses,warehouse)}</select></label>{kind!=="INBOUND"&&locationSelect("출발 로케이션",source,setSource)}{kind!=="OUTBOUND"&&locationSelect("도착 로케이션",destination,setDestination)}<label className="sm:col-span-2">메모<textarea className={`${control} block w-full`} value={note} maxLength={2000} onChange={e=>setNote(e.target.value)}/></label></fieldset><h3 className="my-4 font-bold">품목 명세 (최대 20개)</h3>{(kind==="OUTBOUND"||kind==="TRANSFER")&&!readonly&&<div className="my-4"><p>참고 재고는 출발 로케이션의 조회 시점 수량이며 예약된 재고가 아닙니다. 최종 출고 가능 수량은 확정 시 다시 확인합니다.</p><button type="button" className={control} disabled={!source||!stockItemIds||(stockSnapshot.scope===stockScope&&stockSnapshot.loading)} onClick={()=>setStockRefresh(value=>value+1)}>참고 재고 새로고침</button>{stockSnapshot.scope===stockScope&&stockSnapshot.error&&<p role="alert">참고 재고를 불러오지 못했습니다. {stockSnapshot.error}</p>}</div>}{lines.map((line,index)=><div className="mb-3 flex min-w-0 max-w-full flex-wrap items-end gap-3 [&_label]:min-w-0 [&_label]:max-w-full" key={index}><label>품목 {index+1}<select className={`${control} block w-full`} required value={line.item_id} disabled={disabled} onChange={e=>setLines(lines.map((l,n)=>n===index?{...l,item_id:e.target.value}:l))}><option value="">선택하세요</option>{options(items,line.item_id)}</select></label><label>수량 {index+1}<input className={`${control} block w-40`} required type="number" min={1} max={1000000000} step={1} value={line.quantity} disabled={disabled} onChange={e=>setLines(lines.map((l,n)=>n===index?{...l,quantity:Number(e.target.value)}:l))}/></label>{(kind==="OUTBOUND"||kind==="TRANSFER")&&!readonly&&<p>참고 재고: {!source||!line.item_id?"출발 로케이션과 품목을 선택하세요":stockSnapshot.scope!==stockScope||stockSnapshot.loading?"불러오는 중…":stockSnapshot.error?"확인 불가":stockSnapshot.quantities[line.item_id]??"확인 불가"}</p>}<button hidden={history} type="button" className={control} disabled={disabled||lines.length===1} onClick={()=>setLines(lines.filter((_,n)=>n!==index))} aria-label={`품목 ${index+1} 제거`}>제거</button></div>)}<div className="mt-5 flex flex-wrap gap-3"><button hidden={history} type="button" className={control} disabled={disabled||lines.length>=20} onClick={()=>setLines([...lines,{item_id:"",quantity:1}])}>품목 추가</button>{!readonly&&<button className={control} disabled={disabled}>{pending?"처리 중…":"전표 저장"}</button>}{selected&&!readonly&&<button type="button" className={control} disabled={disabled} onClick={()=>void cancel()}>전표 취소</button>}{!!selected && !readonly && <button type="button" className={control} disabled={pending || (!postOperation && (conflict || dirty))} onClick={() => postOperation?void postDocument():setConfirmation("post")}>{`${kinds[selected.kind]} 확정${postOperation ? " 다시 시도" : ""}`}</button>}{!history&&role==="admin"&&selected?.status==="POSTED"&&!selected.reversal_of_id&&<button type="button" className={control} disabled={pending||(!reverseOperation&&conflict)} onClick={()=>reverseOperation?void reverseDocument():setConfirmation("reverse")}>확정 취소{reverseOperation?" 다시 시도":""}</button>}<button type="button" className={control} disabled={pending} onClick={()=>setEditing(false)}>닫기</button></div></form></section>}</>;
}
