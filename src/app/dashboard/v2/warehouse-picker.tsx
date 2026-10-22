"use client";
import { useId, useState } from "react";
import type { Row } from "./common";

const name = (row: Row) => `${String(row.code)} · ${String(row.name)}`;
const shown = 20;

// Type to find a warehouse and add it as a chip; scales to hundreds of warehouses without listing them all.
export function WarehousePicker({
  label,
  warehouses,
  value,
  onChange,
}: {
  label: string;
  warehouses: Row[];
  value: string[];
  onChange: (ids: string[]) => void;
}) {
  const id = useId();
  const [query, setQuery] = useState(""),
    [open, setOpen] = useState(false),
    [active, setActive] = useState(0);
  const selected = value.map((key) => warehouses.find((row) => row.id === key)).filter((row): row is Row => !!row);
  const needle = query.trim().toLocaleLowerCase();
  const candidates = warehouses.filter(
    (row) => !value.includes(row.id) && (!needle || name(row).toLocaleLowerCase().includes(needle)),
  );
  function add(row: Row) {
    onChange([...value, row.id]);
    setQuery("");
    setActive(0);
  }
  return (
    <div className="v2-field v2-multi">
      <label htmlFor={id}>{label}</label>
      <div className="v2-multi-row">
        <div className="v2-combo">
          <input
            id={id}
            role="combobox"
            aria-expanded={open}
            aria-controls={`${id}-list`}
            aria-autocomplete="list"
            aria-activedescendant={open && candidates[active] ? `${id}-${active}` : undefined}
            autoComplete="off"
            placeholder="창고 코드·이름 입력 후 선택"
            value={query}
            onFocus={() => setOpen(true)}
            onBlur={() => setOpen(false)}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
              setOpen(true);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive((i) => Math.min(i + 1, Math.min(candidates.length, shown) - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((i) => Math.max(i - 1, 0));
              } else if (e.key === "Enter") {
                e.preventDefault();
                if (candidates[active]) add(candidates[active]);
              } else if (e.key === "Escape") setOpen(false);
              else if (e.key === "Backspace" && !query && value.length) onChange(value.slice(0, -1));
            }}
          />
          {open && (
            <ul id={`${id}-list`} role="listbox" aria-label={`${label} 후보`} className="v2-combo-list">
              {candidates.length === 0 ? (
                <li className="v2-combo-empty">
                  {warehouses.length === value.length ? "모든 창고를 선택했습니다." : "검색 결과가 없습니다."}
                </li>
              ) : (
                candidates.slice(0, shown).map((row, index) => (
                  <li
                    key={row.id}
                    id={`${id}-${index}`}
                    role="option"
                    aria-selected={index === active}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      add(row);
                    }}
                    onMouseEnter={() => setActive(index)}
                  >
                    {name(row)}
                  </li>
                ))
              )}
              {candidates.length > shown && (
                <li className="v2-combo-empty">
                  {candidates.length}곳 중 {shown}곳 표시 · 더 입력해 좁히세요
                </li>
              )}
            </ul>
          )}
        </div>
        <button
          type="button"
          disabled={value.length === warehouses.length}
          onClick={() => onChange(warehouses.map((row) => row.id))}
        >
          현재 창고 전부 추가
        </button>
      </div>
      <div className="v2-chips" aria-live="polite">
        {selected.map((row) => (
          <span key={row.id} className="v2-chip-pick">
            {name(row)}
            <button
              type="button"
              aria-label={`${name(row)} 빼기`}
              onClick={() => onChange(value.filter((key) => key !== row.id))}
            >
              ×
            </button>
          </span>
        ))}
        <small>
          {selected.length ? `${selected.length}곳 선택 / 전체 ${warehouses.length}곳` : "선택한 창고가 없습니다."}
        </small>
        {selected.length > 0 && (
          <button type="button" className="v2-text-button" onClick={() => onChange([])}>
            모두 빼기
          </button>
        )}
      </div>
    </div>
  );
}
