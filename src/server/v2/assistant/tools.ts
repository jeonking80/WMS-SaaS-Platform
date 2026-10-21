import type Anthropic from '@anthropic-ai/sdk';
import type { Order, Receipt, WorkflowState } from '../workflow/types';
import { forecastStockouts, operationsAlerts, operationsOverview, ordersAtRisk, delayedReceipts, receiptRemaining, type StockRow, type WarehouseInsights } from '../insights/analytics';
import { receiptGuide } from '../insights/guide';

/** Read-only tools: every result is computed from data the caller is already authorized to read. */
export type MasterRow = { id: string; code?: string; name?: string; kind?: string; search_terms?: string; active?: boolean };
export type AssistantData = { state: Omit<WorkflowState, 'stock'> & { stock: StockRow[]; reconciliation?: { ok?: boolean } }; items: MasterRow[]; locations: MasterRow[]; now: string; insights: () => Promise<WarehouseInsights> };

const schema = (properties: Record<string, unknown>) => ({ type: 'object' as const, properties, required: Object.keys(properties), additionalProperties: false });
export const assistantTools: Anthropic.Beta.BetaTool[] = [
  { name: 'get_operations_overview', description: 'Current warehouse status: open/delayed receipts, open/overdue orders, pending approvals, hold quantity, blocked or counting locations, reconciliation, and the alert list an operator should act on.', input_schema: schema({}), strict: true },
  { name: 'list_orders_at_risk', description: 'Open outbound orders due within the given number of hours (overdue included), soonest first, with the remaining quantity and the next work step.', input_schema: schema({ hours: { type: 'integer', description: 'Look-ahead window in hours, 1-168. Use 24 for "today".' } }), strict: true },
  { name: 'find_item_stock', description: 'Find items by code or name and return stock per location: S normal storage, A available, R reserved, P picked/staged, Q waiting inspection or putaway, B hold.', input_schema: schema({ query: { type: 'string', description: 'Item code or part of the item name.' } }), strict: true },
  { name: 'list_open_receipts', description: 'Open inbound receipts with expected time, quantity not yet received, and the next work step.', input_schema: schema({ only_delayed: { type: 'boolean', description: 'true to return only receipts past their expected time.' } }), strict: true },
  { name: 'list_pending_approvals', description: 'Approval requests waiting for a different approver (overage acceptance, receipt remainder close, count adjustment, correction).', input_schema: schema({}), strict: true },
  { name: 'forecast_stockouts', description: 'Days of cover per item from the last 28 days of shipments, expected stockout date, risk level and suggested order quantity (3 lead days + 14 cover days).', input_schema: schema({ limit: { type: 'integer', description: 'Maximum items to return, 1-50, highest risk first.' } }), strict: true },
  { name: 'get_today_throughput', description: 'Today (Korea time) processed quantity by hour for receive, putaway, pick and ship, plus actions per worker.', input_schema: schema({}), strict: true },
];
export const assistantToolNames = assistantTools.map(tool => tool.name);

const clamp = (value: unknown, min: number, max: number, fallback: number) => Number.isInteger(value) ? Math.min(max, Math.max(min, value as number)) : fallback;
const korea = (value?: string) => value ? new Date(value).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }) : null;
function labels(data: AssistantData) {
  const named = (rows: MasterRow[], id: string) => { const row = rows.find(entry => entry.id === id); return row ? `${row.code ? row.code + ' · ' : ''}${row.name || row.code}` : '삭제된 항목'; };
  const order = (row: Order) => row.external_id || `주문 ${String(data.state.orders.indexOf(row) + 1).padStart(4, '0')}`;
  const receipt = (row: Receipt) => row.external_id || `입고 ${String(data.state.receipts.indexOf(row) + 1).padStart(4, '0')}`;
  return { item: (id: string) => named(data.items, id), location: (id: string) => named(data.locations, id), order, receipt };
}
const approvalTypes: Record<string, string> = { overage: '과납 인수', 'receipt.close': '입고 잔량 마감', count: '실사 차이 조정', correction: '실적 정정' };
const flowNames: Record<string, string> = { receive: '입고 수령', putaway: '적치', pick: '피킹', ship: '출하' };

