import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../../src/server/db/tenant", () => ({ withTenant: (_tenant: string, callback: (client: unknown) => unknown) => callback({ query }) }));
import { reverseDocument } from "../../src/server/reverse";
import type { Identity } from "../../src/server/auth/access";
const id = "10000000-0000-4000-8000-000000000001";
const location = "10000000-0000-4000-8000-000000000002";
const identity: Identity = { user: { id: "admin", name: "Admin", email: "admin@example.test" }, tenant: { id, name: "Company" }, role: "admin" };
const document = { id, kind: "INBOUND", status: "POSTED", version: 2, warehouse_id: id, destination_location_id: location };
beforeEach(() => { vi.resetAllMocks(); });
function setup(change = {}) {
  query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ ...document, ...change }] }).mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
}
describe("document reversal boundaries", () => {
  it("rejects workers before any database access", async () => {
    await expect(reverseDocument({ ...identity, role: "worker" }, id, 2, "key")).rejects.toMatchObject({ code: "ROLE_FORBIDDEN" });
    expect(query).not.toHaveBeenCalled();
  });
  it("forbids reversing an automatically generated document", async () => {
    setup({ reversal_of_id: location });
    await expect(reverseDocument(identity, id, 2, "key")).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect(query).toHaveBeenCalledTimes(2);
  });
  it.each([{ status: "DRAFT" }, { status: "REVERSED" }])("rejects invalid state %j", async (change) => {
    setup(change);
    await expect(reverseDocument(identity, id, 2, "key")).rejects.toMatchObject({ code: "INVALID_STATE" });
  });
  it("checks the posted version before reading ledger", async () => {
    setup();
    await expect(reverseDocument(identity, id, 1, "key")).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    expect(query).toHaveBeenCalledTimes(4);
  });
  it("replays a saved response before checking state or version", async () => {
    const response = { document: { id, status: "REVERSED", version: 3 }, reversal: { id: location }, ledger_entries: 1 };
    const request_hash = createHash("sha256").update(JSON.stringify({ operation: "REVERSE_DOCUMENT", document_id: id, version: 2 })).digest("hex");
    query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ ...document, status: "REVERSED", version: 3 }] }).mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ request_hash, response }] });
    await expect(reverseDocument(identity, id, 2, "key")).resolves.toEqual(response);
  });
  it.each([{ rows: [] }, { rows: [{ warehouse_id: id, location_id: location, item_id: id, quantity_delta: "-1" }] }, { rows: [{ warehouse_id: id, location_id: location, item_id: id, quantity_delta: "1000000001" }] }])("rejects missing or corrupt source ledger %j", async ({ rows }) => {
    setup(); query.mockResolvedValueOnce({ rows });
    await expect(reverseDocument(identity, id, 2, "key")).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect(query.mock.calls.some(([sql]) => /INSERT INTO|UPDATE stock_balances/.test(String(sql)))).toBe(false);
  });
  it("locks inactive historical references and rejects a reversal debit shortage before effects", async () => {
    setup();
    query.mockResolvedValueOnce({ rows: [{ warehouse_id: id, location_id: location, item_id: id, quantity_delta: "3" }] })
      .mockResolvedValueOnce({ rowCount: 1 }).mockResolvedValueOnce({ rowCount: 1 }).mockResolvedValueOnce({ rowCount: 1 }).mockResolvedValueOnce({ rows: [{ quantity: "2" }] });
    await expect(reverseDocument(identity, id, 2, "key")).rejects.toMatchObject({ code: "INSUFFICIENT_STOCK" });
    const references = query.mock.calls.filter(([sql]) => String(sql).includes("FOR SHARE"));
    expect(references).toHaveLength(3);
    expect(references.every(([sql]) => !String(sql).includes("active=true"))).toBe(true);
    expect(query.mock.calls.some(([sql]) => /INSERT INTO|UPDATE stock_balances/.test(String(sql)))).toBe(false);
  });
});
