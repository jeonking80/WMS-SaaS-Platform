import type { Order, Package, Receipt, Stock, WorkflowState } from '../workflow/types';
import { orderGuide, receiptGuide } from './guide';

/** Pure operations analytics shared by the control tower screen and the assistant tools. */
export type DailyOutbound = { item_id: string; day: string; quantity: number };
export type FlowKind = 'receive' | 'putaway' | 'pick' | 'ship';
export type HourlyFlow = { hour: number; flow: FlowKind; quantity: number };
export type ActorActivity = { actor_id: string; actor_name?: string; actions: number; quantity: number };
export type WarehouseInsights = { generated_at: string; window_days: number; daily_outbound: DailyOutbound[]; hourly: HourlyFlow[]; actors: ActorActivity[] };
export type StockRow = Stock & { A?: number; H?: number; locked?: boolean };
export type Forecast = { item_id: string; available: number; on_hand: number; daily_rate: number; days_left: number | null; stockout_date: string | null; suggested_order: number; risk: 'critical' | 'warning' | 'ok' | 'idle' };
export type RiskOrder = { order: Order; due_at: string; hours_left: number; remaining: number; stage: string; next: string; overdue: boolean };
export type Alert = { severity: 'critical' | 'warning' | 'info'; kind: string; title: string; detail: string; target?: { kind: 'order' | 'receipt' | 'tab'; id: string } };

const HOUR = 3_600_000, DAY = 24 * HOUR;
const sum = <T,>(rows: T[], pick: (row: T) => number) => rows.reduce((total, row) => total + pick(row), 0);
const seoulDay = (ms: number) => new Date(ms + 9 * HOUR).toISOString().slice(0, 10);
export const orderRemaining = (order: Order) => sum(order.lines, line => Math.max(0, line.quantity - line.shipped - line.cancelled));
export const receiptRemaining = (receipt: Receipt) => sum(receipt.lines, line => Math.max(0, line.quantity - line.received - line.cancelled));
export const delayedReceipts = (state: Pick<WorkflowState, 'receipts'>, now: string) => state.receipts.filter(receipt => receipt.expected_at && Date.parse(receipt.expected_at) < Date.parse(now) && !receipt.closed && receiptRemaining(receipt) > 0);

/** Open orders due within `hours` (or already overdue), soonest first. */
export function ordersAtRisk(orders: Order[], packages: Package[], now: string, hours = 24): RiskOrder[] {
  const at = Date.parse(now);
  return orders.flatMap(order => {
    const remaining = orderRemaining(order);
    if (!order.due_at || remaining === 0) return [];
    const hoursLeft = (Date.parse(order.due_at) - at) / HOUR;
    if (hoursLeft > hours) return [];
    const guide = orderGuide(order, packages);
    return [{ order, due_at: order.due_at, hours_left: Math.round(hoursLeft * 10) / 10, remaining, stage: guide.stage, next: guide.title, overdue: hoursLeft < 0 }];
  }).sort((a, b) => a.hours_left - b.hours_left || a.order.id.localeCompare(b.order.id));
}

/**
 * Days of cover per item from recent shipments. The daily rate blends the last 7 days (60%) with the
 * whole window (40%) so a recent surge counts without one busy day dominating; suggested order covers
 * lead time plus the target cover days. Shipments only: receipts and internal moves are not demand.
 */
export function forecastStockouts(stock: StockRow[], outbound: DailyOutbound[], options: { now: string; windowDays?: number; leadDays?: number; coverDays?: number }): Forecast[] {
  const { now, windowDays = 28, leadDays = 3, coverDays = 14 } = options, at = Date.parse(now), today = seoulDay(at);
  const recentStart = seoulDay(at - 6 * DAY), windowStart = seoulDay(at - (windowDays - 1) * DAY);
  const ids = new Set([...stock.map(row => row.item_id), ...outbound.map(row => row.item_id)]);
  return [...ids].map(item_id => {
    const rows = outbound.filter(row => row.item_id === item_id && row.day >= windowStart && row.day <= today);
    const recent = sum(rows.filter(row => row.day >= recentStart), row => row.quantity) / 7, whole = sum(rows, row => row.quantity) / windowDays;
    const daily_rate = Math.round((0.6 * recent + 0.4 * whole) * 100) / 100;
    const own = stock.filter(row => row.item_id === item_id), available = sum(own, row => Number(row.A ?? 0)), on_hand = sum(own, row => Number(row.H ?? row.S + row.P + row.Q + row.B));
    if (daily_rate <= 0) return { item_id, available, on_hand, daily_rate: 0, days_left: null, stockout_date: null, suggested_order: 0, risk: 'idle' as const };
    const days_left = Math.floor((available / daily_rate) * 10) / 10;
    return { item_id, available, on_hand, daily_rate, days_left, stockout_date: seoulDay(at + days_left * DAY), suggested_order: Math.max(0, Math.ceil(daily_rate * (leadDays + coverDays) - available)), risk: days_left <= leadDays ? 'critical' as const : days_left <= leadDays + 7 ? 'warning' as const : 'ok' as const };
  }).sort((a, b) => (a.days_left ?? Infinity) - (b.days_left ?? Infinity) || b.daily_rate - a.daily_rate || a.item_id.localeCompare(b.item_id));
}

