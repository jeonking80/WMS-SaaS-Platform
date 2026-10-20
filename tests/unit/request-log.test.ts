import { afterEach, describe, expect, it, vi } from "vitest";
import { recordRequestIdentity, recordRequestResult, withRequestLog } from "../../src/server/request-log";
import { apiError } from "../../src/server/api";
import { requireRole } from "../../src/server/auth/access";

const identity = (id: string) => ({ user: { id, name: "private", email: "secret@example.test" }, tenant: { id: `tenant-${id}`, name: "private" }, role: "viewer" as const });
afterEach(() => vi.restoreAllMocks());
function capture() {
  const spy = vi.spyOn(console, "info").mockImplementation(() => {});
  return { spy, records: () => spy.mock.calls.map(([line]) => JSON.parse(String(line))) };
}

describe("structured API request logs", () => {
  it("correlates successful requests without trusting incoming IDs or logging request secrets", async () => {
    const log = capture();
    const handler = withRequestLog("items.list", async (_request: Request) => {
      recordRequestIdentity(identity("user-1"));
      return Response.json({ password: "response-secret" });
    });
    const response = await handler(new Request("https://test/api/items?token=query-secret", {
      headers: { "x-request-id": "forged", authorization: "Bearer credential-secret", cookie: "session=cookie-secret" },
    }));
    expect(response.headers.get("x-request-id")).toMatch(/^[a-f0-9-]{36}$/);
    expect(log.records()).toEqual([{
      event: "api_request", requestId: response.headers.get("x-request-id"), operation: "items.list",
      tenantId: "tenant-user-1", userId: "user-1", documentId: null, status: 200, resultCode: "OK",
    }]);
    expect(JSON.stringify(log.records())).not.toMatch(/secret|forged|private/);
    expect(await response.json()).toEqual({ password: "response-secret" });
  });

  it("keeps concurrent requests isolated and does not leak identity to the next request", async () => {
    const log = capture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const first = withRequestLog("first", async () => {
      recordRequestIdentity(identity("first")); await gate; return Response.json({});
    })();
    const second = await withRequestLog("second", async () => {
      recordRequestIdentity(identity("second")); release(); return Response.json({});
    })();
    await first;
    await withRequestLog("anonymous", () => Response.json({}))();
    const records = log.records();
    expect(records.find((r) => r.operation === "first").userId).toBe("first");
    expect(records.find((r) => r.operation === "second").requestId).toBe(second.headers.get("x-request-id"));
    expect(records.find((r) => r.operation === "anonymous").tenantId).toBeNull();
    expect(new Set(records.map((r) => r.requestId)).size).toBe(3);
  });

  it("logs failed role checks once with authenticated IDs and a safe result code", async () => {
    const log = capture();
    const response = await withRequestLog("documents.post", async () => {
      const authenticated = identity("viewer"); recordRequestIdentity(authenticated);
      try { requireRole(authenticated, ["admin"]); return Response.json({}); }
      catch (error) { return apiError(error); }
    })();
    expect(response.status).toBe(403);
    expect(log.records()).toHaveLength(1);
    expect(log.records()[0]).toMatchObject({ userId: "viewer", resultCode: "ROLE_FORBIDDEN", status: 403 });
    expect(response.headers.get("x-request-id")).toBe(log.records()[0].requestId);
  });

  it("redacts unknown exceptions and forged result codes on failures", async () => {
    const log = capture();
    const response = await withRequestLog("failure", () => { throw new Error("postgres://password-secret@example.test"); })();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "SERVICE_UNAVAILABLE" });
    await withRequestLog("mapped", () => apiError({ code: "23505", detail: "SQL secret" }))();
    await withRequestLog("forged", () => { recordRequestResult("PASSWORD_SECRET"); return Response.json({}, { status: 500 }); })();
    expect(log.records().map((r) => r.resultCode)).toEqual(["SERVICE_UNAVAILABLE", "CONFLICT", "SERVICE_UNAVAILABLE"]);
    expect(JSON.stringify(log.records())).not.toMatch(/password|postgres|SQL|PASSWORD_SECRET/);
  });

  it("records only validated document IDs, including failed requests", async () => {
    const log = capture();
    const handler = withRequestLog("documents.read", async (_req: Request, _ctx: { params: Promise<{ id: string }> }) => apiError({ code: "22P02" }), true);
    const id = "11111111-1111-4111-8111-111111111111";
    await handler(new Request("https://test"), { params: Promise.resolve({ id }) });
    await handler(new Request("https://test"), { params: Promise.resolve({ id: "secret@example.test" }) });
    expect(log.records().map((r) => r.documentId)).toEqual([id, null]);
    expect(log.records().map((r) => r.resultCode)).toEqual(["INVALID_INPUT", "INVALID_INPUT"]);
  });
});
