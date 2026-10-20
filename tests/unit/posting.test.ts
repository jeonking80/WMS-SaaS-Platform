import { beforeEach, describe, expect, it, vi } from "vitest";
const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../../src/server/db/tenant", () => ({ withTenant: (_tenant: string, callback: (client: unknown) => unknown) => callback({ query }) }));
import { idempotencyKey, postDocument, postInbound } from "../../src/server/posting";
import type { Identity } from "../../src/server/auth/access";
const id = "10000000-0000-4000-8000-000000000001";
const identity: Identity = { user: { id: "user", name: "Worker", email: "worker@example.test" }, tenant: { id, name: "Company" }, role: "worker" };
const document = { id, kind: "INBOUND", status: "DRAFT", version: 1 };
beforeEach(() => { vi.resetAllMocks(); query.mockResolvedValueOnce({ rows: [] }); });
describe("inbound posting boundaries", () => {
  it.each([null, "", "key with spaces", "é", "a/b", "a".repeat(129)])("rejects unsafe keys %s", (key) => {
    expect(() => idempotencyKey(key)).toThrow();
  });
  it("accepts bounded printable key characters", () => {
    expect(idempotencyKey("a.Z_9:-")).toBe("a.Z_9:-");
    expect(idempotencyKey("x".repeat(128))).toHaveLength(128);
  });
  it("rejects viewers and invalid versions before DB access", async () => {
    await expect(postInbound({ ...identity, role: "viewer" }, id, 1, "key")).rejects.toMatchObject({ code: "ROLE_FORBIDDEN" });
    await expect(postInbound(identity, id, 0, "key")).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(query).not.toHaveBeenCalled();
  });
  it("checks document existence before checking saved responses", async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await expect(postInbound(identity, id, 1, "key")).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1][0]).toContain("FOR UPDATE");
  });
  it("rejects key reuse with changed request before state checks", async () => {
    query.mockResolvedValueOnce({ rows: [{ ...document, status: "POSTED" }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ request_hash: "different", response: {} }] });
    await expect(postInbound(identity, id, 1, "key")).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(query).toHaveBeenCalledTimes(4);
  });
  it("replays the committed result before checking version, references or state", async () => {
    const response = { document: { id, status: "POSTED", version: 2, posted_at: "2026-10-19T00:00:00.000Z" }, ledger_entries: 1 };
    // The hash is taken from the actual request contract, independently of actor.
    const { createHash } = await import("node:crypto");
    const hash = createHash("sha256").update(JSON.stringify({ operation: "POST_INBOUND", document_id: id, version: 1 })).digest("hex");
    query.mockResolvedValueOnce({ rows: [{ ...document, status: "POSTED", version: 2 }] })
      .mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ request_hash: hash, response }] });
    await expect(postInbound({ ...identity, user: { ...identity.user, id: "another-worker" } }, id, 1, "key")).resolves.toEqual(response);
    expect(query).toHaveBeenCalledTimes(4);
  });
  it.each([{ status: "POSTED", version: 2 }, { status: "CANCELLED", version: 1 }])("rejects non-postable document %j", async (change) => {
    query.mockResolvedValueOnce({ rows: [{ ...document, ...change }] }).mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
    await expect(postInbound(identity, id, 1, "fresh-key")).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect(query).toHaveBeenCalledTimes(4);
  });
  it("rejects stale draft versions before references or stock writes", async () => {
    query.mockResolvedValueOnce({ rows: [{ ...document, version: 2 }] }).mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
    await expect(postInbound(identity, id, 1, "key")).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    expect(query).toHaveBeenCalledTimes(4);
  });
  it("rejects a balance overflow before writing stock or ledger", async () => {
    query.mockResolvedValueOnce({ rows: [{ ...document, warehouse_id: id, destination_location_id: id }] })
      .mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ item_id: id, quantity: 1 }] })
      .mockResolvedValueOnce({ rowCount: 1 }).mockResolvedValueOnce({ rowCount: 1 }).mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ quantity: "9007199254740991" }] });
    await expect(postInbound(identity, id, 1, "key")).rejects.toMatchObject({ status: 409, code: "STOCK_OVERFLOW" });
    expect(query.mock.calls.some(([sql]) => /UPDATE stock_balances|INSERT INTO stock_ledger/.test(String(sql)))).toBe(false);
  });

});


