import { beforeEach, describe, expect, it, vi } from "vitest";
const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../../src/server/db/tenant", () => ({ withTenant: (_tenant: string, callback: (client: unknown) => unknown) => callback({ query }) }));
import { documentVersion, parseDocument, updateDocument } from "../../src/server/documents";
const warehouse = "10000000-0000-4000-8000-000000000001";
const source = "10000000-0000-4000-8000-000000000002";
const destination = "10000000-0000-4000-8000-000000000003";
const item = "10000000-0000-4000-8000-000000000004";
const input = () => ({ kind: "INBOUND", warehouse_id: warehouse, destination_location_id: destination, lines: [{ item_id: item, quantity: 1 }] });
beforeEach(() => vi.resetAllMocks());
describe("document input boundary", () => {
  it("normalizes identifiers and defaults note", () => {
    expect(parseDocument(input())).toMatchObject({ note: "", source_location_id: null });
  });
  it.each([0, -1, 1.5, "1", 1_000_000_001, Infinity])("rejects invalid quantity %s", (quantity) => {
    expect(() => parseDocument({ ...input(), lines: [{ item_id: item, quantity }] })).toThrow();
  });
  it("rejects empty, oversized and duplicate item lines", () => {
    for (const lines of [[], Array(21).fill(input().lines[0]), [input().lines[0], input().lines[0]]]) {
      expect(() => parseDocument({ ...input(), lines })).toThrow();
    }
  });
  it("requires direction-specific locations and distinct transfers", () => {
    expect(() => parseDocument({ ...input(), source_location_id: source })).toThrow();
    expect(() => parseDocument({ ...input(), kind: "OUTBOUND" })).toThrow();
    expect(() => parseDocument({ ...input(), kind: "TRANSFER", source_location_id: destination })).toThrow();
    expect(parseDocument({ ...input(), kind: "TRANSFER", source_location_id: source }).kind).toBe("TRANSFER");
  });
  it("rejects malformed IDs, overlong notes and invalid versions", () => {
    expect(() => parseDocument({ ...input(), warehouse_id: "missing" })).toThrow();
    expect(() => parseDocument({ ...input(), note: "x".repeat(2001) })).toThrow();
    for (const version of [undefined, 0, 1.5, "1"]) expect(() => documentVersion(version)).toThrow();
  });
});
describe("document transition guards", () => {
  it("checks stale version under row lock before any mutation", async () => {
    query.mockResolvedValueOnce({ rows: [{ version: 2, status: "DRAFT" }] });
    await expect(updateDocument(warehouse, source, 1, parseDocument(input()))).rejects.toMatchObject({ status: 409, code: "VERSION_CONFLICT" });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toContain("FOR UPDATE");
  });
  it("rejects updates to cancelled documents", async () => {
    query.mockResolvedValueOnce({ rows: [{ version: 2, status: "CANCELLED" }] });
    await expect(updateDocument(warehouse, source, 2)).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect(query).toHaveBeenCalledTimes(1);
  });
  it("rejects missing active references before replacing lines", async () => {
    query.mockResolvedValueOnce({ rows: [{ version: 1, status: "DRAFT" }] })
      .mockResolvedValueOnce({ rows: [{ id: warehouse }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await expect(updateDocument(warehouse, source, 1, parseDocument(input()))).rejects.toMatchObject({ status: 404, code: "REFERENCE_NOT_FOUND" });
    expect(query.mock.calls[1][0]).toContain("warehouses");
    expect(query.mock.calls[2][0]).toContain("locations");
    expect(query.mock.calls.every(([sql]) => !String(sql).includes("DELETE"))).toBe(true);
  });
  it("cancels without querying active references", async () => {
    query.mockResolvedValueOnce({ rows: [{ version: 1, status: "DRAFT" }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: source, version: 2, status: "CANCELLED" }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    await expect(updateDocument(warehouse, source, 1)).resolves.toMatchObject({ status: "CANCELLED", version: 2, reversal_document_id: null, lines: [] });
    expect(query.mock.calls.some(([sql]) => /FROM (warehouses|locations|items)/.test(String(sql)))).toBe(false);
  });
});
