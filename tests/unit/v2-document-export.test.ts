import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Order, Return } from '../../src/server/v2/workflow/types';
import type { Context } from '../../src/app/dashboard/v2/common';
const { downloadCsv } = vi.hoisted(() => ({ downloadCsv: vi.fn() }));
vi.mock('../../src/app/dashboard/v2/common', () => ({ downloadCsv }));
import { exportBusiness } from '../../src/app/dashboard/v2/document-export';

const order = (id: string, extra: Partial<Order> = {}): Order => ({ id, version: 1, delivery: {}, created_at: '2026-10-21T00:00:00Z', lines: [{ id: `${id}-line`, item_id: 'item', quantity: 2, cancelled: 0, received: 0, shipped: 0 }], reservations: [], picks: [], ...extra });
function context(orders: Order[], returns: Return[] = []): Context {
  return { company: '회사', warehouse: 'warehouse', warehouseCode: 'WH', warehouseName: '창고', asOf: '2026-10-21T00:00:00Z', items: [{ id: 'item', code: 'SKU', name: '품목' }], partners: [], snapshot: { version: 1, orders, returns, shipments: [] } } as unknown as Context;
}
function exportedRow(): Record<string, unknown> {
  const rows = downloadCsv.mock.calls[0][1] as unknown[][];
  expect(rows[2]).toHaveLength(rows[1].length);
  return Object.fromEntries(rows[1].map((column, index) => [column, rows[2][index]]));
}

beforeEach(() => vi.clearAllMocks());
describe('business CSV original document links', () => {
  it('keeps original order and return IDs and labels when exporting a filtered correction order', () => {
    const original = order('original', { external_id: 'EXT-ORIGINAL' });
    const correction = order('correction', { original_order_id: original.id, original_return_id: 'return' });
    const c = context([original, correction], [{ id: 'return' } as Return]);
    exportBusiness(c, 'order', [correction], c.snapshot.orders, 'correction');
    expect(exportedRow()).toMatchObject({ 원주문ID: 'original', 원주문번호: 'EXT-ORIGINAL', 연결반품ID: 'return', 연결반품번호: '반품 0001' });
  });

  it('preserves a link ID if the referenced document is outside the available snapshot', () => {
    const correction = order('correction', { original_order_id: 'unavailable', original_return_id: 'old-return' });
    exportBusiness(context([correction]), 'order', [correction], [correction], '');
    expect(exportedRow()).toMatchObject({ 원주문ID: 'unavailable', 원주문번호: 'unavailable', 연결반품ID: 'old-return', 연결반품번호: 'old-return' });
  });

  it('leaves reference columns empty for an ordinary order', () => {
    const ordinary = order('ordinary');
    exportBusiness(context([ordinary]), 'order', [ordinary], [ordinary], '');
    expect(exportedRow()).toMatchObject({ 원주문ID: '', 원주문번호: '', 연결반품ID: '', 연결반품번호: '' });
  });
});
