"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Order, Receipt } from "@/server/v2/workflow/types";
import {
  forecastStockouts,
  operationsAlerts,
  operationsOverview,
  ordersAtRisk,
  zoneMap,
  type FlowKind,
  type WarehouseInsights,
} from "@/server/v2/insights/analytics";
import { api, ApiFailure, message, nameOf, Note, time, type Context } from "./common";
type Open = (kind: string, id: string) => void;
const flows: [FlowKind, string][] = [
  ["receive", "입고 수령"],
  ["putaway", "적치"],
  ["pick", "피킹"],
  ["ship", "출하"],
];
const zones: [string, string][] = [
  ["RECEIVING", "수령·검수 대기"],
  ["STORAGE", "보관"],
  ["STAGING", "피킹·포장 대기"],
  ["SHIPPING", "출하 대기"],
  ["HOLD", "보류"],
];
const cellStates: Record<string, string> = {
  empty: "비어 있음",
  stocked: "재고 있음",
  reserved: "예약 있음",
  hold: "보류만 있음",
  locked: "실사 잠금",
  blocked: "예약 차단",
};
const riskNames = { critical: "긴급", warning: "주의", ok: "여유", idle: "출고 없음" };
const severityNames = { critical: "긴급", warning: "주의", info: "확인" };
export const orderTitle = (c: Context, order: Order) =>
  order.external_id || `주문 ${String(c.snapshot.orders.indexOf(order) + 1).padStart(4, "0")}`;
export const receiptTitle = (c: Context, receipt: Receipt) =>
  receipt.external_id || `입고 ${String(c.snapshot.receipts.indexOf(receipt) + 1).padStart(4, "0")}`;
