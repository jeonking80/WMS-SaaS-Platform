"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { request, errorText, control, type MasterRow } from "../api-client";
import { Pager, type Pagination } from "../list-controls";

const types = ["items", "warehouses", "locations"] as const;
type Kind = typeof types[number];
const titles = { items: "품목", warehouses: "창고", locations: "보관위치" };
const primary = `${control.replace("bg-white", "bg-blue-700").replace("border-slate-300", "border-blue-700")} font-semibold text-white`;
type Filters = { q: string; active: string; warehouse_id: string };
const emptyFilters: Filters = { q: "", active: "", warehouse_id: "" };

export default function Master({ editable, initialTab = "items" }: { editable: boolean; initialTab?: Kind }) {
 const [tab, setTab] = useState<Kind>(initialTab);
 const [filters, setFilters] = useState(emptyFilters);
 const [applied, setApplied] = useState(emptyFilters);
 const [page, setPage] = useState(1);
 const [revision, setRevision] = useState(0);
 const [rows, setRows] = useState<MasterRow[]>([]);
 const [warehouses, setWarehouses] = useState<MasterRow[]>([]);
 const [warehouseError, setWarehouseError] = useState("");
 const [pagination, setPagination] = useState<Pagination | null>(null);
 const [loading, setLoading] = useState(true);
 const [error, setError] = useState("");
 const [notice, setNotice] = useState("");
 const [editor, setEditor] = useState<{ row?: MasterRow } | null>(null);
 useEffect(() => {
  let current = true;
  request<{ warehouses: MasterRow[] }>("/api/warehouses").then(data => { if (current) { setWarehouses(data.warehouses); setWarehouseError(""); } }).catch(e => { if (current) setWarehouseError(errorText(e)); });
  return () => { current = false; };
 }, [revision]);
 useEffect(() => {
  let current = true;
  setLoading(true); setError("");
  const params = new URLSearchParams({ page: String(page), page_size: "20" });
  if (applied.q) params.set("q", applied.q);
  if (applied.active) params.set("active", applied.active);
  if (tab === "locations" && applied.warehouse_id) params.set("warehouse_id", applied.warehouse_id);
  request<Partial<Record<Kind, MasterRow[]>> & { pagination: Pagination }>(`/api/${tab}?${params}`).then(data => {
   if (current) { setRows(data[tab] ?? []); setPagination(data.pagination); }
  }).catch(e => { if (current) { setError(errorText(e)); setRows([]); setPagination(null); } }).finally(() => { if (current) setLoading(false); });
  return () => { current = false; };
 }, [tab, page, applied, revision]);
 function changeTab(next: Kind) {
  setTab(next); setFilters(emptyFilters); setApplied(emptyFilters); setPage(1); setRows([]); setPagination(null); setNotice("");
  const url = new URL(window.location.href); url.searchParams.set("tab", next); window.history.replaceState(null, "", url);
 }
 const filtered = Boolean(applied.q || applied.active || (tab === "locations" && applied.warehouse_id));
 const canCreate = editable && !loading && !error && (tab !== "locations" || (!warehouseError && warehouses.some(w => w.active)));
 return <div className="space-y-6">
  <div><h1 className="text-3xl font-bold">기준정보 관리</h1><p className="mt-3 text-slate-600">{editable ? "창고 → 보관위치 → 품목 순서로 등록하면 입고를 시작할 수 있습니다." : "품목·창고·보관위치를 조회할 수 있습니다. 수정은 관리자만 가능합니다."}</p><p className="mt-2 text-sm text-slate-500">수량 단위는 개이며 정수로 관리합니다. 비활성 정보도 이력 확인을 위해 조회할 수 있습니다.</p></div>
  <nav aria-label="기준정보 종류" className="flex flex-wrap gap-2 border-b pb-3">{types.map(type => <button key={type} type="button" aria-current={tab === type ? "page" : undefined} className={tab === type ? primary : control} onClick={() => changeTab(type)}>{titles[type]}</button>)}</nav>
  {notice && <p role="status" className="rounded-lg bg-green-50 p-3 text-green-800">{notice}</p>}
  <section aria-labelledby="master-list-title" className="rounded-xl border bg-white p-4 sm:p-6">
   <div className="flex flex-wrap items-center justify-between gap-3"><h2 id="master-list-title" className="text-xl font-bold">{titles[tab]} 목록{pagination && !loading && !error && <span className="ml-2 text-base font-normal text-slate-500">총 {pagination.total.toLocaleString("ko-KR")}건</span>}</h2><div className="flex gap-2"><button className={control} disabled={loading} onClick={() => setRevision(v => v + 1)}>새로고침</button>{editable && <button className={primary} disabled={!canCreate} onClick={() => { setNotice(""); setEditor({}); }}>{titles[tab]} 등록</button>}</div></div>
   <form className="my-5 flex flex-wrap items-end gap-3" onSubmit={e => { e.preventDefault(); setApplied({ ...filters, q: filters.q.trim() }); setPage(1); }}>
    <label className="w-full sm:w-64">검색어<input className={`${control} block w-full`} maxLength={100} value={filters.q} onChange={e => setFilters({ ...filters, q: e.target.value })} placeholder="코드 또는 이름" /></label>
    <label>상태<select className={`${control} block`} value={filters.active} onChange={e => setFilters({ ...filters, active: e.target.value })}><option value="">전체 상태</option><option value="true">활성</option><option value="false">비활성</option></select></label>
    {tab === "locations" && <label className="w-full sm:w-64">창고 필터<select className={`${control} block w-full`} value={filters.warehouse_id} onChange={e => setFilters({ ...filters, warehouse_id: e.target.value })} disabled={Boolean(warehouseError)}><option value="">전체 창고</option>{warehouses.map(w => <option key={w.id} value={w.id}>{w.code} · {w.name}</option>)}</select></label>}
    <button className={control} disabled={loading}>검색 적용</button><button type="button" className={control} disabled={loading} onClick={() => { setFilters(emptyFilters); setApplied(emptyFilters); setPage(1); }}>초기화</button>
   </form>
   {tab === "locations" && warehouseError && <p role="alert" className="mb-3 text-red-700">창고 정보를 불러오지 못했습니다. {warehouseError} 새로고침 후 다시 시도하세요.</p>}
   {loading ? <p role="status" className="py-8">{titles[tab]} 불러오는 중…</p> : error ? <div role="alert" className="rounded-lg bg-red-50 p-4 text-red-800"><p>{error}</p><p className="mt-2">새로고침을 눌러 다시 불러오세요.</p></div> : rows.length ? <div className="max-w-full overflow-x-auto"><table className="w-full text-left text-sm"><caption className="sr-only">{titles[tab]} 조회 결과</caption><thead className="border-b bg-slate-50"><tr><th scope="col" className="p-3">코드</th><th scope="col" className="p-3">이름</th>{tab === "items" && <th scope="col" className="p-3">최소 재고</th>}{tab === "locations" && <th scope="col" className="p-3">소속 창고</th>}<th scope="col" className="p-3">상태</th>{editable && <th scope="col" className="p-3">관리</th>}</tr></thead><tbody>{rows.map(row => <tr key={row.id} className="border-b"><td className="break-all p-3 font-medium">{row.code}</td><td className="break-all p-3">{row.name}</td>{tab === "items" && <td className="whitespace-nowrap p-3">{Number(row.min_stock ?? 0).toLocaleString("ko-KR")}개</td>}{tab === "locations" && <td className="p-3">{warehouses.find(w => w.id === row.warehouse_id)?.name ?? "창고 정보 조회 불가"}</td>}<td className="whitespace-nowrap p-3"><span className={`rounded-full px-2 py-1 ${row.active ? "bg-green-50 text-green-800" : "bg-slate-100 text-slate-600"}`}>{row.active ? "활성" : "비활성"}</span></td>{editable && <td className="p-3"><button className={control} aria-label={`${titles[tab]} ${row.code} 수정`} onClick={() => setEditor({ row })}>수정</button></td>}</tr>)}</tbody></table></div> : <div className="rounded-xl bg-slate-50 p-6 text-center"><p className="font-semibold">{filtered ? "검색 조건에 맞는 정보가 없습니다." : `등록된 ${titles[tab]} 정보가 없습니다.`}</p><p className="mt-2 text-sm text-slate-600">{filtered ? "검색어나 상태 필터를 변경해 보세요." : editable ? tab === "locations" && !warehouses.some(w => w.active) ? "먼저 활성 창고를 등록한 뒤 보관위치를 추가하세요." : `첫 ${titles[tab]} 정보를 등록하세요.` : "관리자에게 기준정보 등록을 요청하세요."}</p>{!filtered && editable && (tab === "locations" && !warehouses.some(w => w.active) ? <button className={`${control} mt-4`} onClick={() => changeTab("warehouses")}>창고 관리로 이동</button> : <button className={`${primary} mt-4`} disabled={!canCreate} onClick={() => setEditor({})}>첫 {titles[tab]} 등록</button>)}</div>}
   {!error && <Pager value={pagination} onChange={setPage} pending={loading} />}
  </section>
  <p className="text-sm text-slate-600">기준정보 등록을 마쳤다면 <Link className="font-semibold text-blue-700 underline" href="/dashboard/documents">입출고 전표 작성으로 이동</Link>하세요.</p>
  {editor && <MasterEditor key={`${tab}-${editor.row?.id ?? "new"}`} kind={tab} row={editor.row} warehouses={warehouses} onClose={() => setEditor(null)} onSaved={() => { setEditor(null); setNotice(`${titles[tab]} 정보를 저장했습니다.`); setRevision(v => v + 1); }} />}
 </div>;
}

