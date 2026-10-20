import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getSession, query } = vi.hoisted(() => ({ getSession: vi.fn(), query: vi.fn() }));
vi.mock("../../src/server/auth/config", () => ({ getAuth: () => ({ api: { getSession } }) }));
vi.mock("../../src/server/db/pool", () => ({ getPool: () => ({ query }) }));
import { AccessError, apiError, getCurrentIdentity, requireIdentity, requireRole, type Identity } from "../../src/server/auth/access";

import { withRequestLog } from "../../src/server/request-log";

afterEach(() => vi.restoreAllMocks());

const identity: Identity = {
  user: { id: "user-A", name: "A", email: "a@example.test" },
  tenant: { id: "tenant-A", name: "A company" }, role: "admin",
};
beforeEach(() => vi.resetAllMocks());

describe("server-side access decisions", () => {
  it("rejects an absent or expired session before accessing membership", async () => {
    getSession.mockResolvedValue(null);
    await expect(requireIdentity(new Headers())).rejects.toMatchObject({ status: 401 });
    expect(query).not.toHaveBeenCalled();
  });

  it("ignores requested company/role headers and resolves membership from session user", async () => {
    getSession.mockResolvedValue({ user: identity.user });
    query.mockResolvedValue({ rows: [{ tenant_id: "tenant-A", tenant_name: "A company", role: "worker" }] });
    const result = await requireIdentity(new Headers({ "x-tenant-id": "tenant-B", "x-role": "admin" }));
    expect(query.mock.calls[0][1]).toEqual(["user-A"]);
    expect(result.tenant.id).toBe("tenant-A");
    expect(result.role).toBe("worker");
  });

  it("rejects missing membership and lets protected pages redirect", async () => {
    getSession.mockResolvedValue({ user: identity.user });
    query.mockResolvedValue({ rows: [] });
    await expect(requireIdentity(new Headers())).rejects.toMatchObject({ status: 403 });
    expect(await getCurrentIdentity(new Headers())).toBeNull();
  });

  it("logs the verified session user on membership failure without trusting tenant headers", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    getSession.mockResolvedValue({ user: identity.user });
    query.mockResolvedValue({ rows: [] });
    const handler = withRequestLog("me", async (request: Request) => {
      try { await requireIdentity(request.headers); return Response.json({}); }
      catch (error) { return apiError(error); }
    });
    const response = await handler(new Request("https://test/api/me", {
      headers: { "x-tenant-id": "forged-tenant", "x-user-id": "forged-user" },
    }));
    expect(response.status).toBe(403);
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({
      requestId: response.headers.get("x-request-id"), userId: "user-A", tenantId: null,
      resultCode: "MEMBERSHIP_REQUIRED", status: 403,
    });
    expect(log.mock.calls[0][0]).not.toMatch(/forged|example.test|company/);
  });

  it.each(["worker", "viewer"] as const)("rejects %s for administrator-only operations", (role) => {
    expect(() => requireRole({ ...identity, role }, ["admin"])).toThrow(AccessError);
  });

  it("permits an administrator for an explicitly allowed operation", () => {
    expect(() => requireRole(identity, ["admin"])).not.toThrow();
  });

  it("does not return internal database details as API errors", async () => {
    const response = apiError(new Error("private database connection details"));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "SERVICE_UNAVAILABLE" });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