export function ControlTower({ c, open }: { c: Context; open: Open }) {
  const [insights, setInsights] = useState<WarehouseInsights | null>(null),
    [insightError, setInsightError] = useState("");
  useEffect(() => {
    let active = true;
    setInsightError("");
    api<WarehouseInsights>(`/api/v2/insights?warehouse_id=${encodeURIComponent(c.warehouse)}`)
      .then((data) => {
        if (active) setInsights(data);
      })
      .catch((e) => {
        if (active) setInsightError(message(e));
      });
    return () => {
      active = false;
    };
  }, [c.warehouse, c.asOf]);
  const s = c.snapshot,
    now = c.asOf,
    item = (id: string) => nameOf(c.items, id);
  const forecasts = useMemo(
    () => (insights ? forecastStockouts(s.stock, insights.daily_outbound, { now }) : []),
    [insights, s.stock, now],
  );
  const overview = operationsOverview(s, now),
    risks = ordersAtRisk(s.orders, s.packages, now, 24),
    alerts = operationsAlerts(s, now, forecasts, {
      order: (order) => orderTitle(c, order),
      receipt: (receipt) => receiptTitle(c, receipt),
      item,
    }),
    map = zoneMap(c.locations, s);
  const tiles: [string, number | string, string, string, boolean][] = [
    ["진행 중 입고", overview.open_receipts, "receipts", "건", false],
    ["입고 지연", overview.delayed_receipts, "receipts", "건", overview.delayed_receipts > 0],
    ["진행 중 주문", overview.open_orders, "orders", "건", false],
    ["오늘 납기", overview.due_today, "orders", "건", false],
    ["납기 초과", overview.overdue_orders, "orders", "건", overview.overdue_orders > 0],
    ["승인 대기", overview.pending_approvals, "inventory", "건", overview.pending_approvals > 0],
    ["보류 수량", overview.hold_quantity, "inventory", "EA", false],
    [
      "재고 대사",
      overview.reconciled === null ? "확인 중" : overview.reconciled ? "일치" : "불일치",
      "inventory",
      "",
      overview.reconciled === false,
    ],
  ];
  const go = (target?: { kind: string; id: string }) => {
    if (!target) return;
    if (target.kind === "tab") open("tab", target.id);
    else open(target.kind, target.id);
  };
  return (
    <div className="v2-control">
      <div className="v2-control-head">
        <div>
          <h2>운영 관제</h2>
          <Note>
            {time(now)} 기준 · 창고 {c.warehouseName || c.warehouseCode}. 숫자와 경고를 누르면 처리 화면으로 이동합니다.
          </Note>
        </div>
      </div>
      <div className="v2-kpis">
        {tiles.map(([title, value, tab, unit, hot]) => (
          <button key={title} className="v2-kpi" data-hot={hot} onClick={() => open("tab", tab)}>
            <span>{title}</span>
            <strong>
              {value}
              {unit && typeof value === "number" ? <small> {unit}</small> : null}
            </strong>
          </button>
        ))}
      </div>
      <div className="v2-control-grid">
        <section className="v2-card">
          <h2>조치 필요 · {alerts.length}건</h2>
          {insightError && (
            <p className="v2-alert" role="alert">
              출고 이력을 불러오지 못해 품절 예측을 제외했습니다. {insightError}
            </p>
          )}
          <ul className="v2-alerts">
            {alerts.map((alert, index) => (
              <li key={`${alert.kind}-${index}`} data-severity={alert.severity}>
                <span className="v2-severity">{severityNames[alert.severity]}</span>
                <div>
                  <strong>{alert.title}</strong>
                  <small>{alert.detail}</small>
                </div>
                {alert.target && <button onClick={() => go(alert.target)}>열기</button>}
              </li>
            ))}
          </ul>
          {!alerts.length && <p className="v2-empty">지금 조치할 경고가 없습니다.</p>}
        </section>
        <Assistant c={c} />
      </div>
      <section className="v2-card">
        <h2>오늘 처리량 (한국 시간)</h2>
        <Note>원장에 기록된 실물 이동 수량입니다. 막대에 마우스를 올리면 시간대별 수량이 보입니다.</Note>
        {insights ? (
          <>
            <div className="v2-flowcharts">
              {flows.map(([flow, title], index) => {
                const values = Array.from({ length: 24 }, (_, hour) =>
                  insights.hourly
                    .filter((row) => row.flow === flow && row.hour === hour)
                    .reduce((sum, row) => sum + row.quantity, 0),
                );
                return <FlowChart key={flow} title={title} values={values} series={index + 1} />;
              })}
            </div>
            {insights.actors.length > 0 && (
              <div className="v2-table">
                <table>
                  <thead>
                    <tr>
                      <th>작업자 (오늘)</th>
                      <th>처리 건수</th>
                      <th>실물 이동 수량</th>
                    </tr>
                  </thead>
                  <tbody>
                    {insights.actors.map((actor) => (
                      <tr key={actor.actor_id}>
                        <td>{actor.actor_name || (actor.actor_id.startsWith("machine:") ? "자동 작업" : "작업자")}</td>
                        <td>{actor.actions}건</td>
                        <td>{actor.quantity} EA</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        ) : (
          <p className="v2-empty">{insightError ? "처리량을 불러오지 못했습니다." : "처리량을 불러오고 있습니다…"}</p>
        )}
      </section>
      <section className="v2-card">
        <h2>납기 위험 주문 · 24시간 이내 {risks.length}건</h2>
        {risks.length ? (
          <div className="v2-table">
            <table>
              <thead>
                <tr>
                  <th>주문</th>
                  <th>납기</th>
                  <th>남은 시간</th>
                  <th>미출하</th>
                  <th>지금 단계</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {risks.map((risk) => (
                  <tr key={risk.order.id} data-overdue={risk.overdue}>
                    <td>{orderTitle(c, risk.order)}</td>
                    <td>{time(risk.due_at)}</td>
                    <td className={risk.overdue ? "v2-danger" : ""}>
                      {risk.overdue ? `${Math.abs(risk.hours_left)}시간 초과` : `${risk.hours_left}시간`}
                    </td>
                    <td>{risk.remaining} EA</td>
                    <td>{risk.next}</td>
                    <td>
                      <button onClick={() => open("order", risk.order.id)}>열기</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="v2-empty">24시간 안에 납기가 돌아오는 미출하 주문이 없습니다.</p>
        )}
      </section>
      <section className="v2-card">
        <h2>품절 예측</h2>
        <Note>
          최근 {insights?.window_days ?? 28}일 출하량으로 하루 평균을 계산합니다(최근 7일 60% + 전체 40%). 권장 발주는
          조달 3일과 안전 재고 14일을 기준으로 합니다.
        </Note>
        {forecasts.some((row) => row.risk !== "idle") ? (
          <div className="v2-table">
            <table>
              <thead>
                <tr>
                  <th>품목</th>
                  <th>가용</th>
                  <th>하루 평균 출고</th>
                  <th>남은 일수</th>
                  <th>예상 품절일</th>
                  <th>권장 발주</th>
                  <th>위험</th>
                </tr>
              </thead>
              <tbody>
                {forecasts
                  .filter((row) => row.risk !== "idle")
                  .slice(0, 15)
                  .map((row) => (
                    <tr key={row.item_id}>
                      <td>{item(row.item_id)}</td>
                      <td>{row.available} EA</td>
                      <td>{row.daily_rate} EA</td>
                      <td>{row.days_left}일</td>
                      <td>{row.stockout_date}</td>
                      <td>{row.suggested_order} EA</td>
                      <td>
                        <span className="v2-risk" data-risk={row.risk}>
                          {riskNames[row.risk]}
                        </span>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="v2-empty">
            {insights ? "최근 출하 기록이 없어 예측할 품목이 없습니다." : "출하 이력을 불러오고 있습니다…"}
          </p>
        )}
      </section>
      <section className="v2-card">
        <h2>창고 배치도</h2>
        <Note>위치를 작업 구역별로 묶었습니다. 칸의 숫자는 총 실물(EA)입니다.</Note>
        <ul className="v2-legend" aria-label="위치 상태 범례">
          {Object.entries(cellStates).map(([key, caption]) => (
            <li key={key}>
              <i data-state={key} />
              {caption}
            </li>
          ))}
        </ul>
        <div className="v2-zones">
          {zones
            .filter(([kind]) => map[kind]?.length)
            .map(([kind, title]) => (
              <div key={kind} className="v2-zone">
                <h3>
                  {title} <small>{map[kind].length}곳</small>
                </h3>
                <div className="v2-cells">
                  {map[kind].map((cell) => (
                    <div
                      key={cell.location_id}
                      className="v2-cell"
                      data-state={cell.state}
                      title={`${nameOf(c.locations, cell.location_id)} · ${cellStates[cell.state]} · 실물 ${cell.on_hand} / 가용 ${cell.available} / 예약 ${cell.reserved} / 보류 ${cell.hold} EA`}
                    >
                      <span>{String(c.locations.find((row) => row.id === cell.location_id)?.code || "")}</span>
                      <strong>{cell.on_hand}</strong>
                    </div>
                  ))}
                </div>
              </div>
            ))}
        </div>
        {!Object.keys(map).length && (
          <p className="v2-empty">등록된 위치가 없습니다. 기준정보·CSV에서 위치를 등록하세요.</p>
        )}
      </section>
    </div>
  );
}
function FlowChart({ title, values, series }: { title: string; values: number[]; series: number }) {
  const [hover, setHover] = useState<number | null>(null),
    max = Math.max(1, ...values),
    total = values.reduce((sum, value) => sum + value, 0),
    width = 24 * 10,
    height = 72;
  return (
    <figure className="v2-flowchart" style={{ ["--flow-color" as string]: `var(--v2-series-${series})` }}>
      <figcaption>
        <span>{title}</span>
        <strong>{total} EA</strong>
      </figcaption>
      <svg
        viewBox={`0 0 ${width} ${height + 14}`}
        role="img"
        aria-label={`${title} 시간대별 수량, 합계 ${total} EA`}
        onMouseLeave={() => setHover(null)}
      >
        <line x1="0" x2={width} y1={height} y2={height} className="v2-axis" />
        {values.map((value, hour) => {
          const h = value ? Math.max(3, (value / max) * (height - 6)) : 0;
          return (
            <g key={hour} onMouseEnter={() => setHover(hour)}>
              <rect x={hour * 10} y="0" width="10" height={height} fill="transparent" />
              {h > 0 && (
                <path
                  d={`M${hour * 10 + 1},${height} v${-(h - 2)} q0,-2 2,-2 h4 q2,0 2,2 v${h - 2} z`}
                  className="v2-bar"
                  data-active={hover === hour}
                />
              )}
            </g>
          );
        })}
        {[0, 6, 12, 18, 23].map((hour) => (
          <text key={hour} x={hour * 10 + 5} y={height + 12} textAnchor="middle" className="v2-tick">
            {hour}시
          </text>
        ))}
      </svg>
      <small className="v2-flowchart-tip">
        {hover === null ? "시간대에 마우스를 올리세요" : `${hover}시 · ${values[hover]} EA`}
      </small>
    </figure>
  );
}
type Chat = { role: "user" | "assistant"; content: string; tools?: string[] };
const quick: [string, string, Record<string, unknown>][] = [
  ["오늘 납기 위험 주문 알려줘", "list_orders_at_risk", { hours: 24 }],
  ["곧 품절될 품목은?", "forecast_stockouts", { limit: 10 }],
  ["입고가 늦어진 건은?", "list_open_receipts", { only_delayed: true }],
  ["승인 대기 목록", "list_pending_approvals", {}],
  ["오늘 처리량 요약", "get_today_throughput", {}],
];
const toolNames: Record<string, string> = {
  get_operations_overview: "운영 현황",
  list_orders_at_risk: "납기 위험 주문",
  find_item_stock: "품목 재고",
  list_open_receipts: "입고 현황",
  list_pending_approvals: "승인 대기",
  forecast_stockouts: "품절 예측",
  get_today_throughput: "오늘 처리량",
};
/** Turns a direct tool result into short Korean lines when no model key is configured. */
export function summarize(tool: string, result: Record<string, unknown>): string {
  const rows = (key: string) => (Array.isArray(result[key]) ? (result[key] as Record<string, unknown>[]) : []);
  const lines = (list: Record<string, unknown>[], empty: string, line: (row: Record<string, unknown>) => string) =>
    list.length
      ? list
          .slice(0, 10)
          .map((row) => `• ${line(row)}`)
          .join("\n") + (list.length > 10 ? `\n외 ${list.length - 10}건` : "")
      : empty;
  if (tool === "list_orders_at_risk")
    return lines(
      rows("orders"),
      "24시간 안에 납기가 돌아오는 미출하 주문이 없습니다.",
      (row) =>
        `${row.order}: ${row.overdue ? `납기 ${Math.abs(Number(row.hours_left))}시간 초과` : `${row.hours_left}시간 남음`}, 미출하 ${row.remaining_ea} EA, 지금 단계 ${row.next_step}`,
    );
  if (tool === "forecast_stockouts")
    return lines(
      rows("items"),
      "최근 출하 기록이 있는 품목이 없어 예측할 수 없습니다.",
      (row) =>
        `${row.item}: 가용 ${row.available_ea} EA, 하루 ${row.daily_rate_ea} EA 출고, 약 ${row.days_left}일 후(${row.stockout_date}) 품절 예상, 권장 발주 ${row.suggested_order_ea} EA`,
    );
  if (tool === "list_open_receipts")
    return lines(
      rows("receipts"),
      "늦어진 입고가 없습니다.",
      (row) => `${row.receipt}: 예정 ${row.expected_at}, 미수령 ${row.not_received_ea} EA, ${row.next_step}`,
    );
  if (tool === "list_pending_approvals")
    return lines(
      rows("approvals"),
      "승인 대기 건이 없습니다.",
      (row) => `${row.type} ${row.quantity_ea} EA · 요청자 ${row.requester} · 사유: ${row.reason}`,
    );
  if (tool === "get_today_throughput") {
    const totals = Object.entries((result.totals_ea || {}) as Record<string, number>);
    return totals.length
      ? `오늘 처리량: ${totals.map(([name, value]) => `${name} ${value} EA`).join(", ")}\n` +
          lines(rows("workers"), "", (row) => `${row.worker}: ${row.actions}건, ${row.quantity_ea} EA`)
      : "오늘 기록된 실물 이동이 없습니다.";
  }
  return JSON.stringify(result);
}
export function Assistant({ c }: { c: Context }) {
  const [chat, setChat] = useState<Chat[]>([]),
    [question, setQuestion] = useState(""),
    [busy, setBusy] = useState(false),
    [configured, setConfigured] = useState<boolean | null>(null),
    [error, setError] = useState(""),
    log = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setChat([]);
    setError("");
  }, [c.warehouse]);
  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight });
  }, [chat, busy]);
  async function direct(text: string, tool: string, input: Record<string, unknown>) {
    const data = await api<{ result: Record<string, unknown> }>("/api/v2/assistant", "POST", {
      warehouse_id: c.warehouse,
      tool,
      input,
    });
    setChat((value) => [
      ...value,
      { role: "user", content: text },
      { role: "assistant", content: summarize(tool, data.result), tools: [tool] },
    ]);
  }
  async function ask(text: string, fallback?: [string, Record<string, unknown>]) {
    const value = text.trim();
    if (!value || busy) return;
    setBusy(true);
    setError("");
    try {
      if (configured === false && fallback) {
        await direct(value, ...fallback);
        return;
      }
      const data = await api<{ answer: string; tools_used: string[] }>("/api/v2/assistant", "POST", {
        warehouse_id: c.warehouse,
        question: value,
        history: chat.map(({ role, content }) => ({ role, content })),
      });
      setConfigured(true);
      setQuestion("");
      setChat((history) => [
        ...history,
        { role: "user", content: value },
        { role: "assistant", content: data.answer, tools: data.tools_used },
      ]);
    } catch (e) {
      if (e instanceof ApiFailure && e.code === "ASSISTANT_UNCONFIGURED") {
        setConfigured(false);
        if (fallback) {
          try {
            await direct(value, ...fallback);
          } catch (inner) {
            setError(message(inner));
          }
        } else setError("AI 연결이 설정되지 않아 자유 질문은 쓸 수 없습니다. 아래 빠른 질문을 사용하세요.");
      } else setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="v2-card v2-assistant">
      <h2>AI 운영 도우미</h2>
      <Note>
        {configured === false
          ? "AI 연결(ANTHROPIC_API_KEY)이 없어 빠른 질문만 시스템 조회로 바로 답합니다."
          : "현재 창고 데이터를 조회해서 답합니다. 조회만 하며 재고·업무는 바꾸지 않습니다. 대화는 이 화면에만 있고 저장되지 않습니다."}
      </Note>
      <div className="v2-chat" ref={log} aria-live="polite">
        {!chat.length && <p className="v2-note">예: “포장 테이프 재고 어디 있어?”, “오늘 납기 놓칠 주문 있어?”</p>}
        {chat.map((turn, index) => (
          <div key={index} className="v2-turn" data-role={turn.role}>
            <p>{turn.content}</p>
            {turn.tools?.length ? (
              <small>조회: {[...new Set(turn.tools)].map((name) => toolNames[name] || name).join(", ")}</small>
            ) : null}
          </div>
        ))}
        {busy && (
          <div className="v2-turn" data-role="assistant">
            <p>조회하고 있습니다…</p>
          </div>
        )}
      </div>
      {error && (
        <p className="v2-alert" role="alert">
          {error}
        </p>
      )}
      <div className="v2-actions v2-quick">
        {quick.map(([text, tool, input]) => (
          <button key={tool} type="button" disabled={busy} onClick={() => void ask(text, [tool, input])}>
            {text}
          </button>
        ))}
      </div>
      <form
        className="v2-ask"
        onSubmit={(e) => {
          e.preventDefault();
          void ask(question);
        }}
      >
        <input
          aria-label="도우미에게 질문"
          value={question}
          maxLength={1000}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder={configured === false ? "AI 연결 후 자유 질문을 쓸 수 있습니다" : "창고 운영에 대해 질문하세요"}
          disabled={busy || configured === false}
        />
        <button className="v2-primary" type="submit" disabled={busy || configured === false || !question.trim()}>
          질문
        </button>
      </form>
    </section>
  );
}
