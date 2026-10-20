import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../../src/server/db/tenant', () => ({ withTenant: (_tenant: string, callback: (client: unknown) => unknown) => callback({ query }) }));
import { createDocument, parseDocument } from '../../src/server/documents';
import { postDocument } from '../../src/server/posting';
import type { Identity } from '../../src/server/auth/access';
const id = '10000000-0000-4000-8000-000000000001';
const location = '10000000-0000-4000-8000-000000000002';
const input = { kind: 'OUTBOUND', warehouse_id: id, source_location_id: location, recipient_name: '  Kim  ', delivery_address: '  Seoul  ', lines: [{ item_id: id, quantity: 1 }] };
const identity: Identity = { user: { id, name: 'Worker', email: 'worker@example.test' }, tenant: { id, name: 'Company' }, role: 'worker' };
beforeEach(() => vi.resetAllMocks());
describe('outbound delivery validation', () => {
  it('trims delivery fields and retains independent inventory source', () => {
    expect(parseDocument(input)).toMatchObject({ recipient_name: 'Kim', delivery_address: 'Seoul', source_location_id: location, destination_location_id: null });
  });
  it.each([undefined, null, '', '  ', 42, 'x'.repeat(129)])('rejects invalid recipient %s', recipient_name => {
    expect(() => parseDocument({ ...input, recipient_name })).toThrow();
  });
  it.each([undefined, null, '', '  ', 42, 'x'.repeat(501)])('rejects invalid address %s', delivery_address => {
    expect(() => parseDocument({ ...input, delivery_address })).toThrow();
  });
  it.each(['INBOUND', 'TRANSFER'])('rejects shipment data on %s', kind => {
    const direction = { ...input, kind, source_location_id: kind === 'TRANSFER' ? location : null, destination_location_id: id };
    expect(() => parseDocument(direction)).toThrow();
    expect(parseDocument({ ...direction, recipient_name: null, delivery_address: undefined })).toMatchObject({ recipient_name: null, delivery_address: null });
  });
  it('enforces required delivery fields for direct service callers before references', async () => {
    await expect(createDocument(id, { kind: 'OUTBOUND', warehouse_id: id, source_location_id: location, destination_location_id: null, note: '', lines: input.lines })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(query).not.toHaveBeenCalled();
  });
});
function postingRow(change: Record<string, unknown> = {}, saved: unknown[] = []) {
  query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ id, kind: 'OUTBOUND', status: 'DRAFT', version: 1, recipient_name: null, delivery_address: null, ...change }] })
    .mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: saved });
}
describe('legacy outbound posting', () => {
  it('requires delivery before any stock operation', async () => {
    postingRow();
    await expect(postDocument(identity, id, 1, 'key')).rejects.toMatchObject({ status: 400, code: 'DELIVERY_REQUIRED' });
    expect(query).toHaveBeenCalledTimes(4);
  });
  it('retains version and state errors before delivery validation', async () => {
    postingRow({ version: 2 });
    await expect(postDocument(identity, id, 1, 'key')).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    query.mockReset();
    postingRow({ status: 'POSTED' });
    await expect(postDocument(identity, id, 1, 'key')).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });
  it('replays successful legacy posting with null delivery', async () => {
    const response = { document: { id, status: 'POSTED', version: 2, posted_at: '2026-10-20T00:00:00.000Z' }, ledger_entries: 1 };
    const request_hash = createHash('sha256').update(JSON.stringify({ operation: 'POST_OUTBOUND', document_id: id, version: 1 })).digest('hex');
    postingRow({ status: 'POSTED', version: 2 }, [{ request_hash, response }]);
    await expect(postDocument(identity, id, 1, 'key')).resolves.toEqual(response);
    expect(query).toHaveBeenCalledTimes(4);
  });
});
