import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

type RequestLog = {
  requestId: string;
  operation: string;
  tenantId: string | null;
  userId: string | null;
  documentId: string | null;
  resultCode?: string;
};
const requests = new AsyncLocalStorage<RequestLog>();
const safeCodes = new Set([
  "UNAUTHENTICATED", "MEMBERSHIP_REQUIRED", "ROLE_FORBIDDEN", "ORIGIN_FORBIDDEN",
  "CONFLICT", "REFERENCE_CONFLICT", "RETRYABLE_TRANSACTION", "SERVICE_UNAVAILABLE",
  "INVALID_INPUT", "NOT_FOUND", "INVALID_STATE", "REFERENCE_NOT_FOUND", "VERSION_CONFLICT",
  "INACTIVE_REFERENCE", "IN_USE", "DELIVERY_REQUIRED", "IDEMPOTENCY_CONFLICT",
  "INSUFFICIENT_STOCK", "STOCK_OVERFLOW",
]);

/** Called only after the authentication library verifies a server session. */
export function recordAuthenticatedUser(userId: string): void {
  const log = requests.getStore();
  if (log) log.userId = userId;
}

/** Called only with identities resolved by the server authentication boundary. */
export function recordRequestIdentity(identity: { user: { id: string }; tenant: { id: string } }): void {
  const log = requests.getStore();
  if (log) { log.userId = identity.user.id; log.tenantId = identity.tenant.id; }
}

/** Accept only a document UUID from a route parameter or persisted document. */
export function recordRequestDocument(id: unknown): void {
  const log = requests.getStore();
  if (log && typeof id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    log.documentId = id;
  }
}

export function recordRequestResult(code: string): void {
  const log = requests.getStore();
  if (log) log.resultCode = safeCodes.has(code) ? code : "SERVICE_UNAVAILABLE";
}

/** Each exported business handler gets an isolated, server-generated correlation ID.
 * No headers, URL, body, response payload or raw exception are written to logs.
 */
export function withRequestLog<Args extends unknown[]>(
  operation: string,
  handler: (...args: Args) => Response | Promise<Response>,
  documentRoute = false,
): (...args: Args) => Promise<Response> {
  return (...args) => requests.run({
    requestId: randomUUID(), operation, tenantId: null, userId: null, documentId: null,
  }, async () => {
    const log = requests.getStore()!;
    let response: Response;
    try {
      if (documentRoute) {
        const context = args[1] as { params?: Promise<{ id?: unknown }> } | undefined;
        const id = (await context?.params)?.id;
        recordRequestDocument(id);
      }
      response = await handler(...args);
    } catch {
      log.resultCode = "SERVICE_UNAVAILABLE";
      response = Response.json({ error: "SERVICE_UNAVAILABLE" }, {
        status: 503, headers: { "Cache-Control": "no-store" },
      });
    }
    const headers = new Headers(response.headers);
    headers.set("x-request-id", log.requestId);
    const correlated = new Response(response.body, {
      status: response.status, statusText: response.statusText, headers,
    });
    console.info(JSON.stringify({
      event: "api_request", ...log, status: response.status,
      resultCode: log.resultCode ?? (response.ok ? "OK" : `HTTP_${response.status}`),
    }));
    return correlated;
  });
}
