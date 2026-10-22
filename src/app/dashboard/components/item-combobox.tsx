"use client";

import { useEffect, useId, useRef, useState } from "react";
import { control, errorText, request } from "../api-client";
import type { ItemOption } from "./item-picker";

type Options = { items: ItemOption[]; pagination: { total: number } };
const text = (item: ItemOption) => `${item.code} · ${item.name}${item.active ? "" : " (비활성)"}`;

// One-line item filter: type to narrow, pick from the list below. The document forms keep the larger ItemPicker.
export function ItemCombobox({ label, value, onChange, inputClassName = "" }: { label: string; value: string; onChange: (id: string, label: string) => void; inputClassName?: string }) {
  const id = useId();
  const generation = useRef(0);
  const [selected, setSelected] = useState("");
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState(false);
  const [items, setItems] = useState<ItemOption[]>([]);
  const [total, setTotal] = useState(0);
  const [active, setActive] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let current = true;
    if (!value) { setSelected(""); return; }
    request<Options>(`/api/item-options?id=${encodeURIComponent(value)}&page=1&page_size=1&active_only=false`)
      .then(result => { const item = result.items.find(row => row.id === value); if (current) { const name = item ? text(item) : "선택한 품목"; setSelected(name); onChange(value, name); } })
      .catch(() => { if (current) setSelected("선택한 품목"); });
    return () => { current = false; };
    // Only the chosen id decides the label; onChange identity changes on every parent render.
  }, [value]);
  useEffect(() => {
    if (!editing) return;
    const current = ++generation.current;
    setLoading(true); setError("");
    const timer = setTimeout(() => {
      const params = new URLSearchParams({ q: query, page: "1", page_size: "10", active_only: "false" });
      request<Options>(`/api/item-options?${params}`)
        .then(result => { if (current === generation.current) { setItems(result.items); setTotal(result.pagination.total); setActive(0); } })
        .catch(e => { if (current === generation.current) setError(errorText(e)); })
        .finally(() => { if (current === generation.current) setLoading(false); });
    }, 200);
    return () => clearTimeout(timer);
  }, [query, editing]);
  function choose(item: ItemOption) { const name = text(item); setSelected(name); setEditing(false); onChange(item.id, name); }
  const open = editing;
  return <div className="relative min-w-0">
    <input id={id} role="combobox" aria-label={label} aria-expanded={open} aria-controls={`${id}-list`} aria-autocomplete="list" aria-activedescendant={open && items[active] ? `${id}-${active}` : undefined}
      className={`${control} w-full pr-9 ${inputClassName}`} placeholder="품목 코드·이름 입력" autoComplete="off"
      value={editing ? query : selected}
      title={editing ? undefined : selected || undefined}
      onFocus={() => { setQuery(""); setEditing(true); }}
      onBlur={() => setEditing(false)}
      onChange={e => { setQuery(e.target.value); setEditing(true); }}
      onKeyDown={e => {
        if (e.key === "ArrowDown") { e.preventDefault(); setActive(i => Math.min(i + 1, items.length - 1)); }
        else if (e.key === "ArrowUp") { e.preventDefault(); setActive(i => Math.max(i - 1, 0)); }
        else if (e.key === "Enter" && open) { e.preventDefault(); if (items[active]) choose(items[active]); }
        else if (e.key === "Escape") { setEditing(false); }
      }} />
    {value && !editing && <button type="button" aria-label={`${label} 선택 해제`} className="absolute right-1 top-1/2 grid h-8 w-8 -translate-y-1/2 place-items-center rounded-md text-slate-500 hover:bg-slate-100" onClick={() => { setSelected(""); onChange("", ""); }}>×</button>}
    {open && <ul id={`${id}-list`} role="listbox" aria-label={`${label} 후보`} className="absolute left-0 top-full z-20 mt-1 max-h-72 w-max min-w-full max-w-[min(28rem,calc(100vw-2rem))] overflow-y-auto rounded-lg border border-slate-200 bg-white py-1 text-sm shadow-lg">
      {loading ? <li className="px-3 py-2 text-slate-500">불러오는 중…</li> : error ? <li role="alert" className="px-3 py-2 text-red-700">{error}</li> : items.length === 0 ? <li className="px-3 py-2 text-slate-500">검색 결과가 없습니다.</li> : items.map((item, index) =>
        <li key={item.id} id={`${id}-${index}`} role="option" aria-selected={index === active} className={`cursor-pointer truncate px-3 py-2 ${index === active ? "bg-blue-50 text-blue-900" : ""}`} onMouseDown={e => { e.preventDefault(); choose(item); }} onMouseEnter={() => setActive(index)}>{text(item)}</li>)}
      {!loading && !error && total > items.length && <li className="border-t border-slate-100 px-3 py-2 text-xs text-slate-500">{total}개 중 {items.length}개 · 더 입력해 좁히세요</li>}
    </ul>}
  </div>;
}
