"use client";

import { useEffect, useId, useRef, useState } from "react";
import { control, errorText, request } from "../api-client";

export type ItemOption = { id: string; code: string; name: string; active: boolean; min_stock?: string | number | null };
type Options = { items: ItemOption[]; pagination: { total: number; total_pages: number } };
export type ItemPickerProps = { value: string; onChange: (id: string, item?: ItemOption) => void; label: string; disabled?: boolean; activeOnly?: boolean; required?: boolean };

export function ItemPicker({ value, onChange, label, disabled = false, activeOnly = false, required = false }: ItemPickerProps) {
  const id = useId();
  const generation = useRef(0);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<ItemOption[]>([]);
  const [selected, setSelected] = useState<ItemOption | null>(null);
  const [pages, setPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [hydrating, setHydrating] = useState(false);
  useEffect(() => {
    let current = true;
    setSelected(null);
    if (!value) { setHydrating(false); return; }
    setHydrating(true);
    request<Options>(`/api/item-options?id=${encodeURIComponent(value)}&page=1&page_size=25&active_only=false`)
      .then(result => { if (current) setSelected(result.items.find(item => item.id === value) ?? null); })
      .catch(() => { if (current) setSelected(null); })
      .finally(() => { if (current) setHydrating(false); });
    return () => { current = false; };
  }, [value]);
  useEffect(() => {
    const current = ++generation.current;
    setLoading(true); setError(""); setItems([]);
    const timer = setTimeout(() => {
      const params = new URLSearchParams({ q: search, page: String(page), page_size: "25", active_only: String(activeOnly) });
      request<Options>(`/api/item-options?${params}`).then(result => {
        if (current !== generation.current) return;
        setItems(result.items); setPages(result.pagination.total_pages); setTotal(result.pagination.total);
      }).catch(e => { if (current === generation.current) setError(errorText(e)); })
        .finally(() => { if (current === generation.current) setLoading(false); });
    }, 200);
    return () => { clearTimeout(timer); generation.current++; };
  }, [search, page, activeOnly]);
  return <fieldset disabled={disabled} className="min-w-0 w-full max-w-full rounded-lg border border-slate-200 bg-slate-50 p-3">
    <legend className="px-1 font-medium">{label}{required ? " (필수)" : ""}</legend>
    <label htmlFor={`${id}-search`} className="text-sm text-slate-600">코드 또는 품목명 검색</label>
    <input id={`${id}-search`} aria-label={`${label} 검색`} className={`${control} mt-1 block w-full`} value={search} onChange={e => { setSearch(e.target.value); setPage(1); }} placeholder="품목 코드·이름 입력" />
    {value && <div className="my-2 flex items-center justify-between gap-2 text-sm"><span className="min-w-0 break-words">{hydrating ? "선택 품목 확인 중…" : selected ? `${selected.code} · ${selected.name}${selected.active ? "" : " (비활성)"}` : "선택한 품목을 현재 조회할 수 없습니다."}</span><button type="button" className="shrink-0 text-blue-800 underline" aria-label={`${label} 선택 해제`} onClick={() => onChange("")}>선택 해제</button></div>}
    <label htmlFor={`${id}-options`} className="sr-only">{label} 검색 결과</label>
    <select id={`${id}-options`} className={`${control} mt-2 block w-full`} required={required} value={value} disabled={disabled || loading} onChange={e => { const item = items.find(option => option.id === e.target.value); onChange(e.target.value, item); }}>
      <option value="">{loading ? "품목 불러오는 중…" : "품목 선택"}</option>
      {value && !items.some(item => item.id === value) && <option value={value}>{selected ? `${selected.code} · ${selected.name}${selected.active ? "" : " (비활성)"}` : "선택한 품목 (조회 불가)"}</option>}
      {items.map(item => <option key={item.id} value={item.id}>{item.code} · {item.name}{item.active ? "" : " (비활성)"}</option>)}
    </select>
    {loading ? <p role="status" className="mt-2 text-xs">검색 중…</p> : error ? <p role="alert" className="mt-2 text-sm text-red-700">{error}</p> : <div className="mt-2 flex flex-wrap items-center gap-2 text-xs"><span>{total === 0 ? "검색 결과가 없습니다." : `총 ${total}개 · ${page}/${Math.max(1, pages)} 페이지`}</span><button type="button" className="text-blue-800 underline disabled:text-slate-400" aria-label={`${label} 이전 결과`} disabled={page <= 1} onClick={() => setPage(page - 1)}>이전</button><button type="button" className="text-blue-800 underline disabled:text-slate-400" aria-label={`${label} 다음 결과`} disabled={page >= pages} onClick={() => setPage(page + 1)}>다음</button></div>}
  </fieldset>;
}
export default ItemPicker;