export type Overview = { open_receipts: number; delayed_receipts: number; open_orders: number; due_today: number; overdue_orders: number; pending_approvals: number; hold_quantity: number; blocked_locations: number; counting_locations: number; reconciled: boolean | null };
export function operationsOverview(state: WorkflowState & { reconciliation?: { ok?: boolean } }, now: string): Overview {
  const risk = ordersAtRisk(state.orders, state.packages, now, 24);
  return {
    open_receipts: state.receipts.filter(row => !receiptGuide(row).done).length,
    delayed_receipts: delayedReceipts(state, now).length,
    open_orders: state.orders.filter(row => orderRemaining(row) > 0).length,
    due_today: risk.filter(row => !row.overdue).length,
    overdue_orders: risk.filter(row => row.overdue).length,
    pending_approvals: state.approvals.filter(row => row.status === 'pending').length,
    hold_quantity: sum(state.stock, row => row.B),
    blocked_locations: new Set((state.location_blocks ?? []).map(row => row.location_id)).size,
    counting_locations: state.counts.filter(row => ['counting', 'submitted'].includes(row.status)).length,
    reconciled: state.reconciliation ? state.reconciliation.ok !== false : null,
  };
}

/** Exceptions an operator should act on, most severe first. `label` resolves ids for display. */
export function operationsAlerts(state: WorkflowState & { reconciliation?: { ok?: boolean } }, now: string, forecasts: Forecast[], label: { order: (order: Order) => string; receipt: (receipt: Receipt) => string; item: (id: string) => string }): Alert[] {
  const alerts: Alert[] = [];
  if (state.reconciliation && state.reconciliation.ok === false) alerts.push({ severity: 'critical', kind: 'reconciliation', title: '현재고와 원장이 맞지 않습니다', detail: '재고·실사·승인에서 대사 결과를 확인하고 원인을 조사하세요.', target: { kind: 'tab', id: 'inventory' } });
  for (const risk of ordersAtRisk(state.orders, state.packages, now, 4)) alerts.push({ severity: risk.overdue ? 'critical' : 'warning', kind: 'due', title: `${label.order(risk.order)} ${risk.overdue ? `납기 ${Math.abs(Math.round(risk.hours_left))}시간 초과` : `납기 ${Math.max(0, Math.round(risk.hours_left))}시간 이내`}`, detail: `미출하 ${risk.remaining} EA · 지금 단계: ${risk.next}`, target: { kind: 'order', id: risk.order.id } });
  for (const forecast of forecasts.filter(row => row.risk === 'critical')) alerts.push({ severity: forecast.available === 0 ? 'critical' : 'warning', kind: 'stockout', title: `${label.item(forecast.item_id)} ${forecast.available === 0 ? '가용재고 없음' : `약 ${forecast.days_left}일 후 품절 예상`}`, detail: `하루 평균 ${forecast.daily_rate} EA 출고 · 권장 발주 ${forecast.suggested_order} EA`, target: { kind: 'tab', id: 'inventory' } });
  for (const receipt of delayedReceipts(state, now)) alerts.push({ severity: 'warning', kind: 'receipt', title: `${label.receipt(receipt)} 입고 지연`, detail: `미수령 ${receiptRemaining(receipt)} EA · 공급처 도착 여부를 확인하세요.`, target: { kind: 'receipt', id: receipt.id } });
  const approvals = state.approvals.filter(row => row.status === 'pending').length;
  if (approvals) alerts.push({ severity: 'info', kind: 'approval', title: `승인 대기 ${approvals}건`, detail: '과납 인수·잔량 마감·실사 조정은 승인 전까지 재고에 반영되지 않습니다.', target: { kind: 'tab', id: 'inventory' } });
  const blocked = new Set((state.location_blocks ?? []).map(row => row.location_id)).size;
  if (blocked) alerts.push({ severity: 'warning', kind: 'blocked', title: `신규 예약 차단 위치 ${blocked}곳`, detail: '피킹 중 실물 부족이 보고된 위치입니다. 실사로 수량을 확정하세요.', target: { kind: 'tab', id: 'inventory' } });
  const rank = { critical: 0, warning: 1, info: 2 };
  return alerts.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

export type ZoneCell = { location_id: string; kind: string; on_hand: number; available: number; reserved: number; hold: number; state: 'empty' | 'stocked' | 'reserved' | 'hold' | 'locked' | 'blocked' };
/** Location tiles grouped by work zone for the warehouse map. */
export function zoneMap(locations: { id: string; kind?: unknown; code?: unknown; active?: boolean }[], state: Pick<WorkflowState, 'counts' | 'location_blocks'> & { stock: StockRow[] }): Record<string, ZoneCell[]> {
  const counting = new Set(state.counts.filter(row => ['counting', 'submitted'].includes(row.status)).map(row => row.location_id)), blocked = new Set((state.location_blocks ?? []).map(row => row.location_id));
  const zones: Record<string, ZoneCell[]> = {};
  for (const location of locations.filter(row => row.active !== false).toSorted((a, b) => String(a.code ?? '').localeCompare(String(b.code ?? '')) || a.id.localeCompare(b.id))) {
    const kind = String(location.kind || 'STORAGE'), rows = state.stock.filter(row => row.location_id === location.id);
    const on_hand = sum(rows, row => Number(row.H ?? row.S + row.P + row.Q + row.B)), reserved = sum(rows, row => row.R), hold = sum(rows, row => row.B);
    const cellState = counting.has(location.id) ? 'locked' : blocked.has(location.id) ? 'blocked' : on_hand === 0 ? 'empty' : hold > 0 && hold === on_hand ? 'hold' : reserved > 0 ? 'reserved' : 'stocked';
    (zones[kind] ??= []).push({ location_id: location.id, kind, on_hand, available: sum(rows, row => Number(row.A ?? 0)), reserved, hold, state: cellState });
  }
  return zones;
}