describe("unified outbound posting", () => {
  const secondId = "10000000-0000-4000-8000-000000000002";
  function outbound(lines = [{ item_id: id, quantity: 3 }]) {
    query.mockResolvedValueOnce({ rows: [{ ...document, kind: "OUTBOUND", recipient_name: "Test recipient", delivery_address: "Test delivery address", warehouse_id: id, source_location_id: secondId }] })
      .mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: lines })
      .mockResolvedValueOnce({ rowCount: 1 }).mockResolvedValueOnce({ rowCount: 1 });
    for (const _line of lines) query.mockResolvedValueOnce({ rowCount: 1 });
  }
  it("retains the inbound-only compatibility boundary and rejects invalid transfers", async () => {
    query.mockResolvedValueOnce({ rows: [{ ...document, kind: "OUTBOUND" }] });
    await expect(postInbound(identity, id, 1, "key")).rejects.toMatchObject({ code: "INVALID_STATE" });
    query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ ...document, kind: "TRANSFER" }] })
      .mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ item_id: id, quantity: 1 }] });
    await expect(postDocument(identity, id, 1, "key")).rejects.toMatchObject({ code: "INVALID_STATE" });
  });
  it.each([{ rows: [] }, { rows: [{ quantity: "2" }] }])("rejects missing or insufficient balances without any stock writes", async ({ rows }) => {
    outbound(); query.mockResolvedValueOnce({ rows });
    await expect(postDocument(identity, id, 1, "key")).rejects.toMatchObject({ status: 409, code: "INSUFFICIENT_STOCK" });
    expect(query.mock.calls.some(([sql]) => /INSERT INTO stock_balances|UPDATE stock_balances|INSERT INTO stock_ledger/.test(String(sql)))).toBe(false);
  });
  it("validates every item before writing a multi-item document", async () => {
    outbound([{ item_id: id, quantity: 3 }, { item_id: secondId, quantity: 4 }]);
    query.mockResolvedValueOnce({ rows: [{ quantity: "3" }] }).mockResolvedValueOnce({ rows: [{ quantity: "3" }] });
    await expect(postDocument(identity, id, 1, "key")).rejects.toMatchObject({ code: "INSUFFICIENT_STOCK" });
    expect(query.mock.calls.some(([sql]) => /UPDATE stock_balances|INSERT INTO stock_ledger/.test(String(sql)))).toBe(false);
  });
  it("uses source location, negative deltas, and the outbound audit operation", async () => {
    outbound();
    query.mockResolvedValueOnce({ rows: [{ quantity: "3" }] })
      .mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id, status: "POSTED", version: 2, posted_at: "2026-10-19T00:00:00Z" }] })
      .mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
    await expect(postDocument(identity, id, 1, "key")).resolves.toMatchObject({ ledger_entries: 1, document: { version: 2 } });
    const calls = query.mock.calls;
    expect(calls[0][0]).toBe("SET LOCAL lock_timeout = '1000ms'");
    expect(calls.find(([sql]) => String(sql).startsWith("UPDATE stock_balances"))?.[1]).toEqual([id, secondId, id, -3]);
    expect(calls.find(([sql]) => String(sql).startsWith("INSERT INTO stock_ledger"))?.[1]).toEqual([id, id, id, secondId, id, -3]);
    expect(calls.find(([sql]) => String(sql).startsWith("INSERT INTO audit_logs"))?.[1]).toEqual([id, id, "user", "POST_OUTBOUND"]);
  });
});

describe("transfer posting", () => {
  it("locks both locations in UUID order and applies two ledger legs atomically", async () => {
    const source = "10000000-0000-4000-8000-000000000003";
    const destination = "10000000-0000-4000-8000-000000000002";
    query.mockReset();
    query.mockImplementation(async (sql: string, values: unknown[]) => {
      if (sql.startsWith("SELECT * FROM inventory_documents")) return { rows: [{ ...document, kind: "TRANSFER", warehouse_id: id, source_location_id: source, destination_location_id: destination }] };
      if (sql.startsWith("SELECT item_id, quantity")) return { rows: [{ item_id: id, quantity: 3 }] };
      if (sql.includes("FOR SHARE")) return { rows: [{ id }], rowCount: 1 };
      if (sql.startsWith("SELECT quantity")) return { rows: [{ quantity: values[1] === source ? "3" : "0" }] };
      if (sql.startsWith("UPDATE inventory_documents")) return { rows: [{ id, status: "POSTED", version: 2, posted_at: "2026-10-19T00:00:00Z" }] };
      return { rows: [] };
    });
    await expect(postDocument(identity, id, 1, "transfer")).resolves.toMatchObject({ ledger_entries: 2 });
    const locations = query.mock.calls.filter(([sql]) => String(sql).startsWith("SELECT id FROM locations")).map(([, values]) => values[0]);
    expect(locations).toEqual([destination, source]);
    const legs = query.mock.calls.filter(([sql]) => String(sql).startsWith("INSERT INTO stock_ledger")).map(([, values]) => [values[3], values[5]]);
    expect(legs).toEqual([[destination, 3], [source, -3]]);
    const lastBalanceLock = query.mock.calls.findLastIndex(([sql]) => String(sql).includes("FROM stock_balances"));
    const firstEffect = query.mock.calls.findIndex(([sql]) => String(sql).startsWith("UPDATE stock_balances"));
    expect(lastBalanceLock).toBeLessThan(firstEffect);
  });
});
