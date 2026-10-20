"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { loadLookups } from "../lookup-client";
import ItemPicker from "../components/item-picker";
import DestinationPicker from "../components/destination-picker";
import {
  request,
  errorText,
  control,
  type MasterRow,
  RequestError,
} from "../api-client";
import {
  FilterForm,
  Pager,
  emptyFilters,
  query,
  seoulTime,
  type Pagination,
} from "../list-controls";
type Warehouse = MasterRow & { v2_active?: boolean };
type Kind = "INBOUND" | "OUTBOUND" | "TRANSFER";
type Line = {
  item_id: string;
  quantity: number;
  item_code?: string;
  item_name?: string;
};
type Doc = {
  document_number?: string;
  original_document_number?: string;
  reversal_document_number?: string;
  line_count?: number;
  total_quantity?: string;
  id: string;
  kind: Kind;
  status: string;
  warehouse_id: string;
  source_location_id: string | null;
  destination_location_id: string | null;
  version: number;
  note: string | null;
  recipient_name: string | null;
  delivery_destination_id: string | null;
  delivery_address: string | null;
  lines: Line[];
  created_at: string;
  updated_at: string;
  posted_at?: string | null;
  reversed_at?: string | null;
  reversal_of_id?: string | null;
  reversal_document_id?: string | null;
};
type PostOperation = { documentId: string; version: number; key: string };
// Keep the original key so pending inbound confirmations survive this UI upgrade.
const operationStorageKey = (id: string) => `wms:inbound-post:${id}`;
const reverseStorageKey = (id: string) => `wms:document-reverse:${id}`;
const statusLabel = (status: string, kind: Kind) =>
  status === "DRAFT"
    ? "초안"
    : status === "CANCELLED"
      ? "취소됨"
      : status === "REVERSED"
        ? "확정 취소됨"
        : status === "POSTED"
          ? `${kinds[kind]} 확정됨`
          : status;
const documentNumber = (doc: Doc) => doc.document_number || "전표 확인 중";
const primary =
  "min-w-0 rounded-lg bg-blue-700 px-4 py-2.5 font-semibold text-white shadow-sm hover:bg-blue-800 disabled:opacity-50";
