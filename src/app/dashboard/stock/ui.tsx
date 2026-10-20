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
  }[];
};

export default function Stock() {
  const listRequest=useRef(0);
  const [filters,setFilters]=useState(emptyFilters),[applied,setApplied]=useState(emptyFilters),[stockPage,setStockPage]=useState(1),[ledgerPage,setLedgerPage]=useState(1),[stockPagination,setStockPagination]=useState<Pagination|null>(null),[ledgerPagination,setLedgerPagination]=useState<Pagination|null>(null),[lookups,setLookups]=useState<{warehouses:MasterRow[];locations:MasterRow[]}>({warehouses:[],locations:[]});
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
        request<{ entries: LedgerRow[];pagination:Pagination }>(`/api/stock-ledger?${query(applied,ledgerPage)}`),
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

  useEffect(() => { void reload(); }, [applied,stockPage,ledgerPage]);

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

      {!pending && !error && stock.length === 0 ? <p>등록된 재고가 없습니다.</p> : <table className="w-full text-left">
        <thead><tr><th>창고</th><th>로케이션</th><th>품목 코드</th><th>품목명</th><th>수량</th></tr></thead>
        <tbody>{stock.map(row => <tr className="border-t" key={`${row.location_id}:${row.item_id}`}>
          <td className="py-3">{row.warehouse_name}</td><td>{row.location_code}</td><td>{row.item_code}</td><td>{row.item_name}</td><td>{row.quantity}</td>
        </tr>)}</tbody>
      </table>}
      <Pager value={stockPagination} onChange={setStockPage} pending={pending}/>
    </section>
    <section className="my-6 overflow-x-auto rounded-xl border bg-white p-5">
      <h2 className="mb-4 text-xl font-bold">재고 변동 이력</h2>

      {!pending && !error && entries.length === 0 ? <p>재고 변동 이력이 없습니다.</p> : <table className="w-full text-left">
        <thead><tr><th>처리 시각</th><th>전표 ID</th><th>창고</th><th>로케이션</th><th>품목</th><th>변동 수량</th></tr></thead>
        <tbody>{entries.map(row => <tr className="border-t" key={row.id}>
          <td className="py-3">{seoulTime(row.created_at)}</td><td><Link className="text-blue-800 underline" href={`/dashboard/history?id=${row.document_id}`}>{row.document_id}</Link></td><td>{row.warehouse_name}</td><td>{row.location_code}</td><td>{row.item_code} · {row.item_name}</td><td>{row.quantity_delta.startsWith("-") || row.quantity_delta === "0" ? row.quantity_delta : `+${row.quantity_delta}`}</td>
        </tr>)}</tbody>
      </table>}
      <Pager value={ledgerPagination} onChange={setLedgerPage} pending={pending}/>
    </section>
    <section className="rounded-xl border bg-white p-5">
      <h2 className="mb-4 text-xl font-bold">재고 일치 확인</h2>
      {reconciliation && (reconciliation.consistent ? <p>현재 재고와 변동 이력의 수량이 일치합니다.</p> : <>
        <p role="alert" className="text-red-700">현재 재고와 변동 이력의 수량이 일치하지 않습니다. 관리자에게 확인을 요청하세요.</p>
        <ul className="mt-3">{reconciliation.mismatches.map(row => <li key={`${row.location_id}:${row.item_id}`}>
          로케이션 {row.location_id} · 품목 {row.item_id}: 현재 수량 {row.balance_quantity}, 변동 이력 합계 {row.ledger_quantity}
        </li>)}</ul>
      </>)}
    </section>
  </>;
}
