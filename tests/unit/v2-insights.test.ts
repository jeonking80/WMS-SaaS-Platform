import { describe, expect, it } from 'vitest';
import { forecastStockouts, operationsAlerts, operationsOverview, ordersAtRisk, zoneMap, type StockRow } from '../../src/server/v2/insights/analytics';
import { emptyState, type Order } from '../../src/server/v2/workflow/types';

const now = '2026-10-21T03:00:00.000Z'; // 12:00 Korea time
const stock = (item_id: string, location_id: string, S: number, R = 0, extra: Partial<StockRow> = {}): StockRow => ({ item_id, location_id, S, R, P: 0, Q: 0, B: 0, A: S - R, H: S, ...extra });
const order = (id: string, due_at: string | undefined, quantity: number, shipped = 0): Order => ({ id, version: 1, lines: [{ id: `${id}-l`, item_id: 'tape', quantity, received: 0, cancelled: 0, shipped }], reservations: [], picks: [], delivery: {}, due_at, created_at: '2026-10-20T00:00:00.000Z' });
const labels = { order: (row: Order) => row.id, receipt: (row: { id: string }) => row.id, item: (id: string) => id };

describe('stockout forecast', () => {
  it('blends the last week with the 28-day window and suggests lead time plus cover', () => {
    const outbound = [{ item_id: 'tape', day: '2026-10-21', quantity: 70 }, { item_id: 'tape', day: '2026-10-01', quantity: 70 }];
    const [tape] = forecastStockouts([stock('tape', 'a', 30)], outbound, { now });
    // recent 70/7=10, window 140/28=5 → 0.6*10+0.4*5 = 8 EA/day
    expect(tape).toMatchObject({ daily_rate: 8, available: 30, days_left: 3.7, stockout_date: '2026-10-25', suggested_order: 106, risk: 'warning' });
  });

  it('marks zero available stock with demand as critical and items without shipments as idle', () => {
    const rows = forecastStockouts([stock('box', 'a', 5, 5), stock('idle', 'a', 9)], [{ item_id: 'box', day: '2026-10-20', quantity: 14 }], { now });
    expect(rows[0]).toMatchObject({ item_id: 'box', available: 0, days_left: 0, risk: 'critical' });
    expect(rows.find(row => row.item_id === 'idle')).toMatchObject({ risk: 'idle', days_left: null, suggested_order: 0 });
  });

  it('ignores shipments outside the window and in the future', () => {
    const [tape] = forecastStockouts([stock('tape', 'a', 100)], [{ item_id: 'tape', day: '2026-09-01', quantity: 999 }, { item_id: 'tape', day: '2026-10-30', quantity: 999 }], { now });
    expect(tape.risk).toBe('idle');
  });
});

describe('orders at risk and alerts', () => {
  it('lists open orders due inside the window, overdue first, and skips shipped or undated orders', () => {
    const state = { ...emptyState(), orders: [order('later', '2026-10-23T03:00:00.000Z', 5), order('soon', '2026-10-21T05:00:00.000Z', 5), order('late', '2026-10-21T01:00:00.000Z', 5), order('done', '2026-10-21T04:00:00.000Z', 5, 5), order('nodate', undefined, 5)] };
    const risks = ordersAtRisk(state.orders, state.packages, now, 24);
    expect(risks.map(row => [row.order.id, row.overdue, row.hours_left, row.stage])).toEqual([['late', true, -2, 'reserve'], ['soon', false, 2, 'reserve']]);
    expect(operationsOverview(state, now)).toMatchObject({ open_orders: 4, due_today: 1, overdue_orders: 1 });
  });

  it('orders alerts by severity with reconciliation failure and overdue orders first', () => {
    const state = { ...emptyState(), orders: [order('late', '2026-10-21T01:00:00.000Z', 5)], approvals: [{ id: 'a', type: 'count' as const, requester_id: 'u', target_id: 't', target_version: 1, quantity: 1, data: {}, reason: 'r', status: 'pending' as const }], reconciliation: { ok: false } };
    const alerts = operationsAlerts(state, now, [], labels);
    expect(alerts.map(row => [row.severity, row.kind])).toEqual([['critical', 'reconciliation'], ['critical', 'due'], ['info', 'approval']]);
    expect(alerts[1]).toMatchObject({ title: 'late 납기 2시간 초과', target: { kind: 'order', id: 'late' } });
  });
});

describe('zone map', () => {
  it('groups active locations by kind and derives a single tile state', () => {
    const state = { ...emptyState(), stock: [stock('tape', 's1', 10, 4), stock('tape', 'h1', 0, 0, { B: 3, A: 0, H: 3 })], counts: [{ id: 'c', location_id: 's2', actor_id: 'u', version: 1, status: 'counting' as const, baseline: [], lines: [], recount: false, reason: '' }] };
    const map = zoneMap([{ id: 's1', kind: 'STORAGE' }, { id: 's2', kind: 'STORAGE' }, { id: 'h1', kind: 'HOLD' }, { id: 'r1', kind: 'RECEIVING' }, { id: 'x', kind: 'STORAGE', active: false }], state);
    expect(map.STORAGE.map(cell => [cell.location_id, cell.state, cell.on_hand])).toEqual([['s1', 'reserved', 10], ['s2', 'locked', 0]]);
    expect(map.HOLD[0].state).toBe('hold');
    expect(map.RECEIVING[0].state).toBe('empty');
  });
});
