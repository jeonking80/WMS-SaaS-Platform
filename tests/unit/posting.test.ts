import { beforeEach, describe, expect, it, vi } from "vitest";
const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../../src/server/db/tenant", () => ({ withTenant: (_tenant: string, callback: (client: unknown) => unknown) => callback({ query }) }));
import { idempotencyKey, postInbound } from "../../src/server/posting";
import type { Identity } from "../../src/server/auth/access";
const id = "10000000-0000-4000-8000-000000000001";
const identity: Identity = { user: { id: "user", name: "Worker", email: "worker@example.test" }, tenant: { id, name: "Company" }, role: "worker" };
const document = { id, kind: "INBOUND", status: "DRAFT", version: 1 };
beforeEach(() => vi.resetAllMocks());
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
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toContain("FOR UPDATE");
  });
  it("rejects key reuse with changed request before state checks", async () => {
    query.mockResolvedValueOnce({ rows: [{ ...document, status: "POSTED" }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ request_hash: "different", response: {} }] });
    await expect(postInbound(identity, id, 1, "key")).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(query).toHaveBeenCalledTimes(3);
  });
  it("replays the committed result before checking version, references or state", async () => {
    const response = { document: { id, status: "POSTED", version: 2, posted_at: "2026-10-19T00:00:00.000Z" }, ledger_entries: 1 };
    // The hash is taken from the actual request contract, independently of actor.
    const { createHash } = await import("node:crypto");
    const hash = createHash("sha256").update(JSON.stringify({ operation: "POST_INBOUND", document_id: id, version: 1 })).digest("hex");
    query.mockReset().mockResolvedValueOnce({ rows: [{ ...document, status: "POSTED", version: 2 }] })
      .mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ request_hash: hash, response }] });
    await expect(postInbound({ ...identity, user: { ...identity.user, id: "another-worker" } }, id, 1, "key")).resolves.toEqual(response);
    expect(query).toHaveBeenCalledTimes(3);
  });
  it.each([{ status: "POSTED", version: 2 }, { status: "CANCELLED", version: 1 }, { kind: "OUTBOUND" }])("rejects non-postable document %j", async (change) => {
    query.mockResolvedValueOnce({ rows: [{ ...document, ...change }] }).mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
    await expect(postInbound(identity, id, 1, "fresh-key")).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect(query).toHaveBeenCalledTimes(3);
  });
  it("rejects stale draft versions before references or stock writes", async () => {
    query.mockResolvedValueOnce({ rows: [{ ...document, version: 2 }] }).mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
    await expect(postInbound(identity, id, 1, "key")).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    expect(query).toHaveBeenCalledTimes(3);
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
