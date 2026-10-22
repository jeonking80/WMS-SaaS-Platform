"use client";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { Identity } from "@/server/auth/access";
import {
  api,
  ApiFailure,
  message,
  options,
  Select,
  time,
  type Context,
  type Person,
  type Row,
  type Snapshot,
} from "./common";
import { LockedTerminal, useTerminalLock } from "./terminal-lock";
import { Workflow } from "./workflow-ui";
import { Inventory, Queue } from "./inventory-ui";
import { loadAllMasters } from "./master-pages";
import { Masters } from "./masters-ui";
import { Cutover } from "./cutover-ui";
import { Accounts, Integration } from "./identity-ui";
import { orderGuide, receiptGuide } from "@/server/v2/insights/guide";
import { ControlTower } from "./control-ui";
type Pending = { warehouse_id: string; request_id: string; command: string; payload: Record<string, unknown> };
type Runtime = {
  tenant: { id: string; name: string; isTest: boolean };
  environment: string;
  idleLockMinutes?: number;
  role: string;
  warehouses: Row[];
  assignees?: Person[];
  automationAccounts?: Person[];
};
const environments: Record<string, string> = { production: "운영 환경", test: "시험 환경", development: "개발 환경" },
  roles: Record<string, string> = { admin: "관리자", supervisor: "운영 책임자", worker: "작업자", viewer: "조회자" };
