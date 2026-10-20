import { beforeEach, describe, expect, it, vi } from 'vitest';
const { query, identity } = vi.hoisted(() => ({ query: vi.fn(), identity: { role: 'admin', tenant: { id: '10000000-0000-4000-8000-000000000001' }, user: { id: 'user', name: 'User', email: 'u@example.test' } } }));
vi.mock('../../src/server/db/tenant', () => ({ withTenant: (_tenant: string, callback: (client: unknown) => unknown) => callback({ query }) }));
vi.mock('../../src/server/auth/access', async importOriginal => ({ ...await importOriginal<object>(), requireIdentity: async () => identity }));
import { destinationCollection, destinationDetail, parseDestinationQuery, validateDestinationInput } from '../../src/server/delivery-destinations';
import { createDocument, parseDocument } from '../../src/server/documents';
const id = '10000000-0000-4000-8000-000000000001';
const base = { recipient_name: ' Kim ', name: ' Office ', postal_code: '01234', address_line1: ' Seoul ', address_line2: ' 101 ' };
const outbound = { kind: 'OUTBOUND', warehouse_id: id, source_location_id: id, delivery_destination_id: id, lines: [{ item_id: id, quantity: 1 }] };
beforeEach(() => { vi.resetAllMocks(); identity.role = 'admin'; process.env.BETTER_AUTH_URL = 'http://localhost:3000'; });
function request(method = 'GET', body?: object, suffix = '', origin = 'http://localhost:3000') { return new Request(`http://localhost:3000/api/delivery-destinations${suffix}`, { method, headers: { origin, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }); }
describe('delivery destination validation and access', () => {
  it('normalizes fields and defaults optional address details', () => {
    expect(validateDestinationInput(base)).toEqual({ recipient_name: 'Kim', name: 'Office', postal_code: '01234', address_line1: 'Seoul', address_line2: '101' });
    expect(validateDestinationInput({ recipient_name: 'Kim', name: 'Office', address_line1: 'Seoul' })).toMatchObject({ postal_code: '', address_line2: '' });
  });
  it.each([{ ...base, postal_code: null }, { ...base, address_line2: null }, { ...base, tenant_id: id }, { ...base, active: false }, { ...base, postal_code: '1234' }, { ...base, address_line1: ' ' }, { ...base, address_line2: 'x'.repeat(161) }])('rejects invalid creation %j', body => expect(() => validateDestinationInput(body)).toThrow());
  it('supports only nonempty strict patches', () => { expect(validateDestinationInput({ active: false }, true)).toEqual({ active: false }); expect(() => validateDestinationInput({}, true)).toThrow(); expect(() => validateDestinationInput({ tenant_id: id }, true)).toThrow(); });
  it('validates paging and inactive filters', () => { expect(parseDestinationQuery(new URLSearchParams())).toMatchObject({ page: 1, page_size: 20, include_inactive: false }); for (const raw of ['page=0', 'page_size=101', 'include_inactive=yes']) expect(() => parseDestinationQuery(new URLSearchParams(raw))).toThrow(); });
  it('denies viewer reads, worker mutations and worker inactive lists', async () => {
    identity.role = 'viewer'; expect((await destinationCollection(request())).status).toBe(403);
    identity.role = 'worker'; expect((await destinationCollection(request('POST', base))).status).toBe(403); expect((await destinationCollection(request('GET', undefined, '?include_inactive=true'))).status).toBe(403);
    expect((await destinationDetail(request('PATCH', { active: true }), { params: Promise.resolve({ id }) })).status).toBe(403); expect(query).not.toHaveBeenCalled();
  });
  it('rejects foreign origin before touching data', async () => { expect((await destinationCollection(request('POST', base, '', 'http://evil.test'))).status).toBe(403); expect((await destinationDetail(request('PATCH', { active: true }, '', 'http://evil.test'), { params: Promise.resolve({ id }) })).status).toBe(403); expect(query).not.toHaveBeenCalled(); });
});
describe('document destination resolution', () => {
  it('accepts destination alone and rejects it for other kinds', () => { expect(parseDocument(outbound)).toMatchObject({ delivery_destination_id: id, recipient_name: null }); expect(() => parseDocument({ ...outbound, kind: 'INBOUND', source_location_id: null, destination_location_id: id })).toThrow(); expect(() => parseDocument({ ...outbound, delivery_destination_id: 'bad' })).toThrow(); });
  it('rejects inactive or foreign destinations before inserting a document', async () => { query.mockResolvedValue({ rows: [] }); await expect(createDocument(id, parseDocument(outbound))).rejects.toMatchObject({ code: 'REFERENCE_NOT_FOUND' }); expect(query).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('active=true FOR SHARE'), [id]); });
  it('ignores spoofed snapshots and persists destination-derived text', async () => {
    query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM delivery_destinations')) return { rows: [{ recipient_name: 'Real', address_line1: 'Seoul', address_line2: '101' }] };
      if (sql.includes('INSERT INTO inventory_documents')) return { rows: [{ id }] };
      if (sql.includes('SELECT * FROM inventory_documents')) return { rows: [{ id }] };
      return { rows: [], rowCount: 1 };
    });
    await createDocument(id, parseDocument({ ...outbound, recipient_name: 'Fake', delivery_address: 'Fake' }));
    const insert = query.mock.calls.find(([sql]) => sql.includes('INSERT INTO inventory_documents'))!;
    expect(insert[1].slice(-3)).toEqual(['Real', 'Seoul 101', id]);
  });
});