function MasterEditor({ kind, row, warehouses, onClose, onSaved }: { kind: Kind; row?: MasterRow; warehouses: MasterRow[]; onClose: () => void; onSaved: () => void }) {
 const dialog = useRef<HTMLDialogElement>(null);
 const [pending, setPending] = useState(false);
 const [error, setError] = useState("");
 const [errors, setErrors] = useState<Record<string, string>>({});
 const title = `${titles[kind]} ${row ? "수정" : "등록"}`;
 useEffect(() => { const previous = document.activeElement as HTMLElement | null; const element = dialog.current!; element.showModal(); return () => { element.close(); previous?.focus(); }; }, []);
 async function save(form: HTMLFormElement) {
  const values = new FormData(form);
  const code = String(values.get("code") ?? "").trim().toUpperCase();
  const name = String(values.get("name") ?? "").trim();
  const minStock = String(values.get("min_stock") ?? "");
  const warehouse = String(values.get("warehouse_id") ?? "");
  const next: Record<string, string> = {};
  if (!code || code.length > 64) next.code = "코드를 1~64자로 입력하세요.";
  if (!name || name.length > 128) next.name = "이름을 1~128자로 입력하세요.";
  if (kind === "items" && (!/^\d+$/.test(minStock) || Number(minStock) > 1000000000)) next.min_stock = "최소 재고는 0~1,000,000,000 사이의 정수로 입력하세요.";
  if (kind === "locations" && !row && !warehouses.some(w => w.id === warehouse && w.active)) next.warehouse_id = "활성 창고를 선택하세요.";
  setErrors(next); setError("");
  if (Object.keys(next).length) { form.querySelector<HTMLElement>(`[name="${Object.keys(next)[0]}"]`)?.focus(); return; }
  setPending(true);
  try { await request(`/api/${kind}${row ? `/${row.id}` : ""}`, row ? "PATCH" : "POST", { code, name, ...(kind === "items" ? { min_stock: Number(minStock) } : {}), ...(kind === "locations" && !row ? { warehouse_id: warehouse } : {}), ...(row ? { active: values.get("active") === "on" } : {}) }); onSaved(); }
  catch (e) { setError(errorText(e)); } finally { setPending(false); }
 }
 return <dialog ref={dialog} aria-labelledby="master-editor-title" onCancel={e => { e.preventDefault(); if (!pending) onClose(); }} className="m-auto max-h-[90dvh] w-[calc(100%_-_2rem)] max-w-xl overflow-y-auto rounded-2xl border bg-white p-5 shadow-xl backdrop:bg-slate-900/50">
  <div className="mb-5 flex items-center justify-between gap-3"><h2 id="master-editor-title" className="text-xl font-bold">{title}</h2><button type="button" className={control} disabled={pending} onClick={onClose} aria-label={`${title} 닫기`}>닫기</button></div>
  <form noValidate className="space-y-4" onSubmit={e => { e.preventDefault(); void save(e.currentTarget); }}>
   <p className="text-sm text-slate-600">코드는 저장 시 영문 대문자로 변환됩니다. 필수 항목을 모두 입력하세요.</p>
   <label className="block">{titles[kind]} 코드<input autoFocus name="code" defaultValue={row?.code ?? ""} maxLength={64} required disabled={pending} aria-invalid={Boolean(errors.code)} aria-describedby={errors.code ? "master-code-error" : undefined} className={`${control} mt-1 block w-full`} />{errors.code && <span id="master-code-error" className="text-sm text-red-700">{errors.code}</span>}</label>
   <label className="block">{titles[kind]} 이름<input name="name" defaultValue={row?.name ?? ""} maxLength={128} required disabled={pending} aria-invalid={Boolean(errors.name)} aria-describedby={errors.name ? "master-name-error" : undefined} className={`${control} mt-1 block w-full`} />{errors.name && <span id="master-name-error" className="text-sm text-red-700">{errors.name}</span>}</label>
   {kind === "items" && <label className="block">최소 재고 (개)<input name="min_stock" type="number" min={0} max={1000000000} step={1} defaultValue={row?.min_stock ?? 0} required disabled={pending} aria-invalid={Boolean(errors.min_stock)} aria-describedby={errors.min_stock ? "master-stock-error" : undefined} className={`${control} mt-1 block w-full`} />{errors.min_stock && <span id="master-stock-error" className="text-sm text-red-700">{errors.min_stock}</span>}</label>}
   {kind === "locations" && (row ? <p className="text-sm text-slate-600">소속 창고: {warehouses.find(w => w.id === row.warehouse_id)?.name ?? "창고 정보 조회 불가"} (변경 불가)</p> : <label className="block">소속 창고<select name="warehouse_id" required disabled={pending} aria-invalid={Boolean(errors.warehouse_id)} aria-describedby={errors.warehouse_id ? "master-warehouse-error" : undefined} className={`${control} mt-1 block w-full`} defaultValue=""><option value="">선택하세요</option>{warehouses.filter(w => w.active).map(w => <option key={w.id} value={w.id}>{w.code} · {w.name}</option>)}</select>{errors.warehouse_id && <span id="master-warehouse-error" className="text-sm text-red-700">{errors.warehouse_id}</span>}</label>)}
   {row && <label className="flex items-center gap-2"><input name="active" type="checkbox" defaultChecked={row.active} disabled={pending} />활성</label>}
   {error && <p role="alert" className="rounded-lg bg-red-50 p-3 text-red-800">{error}</p>}
   <div className="flex justify-end gap-2 border-t pt-4"><button type="button" className={control} disabled={pending} onClick={onClose}>취소</button><button className={primary} disabled={pending}>{pending ? "저장 중…" : "저장"}</button></div>
  </form>
 </dialog>;
}