const menu = [
  {
    group: "운영",
    tabs: [
      ["control", "운영 관제"],
      ["queue", "업무 대기열"],
      ["receipts", "입고"],
      ["orders", "출고"],
      ["returns", "반품"],
      ["inventory", "재고"],
      ["audit", "실사·승인"],
    ],
  },
  {
    group: "관리",
    tabs: [
      ["masters", "기준정보"],
      ["integration", "외부 연계"],
      ["shift", "교대·마감"],
      ["accounts", "계정·권한"],
      ["cutover", "기존 창고 전환"],
    ],
  },
];
const tabs = menu.flatMap((section) => section.tabs);
const catalogKinds = ["items", "locations", "partners", "destinations", "barcodes"];
// Approval and count views moved from 재고 to their own 실사·승인 menu; old links keep working.
const auditViews = ["approval", "count"];
export default function Operations({ identity }: { identity: Identity }) {
  const [runtime, setRuntime] = useState<Runtime | null>(null),
    [warehouse, setWarehouse] = useState(""),
    [tab, setTab] = useState(identity.role === "worker" ? "queue" : "control"),
    [snapshot, setSnapshot] = useState<Snapshot | null>(null),
    [masters, setMasters] = useState<Record<string, Row[]>>({}),
    [mastersLoading, setMastersLoading] = useState(false),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [status, setStatus] = useState(""),
    [pending, setPending] = useState<Pending | null>(null),
    [selected, setSelected] = useState({ receipt: "", order: "", return: "" }),
    [loadedAt, setLoadedAt] = useState(""),
    [online, setOnline] = useState(true),
    [compose, setCompose] = useState("");
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  const pendingRef = useRef<Pending | null>(null),
    generation = useRef(0),
    masterGeneration = useRef(0),
    // Complete catalogs already loaded in this tab, per warehouse. Switching back shows them at once
    // and refreshes in the background; a partial catalog is never stored or shown.
    catalogs = useRef(new Map<string, Record<string, Row[]>>()),
    lock = useRef(false);
  const loadCatalog = useCallback(async (id: string) => {
    const rows = await Promise.all(
      catalogKinds.map(
        async (kind) =>
          [kind, await loadAllMasters<Row>(`/api/v2/masters/${kind}?warehouse_id=${encodeURIComponent(id)}`)] as const,
      ),
    );
    const catalog = Object.fromEntries(rows);
    catalogs.current.set(id, catalog);
    return catalog;
  }, []);
  const storage = `wms-v2:${identity.tenant.id}:${identity.user.id}:request`;
  useEffect(() => {
    // Remember only a warehouse the server listed for this user, so the next visit can start loading it at once.
    if (warehouse && runtime?.warehouses.some((w) => w.id === warehouse))
      localStorage.setItem(`${storage}:last-warehouse`, warehouse);
  }, [warehouse, runtime, storage]);
  const terminal = useTerminalLock(runtime?.idleLockMinutes || 15, storage);
  const persist = useCallback(
    (value: Pending | null) => {
      pendingRef.current = value;
      setPending(value);
      if (value) localStorage.setItem(storage, JSON.stringify(value));
      else localStorage.removeItem(storage);
    },
    [storage],
  );
  useEffect(() => {
    let current = true;
    // A linked warehouse starts loading together with the identity context instead of after it.
    // The server re-checks the grant on every call; a wrong guess is corrected below.
    const linked = new URLSearchParams(window.location.search).get("warehouse_id") || "";
    const last = localStorage.getItem(`${storage}:last-warehouse`) || "";
    let guessed = "";
    const candidate = linked || last;
    if (/^[0-9a-f-]{36}$/i.test(candidate) && !localStorage.getItem(storage)) {
      guessed = candidate;
      setWarehouse(candidate);
    }
    api<Runtime>("/api/v2/identity/context")
      .then((data) => {
        if (!current) return;
        setRuntime(data);
        let restore: Pending | null = null;
        try {
          restore = JSON.parse(localStorage.getItem(storage) || "null");
        } catch {
          localStorage.removeItem(storage);
        }
        if (restore && data.warehouses.some((w) => w.id === restore.warehouse_id)) {
          persist(restore);
          setWarehouse(restore.warehouse_id);
          setStatus("이전 확정의 결과 확인이 필요합니다. 아래에서 원래 요청을 조회하세요.");
        } else {
          localStorage.removeItem(storage);
          const requestedWarehouse = new URLSearchParams(window.location.search).get("warehouse_id");
          const chosen =
            data.warehouses.find((w) => w.id === requestedWarehouse)?.id ||
            (!requestedWarehouse && data.warehouses.find((w) => w.id === last && w.active !== false)?.id) ||
            data.warehouses.find((w) => w.active !== false)?.id ||
            "";
          if (guessed && chosen !== guessed) setError("");
          setWarehouse(chosen);
        }
      })
      .catch((e) => setError(message(e)))
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [persist, storage]);
  const refresh = useCallback(async () => {
    if (!warehouse) return;
    const revision = ++generation.current;
    setLoading(true);
    try {
      const data = await api<{ snapshot: Snapshot }>(`/api/v2/workflow?warehouse_id=${encodeURIComponent(warehouse)}`);
      if (revision !== generation.current) return;
      setSnapshot(data.snapshot);
      setLoadedAt(new Date().toISOString());
    } catch (e) {
      if (revision === generation.current) setError(message(e));
    } finally {
      if (revision === generation.current) setLoading(false);
    }
  }, [warehouse]);
  useEffect(() => {
    setSnapshot(null);
    const cached = warehouse ? catalogs.current.get(warehouse) : undefined;
    setMasters(cached ?? {});
    setMastersLoading(Boolean(warehouse) && !cached);
    setSelected({ receipt: "", order: "", return: "" });
    const catalogRevision = ++masterGeneration.current;
    if (!warehouse) return;
    try {
      const saved = JSON.parse(localStorage.getItem(`${storage}:workspace:${warehouse}`) || "null");
      if (saved?.selected) {
        setSelected(saved.selected);
        if (tabs.some(([key]) => key === saved.tab)) setTab(saved.tab);
      }
    } catch {
      /* Invalid optional navigation state is ignored. */
    }
    const route = new URLSearchParams(window.location.search);
    if (!pendingRef.current && route.get("warehouse_id") === warehouse) {
      const requested = route.get("tab") || "";
      const target =
        requested === "inventory" && auditViews.includes(route.get("inventory_view") || "") ? "audit" : requested;
      if (tabs.some(([key]) => key === target)) {
        setTab(target);
        const id = route.get("object_id") || "";
        if (target === "receipts") setSelected((value) => ({ ...value, receipt: id }));
        if (target === "orders") setSelected((value) => ({ ...value, order: id }));
        if (target === "returns") setSelected((value) => ({ ...value, return: id }));
      }
    }
    void refresh();
    let current = true;
    loadCatalog(warehouse)
      .then((catalog) => {
        if (current && catalogRevision === masterGeneration.current) setMasters(catalog);
      })
      .catch((e) => {
        if (current && catalogRevision === masterGeneration.current) setError(message(e));
      })
      .finally(() => {
        if (current && catalogRevision === masterGeneration.current) setMastersLoading(false);
      });
    return () => {
      current = false;
      generation.current++;
      masterGeneration.current++;
    };
  }, [warehouse, refresh, storage, loadCatalog]);
  async function reloadAll() {
    // Keep the current screen while fresh data loads; only the first load of a warehouse shows a placeholder.
    const revision = ++masterGeneration.current;
    await refresh();
    try {
      const [context, catalog] = await Promise.all([api<Runtime>("/api/v2/identity/context"), loadCatalog(warehouse)]);
      if (masterGeneration.current !== revision) return;
      setRuntime(context);
      setMasters(catalog);
      setError("");
    } catch (e) {
      setError(message(e));
    }
  }
  async function transmit(input: Pending) {
    setBusy(true);
    setError("");
    setStatus("처리 중 · 서버의 확정 결과를 기다리고 있습니다.");
    try {
      const response = await api<{ result: Record<string, unknown>; snapshot: Snapshot; replayed: boolean }>(
        "/api/v2/workflow",
        "POST",
        input,
      );
      setSnapshot(response.snapshot);
      setLoadedAt(new Date().toISOString());
      persist(null);
      setStatus(
        response.replayed
          ? "완료 · 이전 요청의 처리 결과를 복구했습니다."
          : ["receipt.create", "order.create", "return.request"].includes(input.command)
            ? "완료 · 등록했습니다. 재고는 아직 바뀌지 않았으며, 아래 「지금 할 일」부터 진행하세요."
            : "완료 · 선택한 수량이 확정되었습니다. 잔량 또는 다음 단계를 선택하세요.",
      );
      return response.result;
    } catch (e) {
      if (e instanceof ApiFailure && e.status < 500 && e.status !== 408 && e.status !== 429) {
        persist(null);
        setStatus("미반영 · 입력값과 최신 잔량을 확인하세요.");
        void refresh();
      } else {
        setStatus("결과 확인 필요 · 연결이 복구되면 원래 요청으로 결과를 조회하세요.");
      }
      setError(message(e));
      return undefined;
    } finally {
      setBusy(false);
      lock.current = false;
    }
  }
  async function run(command: string, payload: Record<string, unknown>) {
    if (terminal.locked) return;
    if (!navigator.onLine) {
      setStatus("미전송 · 온라인 연결이 복구된 후 실물과 잔량을 확인하고 확정하세요.");
      return;
    }
    if (lock.current || pendingRef.current || !snapshot || identity.role === "viewer") return;
    if (localStorage.getItem(`wms-v2:${identity.user.id}:${warehouse}:opening-import`)) {
      setError("외부 개시재고 요청 결과가 아직 확인되지 않았습니다. 기존 창고 전환에서 원래 요청 결과를 복구하세요.");
      return;
    }
    if (command === "shift.close") {
      const prefix = `wms-v2:${identity.user.id}:${warehouse}:csv:`;
      for (let index = 0; index < localStorage.length; index++) {
        if (localStorage.key(index)?.startsWith(prefix)) {
          setError("CSV 적용 결과가 아직 확인되지 않았습니다. 기준정보·CSV에서 이전 적용 결과를 복구한 뒤 마감하세요.");
          return;
        }
      }
    }
    lock.current = true;
    const input = { warehouse_id: warehouse, command, request_id: crypto.randomUUID(), payload };
    try {
      persist(input);
    } catch {
      lock.current = false;
      setError("이 기기에 복구 요청을 저장할 수 없습니다. 브라우저 저장 공간을 확인하세요.");
      return;
    }
    return transmit(input);
  }
  async function recover() {
    const input = pendingRef.current;
    if (!input || busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await api<{ result?: Record<string, unknown>; snapshot?: Snapshot }>(
        `/api/v2/workflow?warehouse_id=${input.warehouse_id}&request_id=${input.request_id}`,
      );
      if (result.result) {
        persist(null);
        setStatus("완료 · 이전 확정의 서버 결과를 확인했습니다.");
        await refresh();
      } else {
        setStatus("서버에서 완료 결과가 확인되지 않았습니다. 같은 내용으로 다시 전송할 수 있습니다.");
      }
    } catch (e) {
      if (e instanceof ApiFailure && e.status === 404)
        setStatus("서버에 아직 완료 결과가 없습니다. 원래 내용으로 다시 전송하세요.");
      else setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  const mastersReady = catalogKinds.every((kind) => Array.isArray(masters[kind]));
  const context: Context | null =
    snapshot && mastersReady && !mastersLoading
      ? {
          warehouse,
          role: identity.role,
          userId: identity.user.id,
          userName: identity.user.name,
          company: identity.tenant.name,
          asOf: loadedAt,
          warehouseName: String(runtime?.warehouses.find((w) => w.id === warehouse)?.name || ""),
          warehouseCode: String(runtime?.warehouses.find((w) => w.id === warehouse)?.code || ""),
          idleLockMinutes: runtime?.idleLockMinutes || 15,
          updateIdlePolicy: (minutes) =>
            setRuntime((current) => (current ? { ...current, idleLockMinutes: minutes } : current)),
          items: masters.items || [],
          locations: masters.locations || [],
          partners: masters.partners || [],
          destinations: masters.destinations || [],
          barcodes: masters.barcodes || [],
          people: [
            ...(runtime?.assignees || []),
            ...(runtime?.environment === "test" && runtime.tenant.isTest ? runtime.automationAccounts || [] : []),
          ],
          snapshot,
          busy: busy || Boolean(pending),
          run,
          refresh,
        }
      : null;
  function navigate(nextTab: string, nextSelected = selected) {
    setTab(nextTab);
    setSelected(nextSelected);
    try {
      localStorage.setItem(
        `${storage}:workspace:${warehouse}`,
        JSON.stringify({ tab: nextTab, selected: nextSelected }),
      );
    } catch {
      /* Request recovery uses separate mandatory durable storage. */
    }
  }
  function open(kind: string, id: string) {
    if (kind === "receipt") navigate("receipts", { ...selected, receipt: id });
    if (kind === "order") navigate("orders", { ...selected, order: id });
    if (kind === "return") navigate("returns", { ...selected, return: id });
    if (kind === "integration") navigate("integration");
    if (kind === "tab") navigate(id);
    if (kind === "new") {
      navigate(id === "order" ? "orders" : "receipts");
      setCompose(id);
    }
  }
  const openCounts = {
    receipts: snapshot?.receipts.filter((row) => !receiptGuide(row).done).length,
    orders: snapshot?.orders.filter((row) => !orderGuide(row, snapshot.packages).done).length,
    returns: snapshot?.returns.filter((row) => !receiptGuide(row).done).length,
    audit: snapshot?.approvals.filter((row) => row.status === "pending").length,
  } as Record<string, number | undefined>;
  if (terminal.locked) return <LockedTerminal error={terminal.error} retry={() => void terminal.logout()} />;
  return (
    <div className="v2 v2-app">
      <nav className="v2-side" aria-label="현장 업무 메뉴">
        <div className="v2-brand">
          <span className="v2-brand-mark" aria-hidden="true">
            W
          </span>
          <div>
            <strong>WMS Lite</strong>
            <h1>현장 운영</h1>
          </div>
        </div>
        {menu.map((section) => (
          <Fragment key={section.group}>
            <p className="v2-side-caption">{section.group}</p>
            <div role="tablist" aria-label={`${section.group} 메뉴`} aria-orientation="vertical" className="v2-tabs">
              {section.tabs
                .filter(([key]) => !["accounts", "cutover"].includes(key) || identity.role === "admin")
                .map(([key, caption]) => (
                  <button role="tab" aria-selected={tab === key} key={key} onClick={() => navigate(key)}>
                    {caption}
                    {openCounts[key] ? (
                      <span className="v2-tab-count" aria-hidden="true">
                        {openCounts[key]}
                      </span>
                    ) : null}
                  </button>
                ))}
            </div>
          </Fragment>
        ))}
        <details className="v2-side-legacy">
          <summary>이전 화면</summary>
          <Link prefetch={false} href="/dashboard">
            업무 홈
          </Link>
          <Link prefetch={false} href="/dashboard/stock">
            재고 조회
          </Link>
          <Link prefetch={false} href="/dashboard/history">
            확정 이력
          </Link>
          {identity.role !== "viewer" && (
            <Link prefetch={false} href="/dashboard/documents">
              기존 전표
            </Link>
          )}
          {identity.role !== "viewer" && (
            <Link prefetch={false} href="/dashboard/delivery-destinations">
              배송지 관리
            </Link>
          )}
          {identity.role === "admin" && (
            <Link prefetch={false} href="/dashboard/audit">
              감사 로그
            </Link>
          )}
        </details>
      </nav>
      <div className="v2-main">
        <header className="v2-context">
          <strong>{identity.tenant.name}</strong>
          <Select
            label="현재 창고"
            value={warehouse}
            options={options(runtime?.warehouses || [])}
            onChange={setWarehouse}
            disabled={Boolean(pending) || busy}
          />
          <span role="status" className="v2-chip" data-tone={online ? "ok" : "bad"}>
            {online ? "● 온라인" : "● 연결 끊김 · 신규 확정 중지"}
          </span>
          <span
            className="v2-chip"
            data-tone={runtime?.tenant.isTest || runtime?.environment === "test" ? "warn" : undefined}
          >
            {runtime ? environments[runtime.environment] || runtime.environment : "환경 확인 중"}
            {runtime?.tenant.isTest ? " · 시험 회사" : ""}
          </span>
          <span className="v2-asof" title={loadedAt ? `${time(loadedAt)} 기준` : undefined}>
            {loadedAt
              ? `${new Date(loadedAt).toLocaleTimeString("ko-KR", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit" })} 기준`
              : "서버 조회 대기"}
          </span>
          <span className="v2-user">
            {roles[identity.role] || identity.role} · {identity.user.name}
          </span>
          <button onClick={() => void reloadAll()} disabled={loading || busy}>
            새로고침
          </button>
          <button className="v2-lock" onClick={terminal.lock}>
            단말 잠금
          </button>
        </header>
        <div className="v2-page">
          {terminal.warning !== null && (
            <div className="v2-alert" role="alert">
              <strong>{terminal.warning}초 후 공용 단말이 자동 잠깁니다.</strong>
              <p>
                회사 정책: {runtime?.idleLockMinutes || 15}분 무활동 후 세션 종료. 진행 중인 확정의 복구 키는
                보존합니다.
              </p>
              <button onClick={terminal.resume}>계속 작업</button>
            </div>
          )}
          {error && (
            <p className="v2-alert" role="alert">
              {error}
            </p>
          )}
          {status && (
            <p className={pending ? "v2-alert" : "v2-success"} role="status">
              {status}
            </p>
          )}
          {pending && (
            <div className="v2-card">
              <h2>확정 결과 복구</h2>
              <p>같은 실물을 새 작업으로 등록하지 마세요. 이 요청의 결과부터 확인합니다.</p>
              <div className="v2-actions">
                <button disabled={busy} onClick={() => void recover()}>
                  원래 확정 결과 조회
                </button>
                <button disabled={busy} onClick={() => void transmit(pending)}>
                  원래 요청 그대로 재전송
                </button>
              </div>
            </div>
          )}
          {(loading && !snapshot) || mastersLoading ? (
            <p role="status">창고의 업무를 불러오고 있습니다…</p>
          ) : !warehouse ? (
            <p className="v2-empty">허용된 창고가 없습니다. 회사 관리자에게 창고 권한을 요청하세요.</p>
          ) : context ? (
            <>
              {tab === "control" && <ControlTower c={context} open={open} />}
              {tab === "queue" && <Queue c={context} open={open} />}
              <div hidden={!["receipts", "orders", "returns"].includes(tab)}>
                <Workflow
                  c={context}
                  kind={tab === "orders" ? "order" : tab === "returns" ? "return" : "receipt"}
                  selected={selected}
                  select={open}
                  compose={compose === (tab === "orders" ? "order" : "receipt") && ["receipts", "orders"].includes(tab)}
                  composed={() => setCompose("")}
                />
              </div>
              {["inventory", "audit", "shift"].includes(tab) && (
                <Inventory
                  key={tab}
                  c={context}
                  shift={tab === "shift"}
                  area={tab === "audit" ? "audit" : "stock"}
                  open={open}
                />
              )}{" "}
              {tab === "masters" && (
                <Masters
                  c={context}
                  reload={async () => {
                    const revision = ++masterGeneration.current;
                    const catalog = await loadCatalog(warehouse);
                    if (revision !== masterGeneration.current) return;
                    setMasters(catalog);
                    await refresh();
                  }}
                />
              )}
              {tab === "accounts" && identity.role === "admin" && (
                <Accounts c={context} warehouses={runtime?.warehouses || []} />
              )}{" "}
              {tab === "integration" && <Integration c={context} />} {tab === "cutover" && <Cutover c={context} />}
            </>
          ) : (
            <p className="v2-empty">업무 데이터를 불러오지 못했습니다. 새로고침으로 다시 확인하세요.</p>
          )}
        </div>
      </div>
    </div>
  );
}