const kinds = { INBOUND: "입고", OUTBOUND: "출고", TRANSFER: "이동" };
export default function Documents({
  role,
  history = false,
}: {
  role: string;
  history?: boolean;
}) {
  const listRequest = useRef(0);
  const initialized = useRef(false);
  const [newTouched, setNewTouched] = useState(false);
  const [lookupsReady, setLookupsReady] = useState(false);
  const [filters, setFilters] = useState(emptyFilters),
    [applied, setApplied] = useState(emptyFilters),
    [page, setPage] = useState(1),
    [pagination, setPagination] = useState<Pagination | null>(null),
    [confirmation, setConfirmation] = useState<"post" | "reverse" | null>(null);
  const [docs, setDocs] = useState<Doc[]>([]),
    [items, setItems] = useState<MasterRow[]>([]),
    [warehouses, setWarehouses] = useState<Warehouse[]>([]),
    [locations, setLocations] = useState<MasterRow[]>([]);
  const [selected, setSelected] = useState<Doc | null>(null),
    [editing, setEditing] = useState(false),
    [kind, setKind] = useState<Kind>("INBOUND"),
    [warehouse, setWarehouse] = useState(""),
    [source, setSource] = useState(""),
    [destination, setDestination] = useState(""),
    [recipient, setRecipient] = useState(""),
    [deliveryAddress, setDeliveryAddress] = useState(""),
    [note, setNote] = useState(""),
    [lines, setLines] = useState<Line[]>([{ item_id: "", quantity: 1 }]);
  const [stockSnapshot, setStockSnapshot] = useState<{
    scope: string;
    quantities: Record<string, string>;
    error: string;
    loading: boolean;
  }>({ scope: "", quantities: {}, error: "", loading: false });
  const [deliveryDestinationId, setDeliveryDestinationId] = useState("");
  const [stockRefresh, setStockRefresh] = useState(0);
  const stockItemIds = [
    ...new Set(lines.map((line) => line.item_id).filter(Boolean)),
  ]
    .sort()
    .join(",");
  const stockScope = `${source}:${stockItemIds}`;
  useEffect(() => {
    if (
      (kind !== "OUTBOUND" && kind !== "TRANSFER") ||
      !source ||
      !stockItemIds ||
      (selected?.status && selected.status !== "DRAFT")
    )
      return;
    let active = true;
    setStockSnapshot({
      scope: stockScope,
      quantities: {},
      error: "",
      loading: true,
    });
    Promise.all(
      stockItemIds
        .split(",")
        .slice(0, 20)
        .map(async (itemId) => {
          const data = await request<{
            stock: { location_id: string; item_id: string; quantity: string }[];
          }>(
            `/api/stock?location_id=${encodeURIComponent(source)}&item_id=${encodeURIComponent(itemId)}`,
          );
          return [
            itemId,
            data.stock.find(
              (row) => row.location_id === source && row.item_id === itemId,
            )?.quantity ?? "0",
          ] as const;
        }),
    )
      .then((rows) => {
        if (active)
          setStockSnapshot({
            scope: stockScope,
            quantities: Object.fromEntries(rows),
            error: "",
            loading: false,
          });
      })
      .catch((e) => {
        if (active)
          setStockSnapshot({
            scope: stockScope,
            quantities: {},
            error: errorText(e),
            loading: false,
          });
      });
    return () => {
      active = false;
    };
  }, [kind, source, stockItemIds, stockScope, stockRefresh, selected?.status]);
  const [reverseOperation, setReverseOperation] =
    useState<PostOperation | null>(null);
  const [postOperation, setPostOperation] = useState<PostOperation | null>(
    null,
  );
  const [pending, setPending] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [conflict, setConflict] = useState(false),
    [loaded, setLoaded] = useState(false);
  async function reload() {
    const generation = ++listRequest.current;
    setLoaded(false);
    setDocs([]);
    setPagination(null);
    try {
      const [d, lookups] = await Promise.all([
        request<{ documents: Doc[]; pagination: Pagination }>(
          `/api/documents?${query(applied, page, history ? { view: "history" } : {})}`,
        ),
        loadLookups(),
      ]);
      if (generation !== listRequest.current) return;
      setDocs(d.documents);
      setPagination(d.pagination);
      setWarehouses(lookups.warehouses);
      setLocations(lookups.locations);
      setLookupsReady(true);
      setLoaded(true);
    } catch (e) {
      if (generation !== listRequest.current) return;
      setDocs([]);
      setPagination(null);
      setLoaded(true);
      setError(errorText(e));
    }
  }
  useEffect(() => {
    setError("");
    void reload();
  }, [applied, page, history]);
  useEffect(() => {
    if (!lookupsReady || initialized.current) return;
    initialized.current = true;
    const params = new URLSearchParams(window.location.search);
    const initial = { ...emptyFilters };
    for (const key of Object.keys(initial) as (keyof typeof initial)[])
      initial[key] = params.get(key) || "";
    setFilters(initial);
    setApplied(initial);
    const id = params.get("id");
    if (id) {
      void open(id);
      return;
    }
    const requestedKind = (params.get("new") ||
      (params.get("item_id") && params.get("location_id")
        ? params.get("kind")
        : null)) as Kind;
    if (!history && requestedKind in kinds) {
      startNew(requestedKind);
      const warehouseId = params.get("warehouse_id");
      const sourceId =
        params.get("source_location_id") || params.get("location_id");
      if (
        warehouseId &&
        warehouses.some((row) => row.id === warehouseId && row.active)
      ) {
        setWarehouse(warehouseId);
        if (
          sourceId &&
          locations.some(
            (row) =>
              row.id === sourceId &&
              row.warehouse_id === warehouseId &&
              row.active,
          )
        )
          setSource(sourceId);
      }
      if (params.get("item_id"))
        setLines([{ item_id: params.get("item_id")!, quantity: 1 }]);
    }
  }, [lookupsReady, history]);
  function populate(d: Doc | null) {
    setNewTouched(false);
    if (history && d)
      setItems(
        d.lines.map((l) => ({
          id: l.item_id,
          code: l.item_code ?? l.item_id,
          name: l.item_name ?? l.item_id,
          active: true,
        })),
      );
    let operation: PostOperation | null = null;
    if (d) {
      const stored = sessionStorage.getItem(operationStorageKey(d.id));
      if (stored && d.status === "DRAFT") {
        try {
          const parsed = JSON.parse(stored) as PostOperation;
          if (
            parsed.documentId === d.id &&
            typeof parsed.version === "number" &&
            typeof parsed.key === "string"
          )
            operation = parsed;
        } catch {
          /* Ignore an invalid local record. */
        }
      } else if (stored) sessionStorage.removeItem(operationStorageKey(d.id));
    }
    let reverse: PostOperation | null = null;
    if (d) {
      const stored = sessionStorage.getItem(reverseStorageKey(d.id));
      if (stored && d.status === "POSTED" && !d.reversal_of_id) {
        try {
          const parsed = JSON.parse(stored) as PostOperation;
          if (
            parsed.documentId === d.id &&
            typeof parsed.version === "number" &&
            typeof parsed.key === "string"
          )
            reverse = parsed;
        } catch {
          /* Ignore invalid local records. */
        }
      } else if (stored) sessionStorage.removeItem(reverseStorageKey(d.id));
    }
    setReverseOperation(reverse);
    setPostOperation(operation);
    setDeliveryDestinationId(d?.delivery_destination_id || "");
    setSelected(d);
    setKind(d?.kind || "INBOUND");
    setWarehouse(d?.warehouse_id || "");
    setSource(d?.source_location_id || "");
    setDestination(d?.destination_location_id || "");
    setRecipient(d?.kind === "OUTBOUND" ? d.recipient_name || "" : "");
    setDeliveryAddress(d?.kind === "OUTBOUND" ? d.delivery_address || "" : "");
    setNote(d?.note || "");
    setLines(
      d?.lines.map((l) => ({
        item_id: l.item_id,
        quantity: Number(l.quantity),
      })) || [{ item_id: "", quantity: 1 }],
    );
    setEditing(true);
    setConflict(false);
    setError("");
    setNotice("");
  }
  async function open(id: string) {
    if (!canLeave()) return;
    setPending(true);
    setError("");
    try {
      const r = await request<{ document: Doc }>(
        `/api/documents/${id}${history ? "?view=history" : ""}`,
      );
      populate(r.document);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setPending(false);
    }
  }
  function fail(e: unknown) {
    if(e instanceof RequestError && ['WAREHOUSE_CUTOVER_READ_ONLY','V2_CUTOVER_ACTIVE','LEGACY_WRITE_BLOCKED','WAREHOUSE_CONVERTED'].includes(e.code)){
      setError('현장 운영 v2로 전환한 창고입니다. 기존 전표는 조회만 할 수 있습니다. 신규 업무와 정정은 현장 운영 화면에서 처리하세요.');
      void reload();return;
    }
    if (e instanceof RequestError && e.code === "DELIVERY_REQUIRED") {
      setError("등록된 배송지를 선택한 후 전표를 저장하고 출고를 확정하세요.");
      return;
    }
    if (e instanceof RequestError && e.code === "INSUFFICIENT_STOCK") {
      setError(
        "재고가 부족합니다. 출발 로케이션의 재고와 출고 수량을 확인한 후 전표를 수정·저장하세요.",
      );
      return;
    }
    setError(errorText(e));
    if (e instanceof RequestError && e.status === 409) {
      setConflict(true);
      if (e.code === "CONFLICT" || e.code === "VERSION_CONFLICT")
        setError(
          "다른 사용자가 전표를 변경했거나 현재 상태에서 처리할 수 없습니다. 최신 전표를 다시 불러오세요.",
        );
    }
  }
  async function save() {
    if (
      pending ||
      converted ||
      history ||
      (selected && selected.status !== "DRAFT") ||
      postOperation ||
      reverseOperation ||
      conflict
    )
      return;
    if (
      !warehouse ||
      (kind !== "INBOUND" && !source) ||
      (kind !== "OUTBOUND" && !destination)
    ) {
      setError("창고와 보관위치를 선택하세요.");
      return;
    }
    if (
      !lines.length ||
      lines.length > 20 ||
      lines.some(
        (line) =>
          !line.item_id ||
          !Number.isInteger(line.quantity) ||
          line.quantity < 1 ||
          line.quantity > 1000000000,
      )
    ) {
      setError("각 품목과 1 이상 1,000,000,000 이하의 정수 수량을 입력하세요.");
      return;
    }
    if (
      kind === "OUTBOUND" &&
      !deliveryDestinationId &&
      (!selected || !recipient.trim() || !deliveryAddress.trim())
    ) {
      setError("등록된 배송지를 선택하세요.");
      return;
    }
    if (new Set(lines.map((l) => l.item_id)).size !== lines.length) {
      setError("같은 품목은 한 번만 추가할 수 있습니다.");
      return;
    }
    if (kind === "TRANSFER" && source === destination) {
      setError("출발 로케이션과 도착 로케이션은 달라야 합니다.");
      return;
    }
    setPending(true);
    setError("");
    setNotice("");
    try {
      const body = {
        kind,
        warehouse_id: warehouse,
        delivery_destination_id:
          kind === "OUTBOUND" ? deliveryDestinationId || null : null,
        recipient_name: kind === "OUTBOUND" ? recipient.trim() : null,
        delivery_address: kind === "OUTBOUND" ? deliveryAddress.trim() : null,
        ...(kind !== "INBOUND" ? { source_location_id: source } : {}),
        ...(kind !== "OUTBOUND"
          ? { destination_location_id: destination }
          : {}),
        note,
        lines,
        ...(selected ? { version: selected.version } : {}),
      };
      const r = await request<{ document: Doc }>(
        `/api/documents${selected ? `/${selected.id}` : ""}`,
        selected ? "PATCH" : "POST",
        body,
      );
      populate(r.document);
      await reload();
      setNotice("전표를 저장했습니다.");
    } catch (e) {
      fail(e);
    } finally {
      setPending(false);
    }
  }
  async function cancel() {
    if (!selected || converted) return;
    setPending(true);
    setError("");
    try {
      const r = await request<{ document: Doc }>(
        `/api/documents/${selected.id}/cancel`,
        "POST",
        { version: selected.version },
      );
      populate(r.document);
      await reload();
      setNotice("전표를 취소했습니다.");
    } catch (e) {
      fail(e);
    } finally {
      setPending(false);
    }
  }
  async function postDocument() {
    if (converted || !selected || selected.status !== "DRAFT" || (!postOperation && dirty))
      return;
    setPending(true);
    setError("");
    setNotice("");
    let operation = postOperation;
    try {
      if (!operation) {
        operation = {
          documentId: selected.id,
          version: selected.version,
          key: crypto.randomUUID(),
        };
        // Persist before sending so a lost response or page reload cannot create a second operation.
        sessionStorage.setItem(
          operationStorageKey(selected.id),
          JSON.stringify(operation),
        );
        setPostOperation(operation);
      }
      const response = await fetch(
        `/api/documents/${operation.documentId}/post`,
        {
          method: "POST",
          credentials: "same-origin",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": operation.key,
          },
          body: JSON.stringify({ version: operation.version }),
        },
      );
      const data = await response.json();
      if (!response.ok)
        throw new RequestError(
          response.status,
          typeof data.error === "string"
            ? data.error
            : data.error?.code || "UNKNOWN",
        );
      sessionStorage.removeItem(operationStorageKey(selected.id));
      setPostOperation(null);
      // The posting response is a summary; fetch the full document for its read-only detail.
      setSelected({ ...selected, ...data.document });
      const detail = await request<{ document: Doc }>(
        `/api/documents/${selected.id}`,
      );
      populate(detail.document);
      await reload();
      setNotice(
        `${kinds[selected.kind]}를 확정했습니다. 재고에 반영되었습니다.`,
      );
    } catch (e) {
      if (
        e instanceof RequestError &&
        e.status < 500 &&
        e.code !== "RETRYABLE_TRANSACTION"
      ) {
        sessionStorage.removeItem(operationStorageKey(selected.id));
        setPostOperation(null);
        fail(e);
      } else {
        setError(
          `${errorText(e)} 처리 결과를 확인하지 못했다면 같은 요청으로 다시 시도하세요. 확인 전에는 전표를 수정할 수 없습니다.`,
        );
      }
    } finally {
      setPending(false);
    }
  }
  async function reverseDocument() {
    if (
      converted ||
      !selected ||
      role !== "admin" ||
      selected.status !== "POSTED" ||
      selected.reversal_of_id
    )
      return;
    setPending(true);
    setError("");
    setNotice("");
    let operation = reverseOperation;
    try {
      if (!operation) {
        operation = {
          documentId: selected.id,
          version: selected.version,
          key: crypto.randomUUID(),
        };
        sessionStorage.setItem(
          reverseStorageKey(selected.id),
          JSON.stringify(operation),
        );
        setReverseOperation(operation);
      }
      const response = await fetch(
        `/api/documents/${operation.documentId}/reverse`,
        {
          method: "POST",
          credentials: "same-origin",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": operation.key,
          },
          body: JSON.stringify({ version: operation.version }),
        },
      );
      const data = await response.json();
      if (!response.ok)
        throw new RequestError(
          response.status,
          typeof data.error === "string"
            ? data.error
            : data.error?.code || "UNKNOWN",
        );
      sessionStorage.removeItem(reverseStorageKey(selected.id));
      setReverseOperation(null);
      setSelected({
        ...selected,
        ...data.document,
        reversal_document_id: data.reversal.id,
      });
      const detail = await request<{ document: Doc }>(
        `/api/documents/${selected.id}`,
      );
      populate(detail.document);
      await reload();
      setNotice(
        "확정을 취소했습니다. 반대 전표가 생성되어 재고에 반영되었습니다.",
      );
    } catch (e) {
      if (
        e instanceof RequestError &&
        e.status < 500 &&
        e.code !== "RETRYABLE_TRANSACTION"
      ) {
        sessionStorage.removeItem(reverseStorageKey(selected.id));
        setReverseOperation(null);
        if (e.code === "INSUFFICIENT_STOCK")
          setError(
            "취소에 필요한 재고가 부족합니다. 재고를 확인한 후 다시 시도하세요.",
          );
        else fail(e);
      } else
        setError(
          `${errorText(e)} 처리 결과를 확인하지 못했다면 같은 요청으로 다시 시도하세요.`,
        );
    } finally {
      setPending(false);
    }
  }
  const dirty =
    !!selected &&
    (kind !== selected.kind ||
      warehouse !== selected.warehouse_id ||
      source !== (selected.source_location_id || "") ||
      destination !== (selected.destination_location_id || "") ||
      note !== (selected.note || "") ||
      deliveryDestinationId !==
        (selected.kind === "OUTBOUND"
          ? selected.delivery_destination_id || ""
          : "") ||
      recipient !==
        (selected.kind === "OUTBOUND" ? selected.recipient_name || "" : "") ||
      deliveryAddress !==
        (selected.kind === "OUTBOUND" ? selected.delivery_address || "" : "") ||
      lines.length !== selected.lines.length ||
      lines.some(
        (line, index) =>
          line.item_id !== selected.lines[index]?.item_id ||
          line.quantity !== Number(selected.lines[index]?.quantity),
      ));
  const newDirty =
    editing &&
    !selected &&
    (newTouched ||
      lines.length > 1 ||
      !!note ||
      !!deliveryDestinationId ||
      lines.some((line) => !!line.item_id || line.quantity !== 1));
  function canLeave() {
    return (
      !((dirty || newDirty) && !readonly) ||
      window.confirm(
        "저장하지 않은 변경 내용이 있습니다. 변경 내용을 버리고 계속할까요?",
      )
    );
  }
  function startNew(nextKind: Kind = "INBOUND") {
    if (!canLeave()) return;
    populate(null);
    setKind(nextKind);
    const activeWarehouses = warehouses.filter((row) => row.active && !row.v2_active);
    if (activeWarehouses.length === 1) {
      setWarehouse(activeWarehouses[0].id);
      const activeLocations = locations.filter(
        (row) => row.active && row.warehouse_id === activeWarehouses[0].id,
      );
      if (activeLocations.length === 1) {
        if (nextKind !== "INBOUND") setSource(activeLocations[0].id);
        if (nextKind !== "OUTBOUND") setDestination(activeLocations[0].id);
      }
    }
  }
  useEffect(() => {
    if (!(dirty || newDirty) || history) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, newDirty, history]);
  const converted = warehouses.find(row=>row.id===warehouse)?.v2_active===true;
  const canCreateLegacy = warehouses.some(row=>row.active&&!row.v2_active);
  const readonly = history || converted || (!!selected && selected.status !== "DRAFT");
  const disabled =
    pending || readonly || conflict || !!postOperation || !!reverseOperation;
  function options(rows: MasterRow[], value: string) {
    return rows
      .filter((r) => r.active || r.id === value)
      .map((r) => (
        <option key={r.id} value={r.id} disabled={!r.active}>
          {r.code} · {r.name}
          {!r.active ? " (비활성)" : ""}
        </option>
      ));
  }
  function locationSelect(
    label: string,
    value: string,
    set: (v: string) => void,
  ) {
    return (
      <label>
        {label}
        <select
          className={`${control} block w-full`}
          required
          value={value}
          onChange={(e) => set(e.target.value)}
          disabled={disabled}
        >
          <option value="">선택하세요</option>
          {options(
            locations.filter((l) => l.warehouse_id === warehouse),
            value,
          )}
        </select>
      </label>
    );
  }
  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="mb-1 text-sm font-semibold text-blue-700">재고 업무</p>
          <h1 className="text-3xl font-bold tracking-tight text-slate-900">
            {history ? "확정 이력" : "입출고 전표"}
          </h1>
          <p className="mt-2 text-sm text-slate-600">
            {history
              ? "확정 및 확정 취소된 전표를 조회합니다. 처리 시각은 서울 기준입니다."
              : "전표를 작성하고 저장한 다음 확정하면 재고에 반영됩니다."}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {!history && canCreateLegacy && (
            <>
              <button
                className={control}
                disabled={pending || !lookupsReady}
                onClick={() => startNew()}
              >
                새 전표
              </button>
              {(Object.keys(kinds) as Kind[]).map((value) => (
                <button
                  key={value}
                  className={value === "INBOUND" ? primary : control}
                  disabled={pending || !lookupsReady}
                  onClick={() => startNew(value)}
                >
                  {kinds[value]} 작성
                </button>
              ))}
            </>
          )}
          <button
            className={control}
            disabled={pending}
            onClick={() => void reload()}
          >
            목록 새로고침
          </button>
        </div>
      </header>
      {(converted || (warehouses.length>0&&!canCreateLegacy)) && <section role="status" className="rounded-xl border border-blue-200 bg-blue-50 p-4 text-blue-950"><strong>현장 운영 v2 전환 창고 · 기존 전표 조회 전용</strong><p className="mt-2 text-sm">기존 번호·확정 시각·원장 이력은 보존합니다. 전환 창고에서는 새 전표, 확정과 역분개를 실행할 수 없습니다. 신규 업무와 연결된 정정은 현장 운영에서 처리하세요.</p><Link className="mt-2 inline-block font-semibold underline" href="/dashboard/v2">현장 운영 v2로 이동</Link></section>}
      {error && (
        <p
          role="alert"
          className="rounded-lg border border-red-200 bg-red-50 p-4 text-red-800"
        >
          {error}
        </p>
      )}
      {notice && (
        <p
          role="status"
          className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-emerald-800"
        >
          {notice}
        </p>
      )}
      {conflict && selected && (
        <button
          className={control}
          disabled={pending}
          onClick={() => void open(selected.id)}
        >
          최신 전표 다시 불러오기
        </button>
      )}
      {editing && (
        <section className="min-w-0 rounded-xl border border-slate-200 bg-white shadow-sm [overflow-wrap:anywhere]">
          <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-200 p-5 sm:p-6">
            <div>
              <h2 className="text-xl font-bold">
                {converted ? "기존 전표 상세 · 조회 전용" : selected ? "전표 상세 / 수정" : "새 전표 작성"}
              </h2>
              <p className="mt-1 text-sm text-slate-600">
                {selected
                  ? documentNumber(selected)
                  : "저장하면 전표번호가 발급됩니다."}
                {selected && (
                  <>
                    {" "}
                    ·{" "}
                    <StatusPill status={selected.status} kind={selected.kind} />
                  </>
                )}
              </p>
            </div>
            <button
              type="button"
              className={control}
              disabled={pending}
              onClick={() => {
                if (canLeave()) setEditing(false);
              }}
            >
              닫기
            </button>
          </div>
          {!readonly && (
            <ol
              aria-label="전표 처리 단계"
              className="grid grid-cols-3 gap-2 border-b bg-slate-50 p-4 text-sm sm:px-6"
            >
              <li className="font-semibold text-slate-900">
                1. 작성{" "}
                <span className="block text-xs font-normal text-slate-500">
                  창고·품목·수량 입력
                </span>
              </li>
              <li
                className={
                  selected && !dirty
                    ? "font-semibold text-blue-700"
                    : "text-slate-600"
                }
              >
                2. 저장{" "}
                <span className="block text-xs font-normal text-slate-500">
                  초안 내용 보관
                </span>
              </li>
              <li className="text-slate-600">
                3. 확정{" "}
                <span className="block text-xs text-slate-500">
                  저장된 수량을 재고 반영
                </span>
              </li>
            </ol>
          )}
          <div className="p-5 sm:p-6">
            {selected && (
              <div className="mb-5 flex flex-wrap gap-x-6 gap-y-2 text-sm text-slate-600">
                {readonly && <p>읽기 전용</p>}
                {selected.posted_at && (
                  <p>확정 시각: {seoulTime(selected.posted_at)}</p>
                )}
                {selected.reversed_at && (
                  <p>확정 취소 시각: {seoulTime(selected.reversed_at)}</p>
                )}
                {selected.reversal_of_id && (
                  <button
                    className="font-medium text-blue-700 underline"
                    disabled={pending}
                    onClick={() => void open(selected.reversal_of_id!)}
                  >
                    원본 전표 열기 ·{" "}
                    {selected.original_document_number || "전표 확인 중"}
                  </button>
                )}
                {selected.reversal_document_id && (
                  <button
                    className="font-medium text-blue-700 underline"
                    disabled={pending}
                    onClick={() => void open(selected.reversal_document_id!)}
                  >
                    반대 전표 열기 ·{" "}
                    {selected.reversal_document_number || "전표 확인 중"}
                  </button>
                )}
              </div>
            )}
            {(postOperation || reverseOperation) && (
              <div
                role="status"
                className="mb-5 rounded-lg bg-amber-50 p-4 text-amber-900"
              >
                <p>
                  처리 결과를 확인 중입니다. 같은 요청으로 다시 시도하거나 최신
                  전표를 다시 불러오세요. 확인 전에는 수정과 취소가 제한됩니다.
                </p>
                <button
                  className={`${control} mt-2`}
                  disabled={pending}
                  onClick={() => selected && void open(selected.id)}
                >
                  {reverseOperation
                    ? "확정 취소 상태 다시 불러오기"
                    : "확정 상태 다시 불러오기"}
                </button>
              </div>
            )}
            {dirty && !postOperation && !readonly && (
              <p className="mb-4 text-sm font-medium text-amber-800">
                변경 내용을 저장한 후 확정하세요.
              </p>
            )}
            <form
              onChange={() => {
                if (!selected) setNewTouched(true);
              }}
              onSubmit={(event) => {
                event.preventDefault();
                void save();
              }}
            >
              <fieldset
                disabled={disabled}
                className="grid min-w-0 grid-cols-1 gap-4 md:grid-cols-2 [&_label]:min-w-0"
              >
                <legend className="mb-4 text-base font-bold">기본 정보</legend>
                <label className="text-sm font-medium">
                  전표 유형
                  <select
                    className={`${control} mt-1 block w-full`}
                    value={kind}
                    onChange={(event) => {
                      setKind(event.target.value as Kind);
                      setDeliveryDestinationId("");
                      setRecipient("");
                      setDeliveryAddress("");
                    }}
                  >
                    {Object.entries(kinds).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="text-sm font-medium">
                  창고
                  <select
                    className={`${control} mt-1 block w-full`}
                    required
                    value={warehouse}
                    onChange={(event) => {
                      const id = event.target.value;
                      setWarehouse(id);
                      const available = locations.filter(
                        (row) => row.active && row.warehouse_id === id,
                      );
                      setSource(
                        kind !== "INBOUND" && available.length === 1
                          ? available[0].id
                          : "",
                      );
                      setDestination(
                        kind !== "OUTBOUND" && available.length === 1
                          ? available[0].id
                          : "",
                      );
                    }}
                  >
                    <option value="">선택하세요</option>
                    {options(warehouses.filter(row=>!row.v2_active||row.id===warehouse), warehouse)}
                  </select>
                </label>
                {kind !== "INBOUND" &&
                  locationSelect("출발 보관위치", source, setSource)}
                {kind !== "OUTBOUND" &&
                  locationSelect("도착 보관위치", destination, setDestination)}
                {kind === "OUTBOUND" &&
                  (readonly ? (
                    <div className="space-y-1 rounded-lg bg-slate-50 p-4 md:col-span-2">
                      <p>
                        받는 거래처: {recipient || "배송정보 미등록(기존 전표)"}
                      </p>
                      <p className="whitespace-pre-wrap text-sm text-slate-600">
                        배송지:{" "}
                        {deliveryAddress || "배송정보 미등록(기존 전표)"}
                      </p>
                    </div>
                  ) : (
                    <DestinationPicker
                      role={role}
                      value={deliveryDestinationId}
                      snapshot={{
                        recipient_name: recipient,
                        delivery_address: deliveryAddress,
                      }}
                      disabled={disabled}
                      onChange={(row) => {
                        setDeliveryDestinationId(row.id);
                        setRecipient(row.recipient_name);
                        setDeliveryAddress(row.delivery_address);
                      }}
                    />
                  ))}
                <label className="text-sm font-medium md:col-span-2">
                  메모
                  <textarea
                    className={`${control} mt-1 block w-full`}
                    rows={2}
                    value={note}
                    maxLength={2000}
                    onChange={(event) => setNote(event.target.value)}
                  />
                </label>
              </fieldset>
              <section className="mt-7 border-t border-slate-200 pt-5">
                <div className="mb-4 flex items-center justify-between gap-3">
                  <h3 className="font-bold">
                    품목 명세{" "}
                    <span className="text-sm font-normal text-slate-500">
                      {lines.length} / 20개
                    </span>
                  </h3>
                  {!readonly && (
                    <button
                      type="button"
                      className={control}
                      disabled={disabled || lines.length >= 20}
                      onClick={() =>
                        setLines([...lines, { item_id: "", quantity: 1 }])
                      }
                    >
                      품목 추가
                    </button>
                  )}
                </div>
                {(kind === "OUTBOUND" || kind === "TRANSFER") && !readonly && (
                  <div className="mb-4 rounded-lg bg-blue-50 p-3 text-sm text-slate-700">
                    <p>
                      참고 재고는 출발 보관위치의 조회 시점 수량입니다. 최종
                      처리 가능 수량은 확정 시 다시 확인합니다.
                    </p>
                    <button
                      type="button"
                      className="mt-2 font-semibold text-blue-700 underline"
                      disabled={
                        !source ||
                        !stockItemIds ||
                        (stockSnapshot.scope === stockScope &&
                          stockSnapshot.loading)
                      }
                      onClick={() => setStockRefresh((value) => value + 1)}
                    >
                      참고 재고 새로고침
                    </button>
                    {stockSnapshot.scope === stockScope &&
                      stockSnapshot.error && (
                        <p role="alert">
                          참고 재고를 불러오지 못했습니다. {stockSnapshot.error}
                        </p>
                      )}
                  </div>
                )}
                <div className="space-y-3">
                  {lines.map((line, index) => (
                    <div
                      key={index}
                      className="flex min-w-0 flex-wrap items-end gap-3 rounded-lg border border-slate-200 bg-slate-50/60 p-3"
                    >
                      <div className="min-w-0 flex-1 basis-64">
                        {readonly ? (
                          <div className="py-2">
                            <p className="text-xs text-slate-500">
                              품목 {index + 1}
                            </p>
                            <p className="mt-1 font-semibold">
                              {selected?.lines[index]?.item_code || ""} ·{" "}
                              {selected?.lines[index]?.item_name ||
                                "품목 확인 중"}
                            </p>
                          </div>
                        ) : (
                          <ItemPicker
                            label={`품목 ${index + 1}`}
                            value={line.item_id}
                            required
                            activeOnly
                            disabled={disabled}
                            onChange={(id, item) => {
                              if (item)
                                setItems((current) => [
                                  ...current.filter(
                                    (row) => row.id !== item.id,
                                  ),
                                  {
                                    ...item,
                                    min_stock: item.min_stock ?? undefined,
                                  },
                                ]);
                              setLines((current) =>
                                current.map((row, n) =>
                                  n === index ? { ...row, item_id: id } : row,
                                ),
                              );
                            }}
                          />
                        )}
                      </div>
                      <label className="text-sm font-medium">
                        수량 {index + 1}
                        <input
                          className={`${control} mt-1 block w-32`}
                          required
                          type="number"
                          min={1}
                          max={1000000000}
                          step={1}
                          value={line.quantity}
                          disabled={disabled}
                          onChange={(event) =>
                            setLines(
                              lines.map((row, n) =>
                                n === index
                                  ? {
                                      ...row,
                                      quantity: Number(event.target.value),
                                    }
                                  : row,
                              ),
                            )
                          }
                        />
                      </label>
                      {!readonly && (
                        <button
                          type="button"
                          className={control}
                          disabled={disabled || lines.length === 1}
                          onClick={() =>
                            setLines(lines.filter((_, n) => n !== index))
                          }
                          aria-label={`품목 ${index + 1} 제거`}
                        >
                          제거
                        </button>
                      )}
                      {(kind === "OUTBOUND" || kind === "TRANSFER") &&
                        !readonly && (
                          <p className="w-full text-xs text-slate-600">
                            참고 재고:{" "}
                            {!source || !line.item_id
                              ? "출발 로케이션과 품목을 선택하세요"
                              : stockSnapshot.scope !== stockScope ||
                                  stockSnapshot.loading
                                ? "불러오는 중…"
                                : stockSnapshot.error
                                  ? "확인 불가"
                                  : (stockSnapshot.quantities[line.item_id] ??
                                    "확인 불가")}
                          </p>
                        )}
                    </div>
                  ))}
                </div>
              </section>
              <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 pt-5">
                <p className="text-sm text-slate-600">
                  총 {lines.length}개 품목 · 수량{" "}
                  {lines
                    .reduce(
                      (sum, line) => sum + (Number(line.quantity) || 0),
                      0,
                    )
                    .toLocaleString("ko-KR")}
                </p>
                <div className="flex flex-wrap gap-2">
                  {selected && !readonly && (
                    <button
                      type="button"
                      className={control}
                      disabled={disabled}
                      onClick={() => {
                        if (window.confirm("이 초안 전표를 취소할까요?"))
                          void cancel();
                      }}
                    >
                      전표 취소
                    </button>
                  )}
                  {!readonly && (
                    <button className={primary} disabled={disabled}>
                      {pending ? "처리 중…" : "전표 저장"}
                    </button>
                  )}
                  {selected && !readonly && (
                    <button
                      type="button"
                      className={primary}
                      disabled={
                        pending || (!postOperation && (conflict || dirty))
                      }
                      onClick={() =>
                        postOperation
                          ? void postDocument()
                          : setConfirmation("post")
                      }
                    >
                      {kinds[selected.kind]} 확정
                      {postOperation ? " 다시 시도" : ""}
                    </button>
                  )}
                  {!history &&
                    !converted &&
                    role === "admin" &&
                    selected?.status === "POSTED" &&
                    !selected.reversal_of_id && (
                      <button
                        type="button"
                        className={control}
                        disabled={pending || (!reverseOperation && conflict)}
                        onClick={() =>
                          reverseOperation
                            ? void reverseDocument()
                            : setConfirmation("reverse")
                        }
                      >
                        확정 취소{reverseOperation ? " 다시 시도" : ""}
                      </button>
                    )}
                </div>
              </div>
            </form>
          </div>
        </section>
      )}
      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-lg font-bold">전표 목록</h2>
          {applied.originals_only === "true" && (
            <span className="rounded-full bg-blue-50 px-3 py-1 text-xs font-semibold text-blue-800">
              원문서만 · 자동 생성된 취소 전표 제외
            </span>
          )}
        </div>
        <FilterForm
          value={filters}
          setValue={setFilters}
          onSubmit={() => {
            setError("");
            setPage(1);
            setApplied({ ...filters });
          }}
          warehouses={warehouses}
          locations={locations}
          documents
          history={history}
        />
        {!loaded ? (
          <p role="status" className="py-8 text-center text-slate-500">
            불러오는 중…
          </p>
        ) : docs.length === 0 ? (
          <div className="rounded-lg bg-slate-50 p-8 text-center">
            <p className="font-medium text-slate-700">
              등록된 전표가 없습니다.
            </p>
            <p className="mt-1 text-sm text-slate-500">
              검색 조건을 확인하거나 새 전표를 작성하세요.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[850px] text-left text-sm">
              <thead className="border-y border-slate-200 bg-slate-50 text-xs text-slate-500">
                <tr>
                  {[
                    "전표번호 / 유형",
                    "창고",
                    "받는 거래처",
                    "상태",
                    "품목 / 수량",
                    "작성 시각 (서울)",
                    "",
                  ].map((label) => (
                    <th key={label} className="px-3 py-3 font-semibold">
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {docs.map((doc) => (
                  <tr
                    key={doc.id}
                    className="border-b border-slate-100 hover:bg-slate-50"
                  >
                    <td className="px-3 py-4">
                      <button
                        className="whitespace-nowrap font-semibold text-blue-700 hover:underline"
                        disabled={pending}
                        onClick={() => void open(doc.id)}
                        aria-label={`전표 ${doc.id} 열기`}
                      >
                        {documentNumber(doc)}
                      </button>
                      <p className="mt-1 text-xs text-slate-500">
                        {kinds[doc.kind]}{warehouses.find(row=>row.id===doc.warehouse_id)?.v2_active ? " · 기존 전표" : ""}
                      </p>
                    </td>
                    <td className="px-3 py-4">
                      {warehouses.find((row) => row.id === doc.warehouse_id)
                        ?.name || "창고 확인 중"}
                    </td>
                    <td className="max-w-48 px-3 py-4">
                      {doc.kind === "OUTBOUND"
                        ? doc.recipient_name || "배송정보 미등록(기존 전표)"
                        : "—"}
                    </td>
                    <td className="px-3 py-4">
                      <StatusPill status={doc.status} kind={doc.kind} />
                    </td>
                    <td className="px-3 py-4 tabular-nums">
                      {doc.line_count ?? doc.lines?.length ?? "—"}개 /{" "}
                      {doc.total_quantity ??
                        doc.lines?.reduce(
                          (sum, line) => sum + Number(line.quantity),
                          0,
                        ) ??
                        "—"}
                    </td>
                    <td className="whitespace-nowrap px-3 py-4 text-xs text-slate-600">
                      {seoulTime(doc.created_at)}
                    </td>
                    <td className="px-3 py-4">
                      <button
                        className={control}
                        disabled={pending}
                        onClick={() => void open(doc.id)}
                        aria-label={`전표 ${doc.id} 상세 보기`}
                      >
                        열기
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pager value={pagination} onChange={setPage} pending={!loaded} />
      </section>
      {confirmation && selected && !converted && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="confirm-title"
            className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-xl bg-white p-6 shadow-xl"
          >
            <h2 id="confirm-title" className="text-xl font-bold">
              {confirmation === "post" ? "전표 확정 확인" : "확정 취소 확인"}
            </h2>
            <p className="mt-3 font-semibold">
              저장된 {kinds[selected.kind]} 전표 · {documentNumber(selected)}
            </p>
            <div className="my-4 space-y-2 rounded-lg bg-slate-50 p-4 text-sm">
              <p>
                창고:{" "}
                {warehouses.find((row) => row.id === selected.warehouse_id)
                  ?.name || "창고 확인 중"}
              </p>
              {selected.kind !== "INBOUND" && (
                <p>
                  출발 보관위치:{" "}
                  {locations.find(
                    (row) => row.id === selected.source_location_id,
                  )?.code || "없음"}
                </p>
              )}
              {selected.kind !== "OUTBOUND" && (
                <p>
                  도착 보관위치:{" "}
                  {locations.find(
                    (row) => row.id === selected.destination_location_id,
                  )?.code || "없음"}
                </p>
              )}
              {selected.kind === "OUTBOUND" && (
                <>
                  <p>
                    출고처:{" "}
                    {selected.recipient_name || "배송정보 미등록(기존 전표)"}
                  </p>
                  <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">
                    배송지:{" "}
                    {selected.delivery_address || "배송정보 미등록(기존 전표)"}
                  </p>
                </>
              )}
            </div>
            <ul className="my-4 space-y-2 border-y py-3 text-sm">
              {selected.lines.map((line) => (
                <li key={line.item_id} className="flex justify-between gap-3">
                  <span>
                    {line.item_name ||
                      items.find((item) => item.id === line.item_id)?.name ||
                      "품목 확인 중"}
                  </span>
                  <span className="whitespace-nowrap font-semibold">
                    수량 {line.quantity}
                  </span>
                </li>
              ))}
            </ul>
            <p className="text-sm text-slate-600">
              {confirmation === "post"
                ? "저장된 이 수량을 재고에 반영합니다."
                : "반대 전표를 생성하여 확정을 취소합니다."}
            </p>
            <div className="mt-6 flex justify-end gap-3">
              <button
                autoFocus
                className={control}
                onClick={() => setConfirmation(null)}
              >
                돌아가기
              </button>
              <button
                className={primary}
                onClick={() => {
                  const action = confirmation;
                  setConfirmation(null);
                  void (action === "post" ? postDocument() : reverseDocument());
                }}
              >
                {confirmation === "post" ? "확정 실행" : "취소 실행"}
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

function StatusPill({ status, kind }: { status: string; kind: Kind }) {
  const color =
    status === "DRAFT"
      ? "bg-amber-50 text-amber-800 ring-amber-200"
      : status === "POSTED"
        ? "bg-emerald-50 text-emerald-800 ring-emerald-200"
        : "bg-slate-100 text-slate-600 ring-slate-200";
  return (
    <span
      className={`inline-flex whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset ${color}`}
    >
      {statusLabel(status, kind)}
    </span>
  );
}
