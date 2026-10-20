"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { FilterForm, Pager, emptyFilters, query, seoulTime, type Pagination } from "../list-controls";
import { control, errorText, request, type MasterRow } from "../api-client";

type StockRow = {
  warehouse_id: string;
  warehouse_name: string;
  location_id: string;
  location_code: string;
  item_id: string;
  item_code: string;
  item_name: string;
  quantity: string;
};
type LedgerRow = {
  id: string;
  document_id: string;
  document_number?: string;
  human_kind?: string;
  actor_name?: string;
  warehouse_name: string;
  location_code: string;
  item_code: string;
  item_name: string;
  quantity_delta: string;
  created_at: string;
};
type Reconciliation = {
  consistent: boolean;
  mismatches: {
    location_id: string;
    item_id: string;
    balance_quantity: string;
    ledger_quantity: string;
    location_code?: string;
    item_code?: string;
    item_name?: string;
  }[];
};

export default function Stock({role = "viewer", initialFilters = {}}: {role?: string; initialFilters?: Partial<typeof emptyFilters>}) {
  const initial = {...emptyFilters,...initialFilters};
  const [selection,setSelection]=useState<StockRow|null>(null);
  const listRequest=useRef(0);
  const [filters,setFilters]=useState(initial),[applied,setApplied]=useState(initial),[stockPage,setStockPage]=useState(1),[ledgerPage,setLedgerPage]=useState(1),[stockPagination,setStockPagination]=useState<Pagination|null>(null),[ledgerPagination,setLedgerPagination]=useState<Pagination|null>(null),[lookups,setLookups]=useState<{warehouses:MasterRow[];locations:MasterRow[]}>({warehouses:[],locations:[]});
  const [stock, setStock] = useState<StockRow[]>([]);
  const [entries, setEntries] = useState<LedgerRow[]>([]);
  const [reconciliation, setReconciliation] = useState<Reconciliation | null>(null);
  const [pending, setPending] = useState(true);
  const [error, setError] = useState("");

  async function reload() {
    const generation=++listRequest.current;
    setPending(true);
    setError("");setStock([]);setEntries([]);setReconciliation(null);setStockPagination(null);setLedgerPagination(null);
    try {
      const [balances, ledger, check, lookup] = await Promise.all([
        request<{ stock: StockRow[];pagination:Pagination }>(`/api/stock?${query({...applied,date_from:"",date_to:"",date_field:"",kind:"",status:""},stockPage)}`),
        request<{ entries: LedgerRow[];pagination:Pagination }>(`/api/stock-ledger?${query({...applied,...(selection?{item_id:selection.item_id,location_id:selection.location_id,warehouse_id:selection.warehouse_id,q:""}:{})},ledgerPage)}`),
        request<Reconciliation>("/api/stock/reconcile"),request<{warehouses:MasterRow[];locations:MasterRow[]}>("/api/lookups"),
      ]);
      if(generation!==listRequest.current)return;
      setStock(balances.stock);setStockPagination(balances.pagination);setLedgerPagination(ledger.pagination);setLookups(lookup);
      setEntries(ledger.entries);
      setReconciliation(check);
    } catch (e) {
      if(generation===listRequest.current)setError(errorText(e));
    } finally {
      if(generation===listRequest.current)setPending(false);
    }
  }

  useEffect(() => { void reload(); }, [applied,stockPage,ledgerPage,selection]);

  return <>
    <h1 className="text-3xl font-bold">재고 조회</h1>
    <p className="my-4">로케이션별 현재 수량과 확정된 전표에 따른 수량 변동을 확인하세요. 변동 수량의 +는 증가, −는 감소를 의미합니다.</p>
    <p>원장 날짜·유형·상태 필터는 재고 변동 이력에 적용됩니다. 현재 재고는 현재 수량을 표시합니다.</p>
    <FilterForm ledger history datePrefix="원장 " value={filters} setValue={setFilters} onSubmit={()=>{setStockPage(1);setLedgerPage(1);setApplied({...filters})}} warehouses={lookups.warehouses} locations={lookups.locations}/>
    <button className={control} disabled={pending} onClick={() => void reload()}>재고 새로고침</button>
    {pending && <p role="status" className="my-4">불러오는 중…</p>}
    {error && <p role="alert" className="my-4 text-red-700">{error}</p>}
    <section className="my-6 overflow-x-auto rounded-xl border bg-white p-5">
      <h2 className="mb-4 text-xl font-bold">현재 재고</h2>

      {!pending && !error && stock.length === 0 ? <p>등록된 재고가 없습니다.</p> : <table className="w-full min-w-[680px] text-left text-sm [&_th]:whitespace-nowrap [&_th]:pb-3 [&_th]:pr-4 [&_td]:pr-4">
        <thead><tr><th>창고</th><th>로케이션</th><th>품목 코드</th><th>품목명</th><th>수량</th><th>작업</th></tr></thead>
        <tbody>{stock.map(row => <tr className="border-t" key={`${row.location_id}:${row.item_id}`}>
          <td className="py-3">{row.warehouse_name}</td><td>{row.location_code}</td><td>{row.item_code}</td><td>{row.item_name}</td><td>{row.quantity}</td><td><button className="text-blue-800 underline" onClick={()=>{setSelection(row);setLedgerPage(1)}} aria-label={`${row.item_code} · ${row.location_code} 변동 이력 보기`}>이력 보기</button>{role!=="viewer"&&<Link className="ml-3 text-blue-800 underline" href={`/dashboard/documents?kind=OUTBOUND&item_id=${row.item_id}&warehouse_id=${row.warehouse_id}&location_id=${row.location_id}`}>출고 작성</Link>}</td>
        </tr>)}</tbody>
      </table>}
      <Pager value={stockPagination} onChange={setStockPage} pending={pending}/>
    </section>
    <section className="my-6 overflow-x-auto rounded-xl border bg-white p-5">
      <h2 className="mb-4 text-xl font-bold">재고 변동 이력</h2>
      {selection&&<div className="mb-4 flex flex-wrap items-center gap-3 rounded-lg bg-blue-50 p-3"><p>{selection.item_code} · {selection.item_name} / {selection.warehouse_name} · {selection.location_code} 이력</p><button className="text-blue-800 underline" onClick={()=>{setSelection(null);setLedgerPage(1)}}>이력 선택 해제</button></div>}

      {!pending && !error && entries.length === 0 ? <p>재고 변동 이력이 없습니다.</p> : <table className="w-full min-w-[680px] text-left text-sm [&_th]:whitespace-nowrap [&_th]:pb-3 [&_th]:pr-4 [&_td]:pr-4">
        <thead><tr><th>처리 시각</th><th>전표 번호</th><th>창고</th><th>로케이션</th><th>품목</th><th>변동 수량</th><th>작업</th><th>작업자</th></tr></thead>
        <tbody>{entries.map(row => <tr className="border-t" key={row.id}>
          <td className="py-3">{seoulTime(row.created_at)}</td><td><Link className="text-blue-800 underline" href={`/dashboard/history?id=${row.document_id}`}>{row.document_number || "전표 상세 보기"}</Link></td><td>{row.warehouse_name}</td><td>{row.location_code}</td><td>{row.item_code} · {row.item_name}</td><td>{row.quantity_delta.startsWith("-") || row.quantity_delta === "0" ? row.quantity_delta : `+${row.quantity_delta}`}</td><td>{{INBOUND:"입고",OUTBOUND:"출고",TRANSFER:"이동",REVERSAL:"확정 취소"}[row.human_kind??""]??"재고 변동"}</td><td>{row.actor_name||"작업자 정보 없음"}</td>
        </tr>)}</tbody>
      </table>}
      <Pager value={ledgerPagination} onChange={setLedgerPage} pending={pending}/>
    </section>
    <section className="rounded-xl border bg-white p-5">
      <h2 className="mb-4 text-xl font-bold">재고 일치 확인</h2>
      {reconciliation && (reconciliation.consistent ? <p>현재 재고와 변동 이력의 수량이 일치합니다.</p> : <>
        <p role="alert" className="text-red-700">현재 재고와 변동 이력의 수량이 일치하지 않습니다. 관리자에게 확인을 요청하세요.</p>
        <ul className="mt-3">{reconciliation.mismatches.map(row => <li key={`${row.location_id}:${row.item_id}`}>
          로케이션 {row.location_code || lookups.locations.find(l=>l.id===row.location_id)?.code || "정보 없음"} · 품목 {row.item_code || stock.find(i=>i.item_id===row.item_id)?.item_code || "정보 없음"}{row.item_name ? ` · ${row.item_name}` : ""}: 현재 수량 {row.balance_quantity}, 변동 이력 합계 {row.ledger_quantity}
        </li>)}</ul>
      </>)}
    </section>
  </>;
}
