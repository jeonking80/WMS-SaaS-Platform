"use client";
import { useEffect, useRef, useState } from "react";
import { api, Field, message, nameOf, Note, options, Select, stockTitles, time, type Context } from "./common";
type Entry = {
  id: string;
  item_id: string;
  location_id: string;
  bucket: string;
  delta: number;
  request_id: string;
  actor_id: string;
  actor_name?: string;
  command: string;
  reason: string;
  original_id?: string;
  created_at: string;
  version: number;
};
type Page = { rows: Entry[]; cursor: string | null; has_more: boolean; boundary: number };
const csv = (value: unknown) => {
  let text = String(value ?? "");
  if (/^[\s]*[=+@-]/.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
};
export function Ledger({
  c,
  initialItem = "",
  initialLocation = "",
}: {
  c: Context;
  initialItem?: string;
  initialLocation?: string;
}) {
  const [item, setItem] = useState(initialItem),
    [location, setLocation] = useState(initialLocation),
    [from, setFrom] = useState(""),
    [to, setTo] = useState(""),
    [page, setPage] = useState<Page | null>(null),
    [cursors, setCursors] = useState<(string | null)[]>([null]),
    [index, setIndex] = useState(0),
    [busy, setBusy] = useState(false),
    [exporting, setExporting] = useState(false),
    [progress, setProgress] = useState(0),
    [error, setError] = useState("");
  const cancel = useRef(false),
    boundary = useRef<number | undefined>(undefined),
    generation = useRef(0);
  function query(cursor: string | null, limit = 100, version = boundary.current) {
    const p = new URLSearchParams({ warehouse_id: c.warehouse, limit: String(limit) });
    if (item) p.set("item_id", item);
    if (location) p.set("location_id", location);
    if (from) p.set("from", new Date(from).toISOString());
    if (to) p.set("to", new Date(to).toISOString());
    if (cursor) p.set("cursor", cursor);
    if (version !== undefined) p.set("boundary", String(version));
    return p.toString();
  }
  async function load(cursor: string | null) {
    const revision = ++generation.current;
    setBusy(true);
    setError("");
    try {
      const result = await api<Page>(`/api/v2/workflow/ledger?${query(cursor)}`);
      if (revision === generation.current) {
        boundary.current = result.boundary;
        setPage(result);
      }
    } catch (e) {
      if (revision === generation.current) setError(message(e));
    } finally {
      if (revision === generation.current) setBusy(false);
    }
  }
  useEffect(() => {
    boundary.current = undefined;
    setCursors([null]);
    setIndex(0);
    void load(null);
    return () => {
      cancel.current = true;
    };
  }, [c.warehouse, item, location, from, to]);
  async function exportAll() {
    setExporting(true);
    setProgress(0);
    setError("");
    cancel.current = false;
    const captured = new Date().toISOString(),
      parts: string[] = [];
    let cursor: string | null = null,
      total = 0,
      fixed = boundary.current;
    try {
      do {
        if (cancel.current) break;
        const result: Page = await api(`/api/v2/workflow/ledger?${query(cursor, 500, fixed)}`);
        fixed = result.boundary;
        parts.push(
          result.rows
            .map((row) =>
              [
                c.company,
                c.warehouse,
                fixed,
                captured,
                nameOf(c.items, row.item_id),
                nameOf(c.locations, row.location_id),
                row.bucket,
                row.delta,
                row.created_at,
                row.actor_name ||
                  c.people.find((p) => p.userId === row.actor_id)?.name ||
                  `이전 처리자 (${row.actor_id})`,
                row.command,
                row.reason,
                row.id,
                row.original_id,
                row.request_id,
              ]
                .map(csv)
                .join(","),
            )
            .join("\r\n"),
        );
        total += result.rows.length;
        setProgress(total);
        cursor = result.has_more ? result.cursor : null;
      } while (cursor);
      if (!cancel.current) {
        const head = [
          "회사",
          "창고",
          "처리경계버전",
          "내보내기시각",
          "품목",
          "위치",
          "상태",
          "증감EA",
          "발생시각",
          "작업자",
          "업무",
          "사유",
          "원장실적",
          "원본실적",
          "요청추적",
        ]
          .map(csv)
          .join(",");
        const metadata = [
          "회사",
          c.company,
          "창고코드",
          c.warehouseCode,
          "창고명",
          c.warehouseName,
          "창고ID",
          c.warehouse,
          "품목필터",
          item ? nameOf(c.items, item) : "전체",
          "위치필터",
          location ? nameOf(c.locations, location) : "전체",
          "시작시각필터",
          from || "전체",
          "종료시각필터",
          to || "전체",
          "처리경계버전",
          fixed,
          "내보내기기준시각",
          captured,
          "단위",
          "EA",
          "총행수",
          total,
        ]
          .map(csv)
          .join(",");
        const url = URL.createObjectURL(
          new Blob(["\ufeff", metadata, "\r\n", head, "\r\n", ...parts.flatMap((part) => [part, "\r\n"])], {
            type: "text/csv;charset=utf-8",
          }),
        );
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = `wms-ledger-${total}.csv`;
        anchor.click();
        URL.revokeObjectURL(url);
      }
    } catch (e) {
      setError(message(e));
    } finally {
      setExporting(false);
    }
  }
  return (
    <section className="v2-card">
      <h2>전체 원장 조회 · 고정 처리 경계</h2>
      <div className="v2-grid">
        <Select
          label="원장 품목 필터"
          value={item}
          onChange={setItem}
          options={options(c.items)}
          disabled={exporting}
        />
        <Select
          label="원장 위치 필터"
          value={location}
          onChange={setLocation}
          options={options(c.locations)}
          disabled={exporting}
        />
        <Field label="원장 시작 시각">
          <input type="datetime-local" value={from} disabled={exporting} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label="원장 종료 시각">
          <input type="datetime-local" value={to} disabled={exporting} onChange={(e) => setTo(e.target.value)} />
        </Field>
      </div>
      <Note>
        처리경계 버전 {page?.boundary ?? "확인 중"}에 고정해 조회합니다. 페이지 이동 중 새 실적은 끼어들지 않습니다.
        전체 내보내기도 같은 회사·창고·품목·위치·기간과 처리경계를 사용합니다.
      </Note>
      {error && (
        <p className="v2-alert" role="alert">
          {error}
        </p>
      )}
      <div className="v2-actions">
        <button
          disabled={busy || exporting}
          onClick={() => {
            boundary.current = undefined;
            setCursors([null]);
            setIndex(0);
            void load(null);
          }}
        >
          최신 처리경계로 다시 조회
        </button>
        <button disabled={exporting || !page} onClick={() => void exportAll()}>
          현재 필터 전체 원장 CSV
        </button>
        {exporting && (
          <>
            <span role="status">{progress.toLocaleString()}행 내보내는 중…</span>
            <button
              onClick={() => {
                cancel.current = true;
              }}
            >
              내보내기 중단
            </button>
          </>
        )}
      </div>
      <div className="v2-table">
        <table>
          <thead>
            <tr>
              <th>발생 시각</th>
              <th>품목</th>
              <th>위치</th>
              <th>상태</th>
              <th>증감 EA</th>
              <th>작업자·사유</th>
            </tr>
          </thead>
          <tbody>
            {page?.rows.map((row) => (
              <tr key={row.id}>
                <td>{time(row.created_at)}</td>
                <td>{nameOf(c.items, row.item_id)}</td>
                <td>{nameOf(c.locations, row.location_id)}</td>
                <td>{stockTitles[row.bucket] ?? row.bucket}</td>
                <td>{row.delta}</td>
                <td>
                  {row.actor_name ||
                    c.people.find((p) => p.userId === row.actor_id)?.name ||
                    `이전 처리자 (${row.actor_id})`}{" "}
                  · {row.reason || row.command}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!busy && page && !page.rows.length && <p className="v2-empty">조회 조건에 해당하는 원장 실적이 없습니다.</p>}
      <div className="v2-pager" hidden={index === 0 && !page?.has_more}>
        <button
          disabled={busy || index === 0}
          onClick={() => {
            setIndex(index - 1);
            void load(cursors[index - 1]);
          }}
        >
          이전 원장
        </button>
        <span>
          {index + 1}페이지 · {page?.rows.length || 0}행
        </span>
        <button
          disabled={busy || !page?.has_more}
          onClick={() => {
            const next = page?.cursor || null;
            setCursors((values) => [...values.slice(0, index + 1), next]);
            setIndex(index + 1);
            void load(next);
          }}
        >
          다음 원장
        </button>
      </div>
    </section>
  );
}
type LegacySource = {
  id: string;
  document_no: string;
  document_number: string;
  document_kind: string;
  created_at: string;
};
type LegacyPage = { sources: LegacySource[]; next_cursor: string | null; has_more: boolean };
export function OriginPicker({
  c,
  item,
  value,
  onChange,
}: {
  c: Context;
  item: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const [rows, setRows] = useState<Entry[]>([]),
    [legacy, setLegacy] = useState<LegacySource[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [boundary, setBoundary] = useState<number | undefined>(),
    [more, setMore] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [search, setSearch] = useState(""),
    [legacyCursor, setLegacyCursor] = useState<string | null>(null),
    [legacyMore, setLegacyMore] = useState(false),
    [legacyBusy, setLegacyBusy] = useState(false),
    [legacyError, setLegacyError] = useState("");
  const revision = useRef(0),
    legacyRevision = useRef(0);
  async function load(next = false) {
    const currentRevision = ++revision.current;
    setBusy(true);
    setError("");
    try {
      const params = new URLSearchParams({ warehouse_id: c.warehouse, limit: "100" });
      if (item) params.set("item_id", item);
      if (next && cursor) params.set("cursor", cursor);
      if (next && boundary !== undefined) params.set("boundary", String(boundary));
      const result = await api<Page>(`/api/v2/workflow/ledger?${params}`);
      if (currentRevision !== revision.current) return;
      setRows((current) => (next ? [...current, ...result.rows] : result.rows));
      setCursor(result.cursor);
      setBoundary(result.boundary);
      setMore(result.has_more);
    } catch (e) {
      if (currentRevision === revision.current) setError(message(e));
    } finally {
      if (currentRevision === revision.current) setBusy(false);
    }
  }
  async function loadLegacy(next = false) {
    const currentRevision = ++legacyRevision.current;
    setLegacyBusy(true);
    setLegacyError("");
    try {
      const params = new URLSearchParams({ warehouse_id: c.warehouse, limit: "50" });
      if (item) params.set("item_id", item);
      if (search.trim()) params.set("q", search.trim());
      if (next && legacyCursor) params.set("cursor", legacyCursor);
      const result = await api<LegacyPage>(`/api/v2/workflow/correction-source?${params}`);
      if (currentRevision !== legacyRevision.current) return;
      setLegacy((current) =>
        next ? [...new Map([...current, ...result.sources].map((row) => [row.id, row])).values()] : result.sources,
      );
      setLegacyCursor(result.next_cursor);
      setLegacyMore(result.has_more);
    } catch (e) {
      if (currentRevision === legacyRevision.current) setLegacyError(message(e));
    } finally {
      if (currentRevision === legacyRevision.current) setLegacyBusy(false);
    }
  }
  useEffect(() => {
    setRows([]);
    setCursor(null);
    setBoundary(undefined);
    setMore(false);
    void load();
    return () => {
      revision.current++;
    };
  }, [c.warehouse, item]);
  useEffect(() => {
    setLegacy([]);
    setLegacyCursor(null);
    setLegacyMore(false);
    onChange("");
    const timer = setTimeout(() => void loadLegacy(), 200);
    return () => {
      clearTimeout(timer);
      legacyRevision.current++;
    };
  }, [c.warehouse, item, search]);
  return (
    <>
      <Field label="기존 전표번호·품목·메모 검색">
        <input
          type="search"
          maxLength={100}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="예: WMS-000001 또는 품목 코드"
        />
      </Field>
      <Select
        label="정정 원본 실적"
        value={value}
        onChange={onChange}
        options={[
          ...legacy.map((row) => ({
            id: row.id,
            label: `기존 전표 ${row.document_number || row.document_no} · ${row.document_kind} · ${time(row.created_at)}`,
          })),
          ...rows.map((row, index) => ({
            id: row.id,
            label: `실적 ${index + 1} · ${nameOf(c.items, row.item_id)} · ${nameOf(c.locations, row.location_id)} · ${stockTitles[row.bucket] ?? row.bucket} ${row.delta} EA · ${time(row.created_at)} · ${row.reason || row.command}`,
          })),
        ]}
        required
        disabled={busy || legacyBusy}
      />
      <Note>
        기존 전표는 검색 결과를 50개씩 더 조회할 수 있습니다. 품목 필터는 기존 전표와 v2 원장에 모두 적용됩니다. v2 원장
        처리경계 {boundary ?? "확인 중"}.
      </Note>
      {legacyBusy && <p role="status">기존 전표 원본을 찾는 중…</p>}
      {legacyMore && (
        <button type="button" disabled={legacyBusy} onClick={() => void loadLegacy(true)}>
          이전 기존 전표 50개 더 불러오기
        </button>
      )}
      {more && (
        <button type="button" disabled={busy} onClick={() => void load(true)}>
          이전 원본 실적 100개 더 불러오기
        </button>
      )}
      {legacyError && (
        <p role="alert" className="v2-alert">
          {legacyError}
        </p>
      )}
      {error && (
        <p role="alert" className="v2-alert">
          {error}
        </p>
      )}
    </>
  );
}