export async function runAssistantTool(name: string, input: Record<string, unknown>, data: AssistantData): Promise<unknown> {
  const label = labels(data), { state, now } = data;
  switch (name) {
    case 'get_operations_overview': {
      const forecasts = forecastStockouts(state.stock, (await data.insights()).daily_outbound, { now });
      return { as_of: korea(now), overview: operationsOverview(state, now), alerts: operationsAlerts(state, now, forecasts, label).slice(0, 15).map(({ severity, title, detail }) => ({ severity, title, detail })) };
    }
    case 'list_orders_at_risk': {
      const hours = clamp(input.hours, 1, 168, 24);
      return { as_of: korea(now), hours, orders: ordersAtRisk(state.orders, state.packages, now, hours).slice(0, 30).map(risk => ({ order: label.order(risk.order), due_at: korea(risk.due_at), hours_left: risk.hours_left, overdue: risk.overdue, remaining_ea: risk.remaining, next_step: risk.next, items: risk.order.lines.map(line => label.item(line.item_id)) })) };
    }
    case 'find_item_stock': {
      const query = String(input.query ?? '').trim().toLocaleLowerCase();
      if (!query) return { error: '품목 코드나 이름을 알려주세요.' };
      const items = data.items.filter(item => [item.code, item.name, item.search_terms].some(value => String(value ?? '').toLocaleLowerCase().includes(query))).slice(0, 10);
      return { query, items: items.map(item => { const rows = state.stock.filter(row => row.item_id === item.id); return { item: label.item(item.id), active: item.active !== false, total_on_hand_ea: rows.reduce((sum, row) => sum + row.S + row.P + row.Q + row.B, 0), total_available_ea: rows.reduce((sum, row) => sum + Number(row.A ?? 0), 0), locations: rows.filter(row => row.S + row.R + row.P + row.Q + row.B > 0).map(row => ({ location: label.location(row.location_id), S: row.S, A: Number(row.A ?? 0), R: row.R, P: row.P, Q: row.Q, B: row.B, locked: Boolean(row.locked) })) }; }) };
    }
    case 'list_open_receipts': {
      const delayed = new Set(delayedReceipts(state, now).map(row => row.id));
      return { as_of: korea(now), receipts: state.receipts.filter(row => !receiptGuide(row).done && (!input.only_delayed || delayed.has(row.id))).slice(0, 30).map(row => ({ receipt: label.receipt(row), expected_at: korea(row.expected_at), delayed: delayed.has(row.id), not_received_ea: receiptRemaining(row), next_step: receiptGuide(row).title, items: row.lines.map(line => label.item(line.item_id)) })) };
    }
    case 'list_pending_approvals':
      return { approvals: state.approvals.filter(row => row.status === 'pending').map(row => ({ type: approvalTypes[row.type] ?? row.type, quantity_ea: row.quantity, reason: row.reason, requester: row.requester_name ?? '요청자', requested_at: korea(row.requested_at) })) };
    case 'forecast_stockouts': {
      const insights = await data.insights();
      return { as_of: korea(now), window_days: insights.window_days, items: forecastStockouts(state.stock, insights.daily_outbound, { now }).filter(row => row.risk !== 'idle').slice(0, clamp(input.limit, 1, 50, 10)).map(row => ({ item: label.item(row.item_id), available_ea: row.available, daily_rate_ea: row.daily_rate, days_left: row.days_left, stockout_date: row.stockout_date, risk: row.risk, suggested_order_ea: row.suggested_order })) };
    }
    case 'get_today_throughput': {
      const insights = await data.insights(), totals: Record<string, number> = {};
      for (const row of insights.hourly) totals[flowNames[row.flow]] = (totals[flowNames[row.flow]] ?? 0) + row.quantity;
      return { as_of: korea(now), totals_ea: totals, by_hour: insights.hourly.map(row => ({ hour: row.hour, flow: flowNames[row.flow], quantity_ea: row.quantity })), workers: insights.actors.map(row => ({ worker: row.actor_name ?? (row.actor_id.startsWith('machine:') ? '자동 작업' : '작업자'), actions: row.actions, quantity_ea: row.quantity })) };
    }
    default:
      return { error: `지원하지 않는 조회입니다: ${name}` };
  }
}
