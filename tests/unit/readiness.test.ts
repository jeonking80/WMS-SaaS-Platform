import { beforeEach, describe, expect, it, vi } from "vitest";

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@/server/db/pool", () => ({ getPool: () => ({ query }) }));
import { GET } from "../../src/app/api/ready/route";

beforeEach(() => vi.resetAllMocks());

describe("database readiness response", () => {
  it("reports readiness only after the schema query succeeds", async () => {
    query.mockResolvedValue({ rows: [] });
    const response = await GET();
    expect(query).toHaveBeenCalledWith("SELECT id FROM tenants LIMIT 1");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok", database: "ok" });
  });

  it("returns an uncached 503 without leaking driver details", async () => {
    query.mockRejectedValue(new Error("connection failed: private connection details"));
    const response = await GET();
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ status: "unavailable", database: "unavailable" });
  });
});
