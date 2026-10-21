import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import {persistApiMetric} from "./v2/workflow/metrics";
import {observeTimingCount,timeAsync,timeSync,withTimingDiagnostics} from './timing-diagnostics';

type RequestLog = {
  requestId: string;
  operation: string;
  tenantId: string | null;
  userId: string | null;
  documentId: string | null;
  resultCode?: string;
  warehouseId?: string;
  command?: string;
};
const requests = new AsyncLocalStorage<RequestLog>();
export function requestId(): string | null { return requests.getStore()?.requestId ?? null; }
export function requestWarehouse():string|null { return requests.getStore()?.warehouseId??null; }
/** Server-authenticated context only; never populated from caller-supplied identity headers. */
export function requestActor(): { userId: string; tenantId: string } | null {
  const log = requests.getStore();
  return log?.userId && log.tenantId ? { userId: log.userId, tenantId: log.tenantId } : null;
}
const safeCodes = new Set([
  "COMPANY_FROM_CREDENTIAL_ONLY", "EVENT_TOO_LARGE", "INVALID_EVENT", "UNKNOWN_EVENT_FIELD", "WAREHOUSE_REQUIRED", "EVENT_CONTENT_CONFLICT", "EVENT_NOT_RETRYABLE", "EXTERNAL_ENTITY_ALREADY_CREATED", "EXTERNAL_ENTITY_NOT_CREATED", "EXTERNAL_ENTITY_WAREHOUSE_CONFLICT", "INTEGRATION_BACKPRESSURE", "INVALID_CURSOR", "MACHINE_KEY_REQUIRED", "MISSING_PREVIOUS_REVISION", "MISSING_SHIPMENT_DEPENDENCY", "OPERATOR_RETRY", "RETRYABLE_PROCESSING_FAILURE", "REVISION_CONTENT_CONFLICT", "SHIPMENT_REFERENCE_REQUIRED", "SOURCE_SYSTEM_FORBIDDEN", "STALE_REVISION",
  "BOUNDARY_CONFLICT", "CORRECTION_APPROVAL_PENDING", "CORRECTION_FOLLOWUP_WORK_EXISTS", "CORRECTION_LIMIT_EXCEEDED", "CORRECTION_OPENING_MAPPING_REQUIRED", "CORRECTION_PAIRED_LINES_REQUIRED", "CORRECTION_REQUIRES_WORKFLOW", "CORRECTION_SOURCE_FORBIDDEN", "CORRECTION_SOURCE_MISMATCH", "CORRECTION_SOURCE_NOT_FOUND", "CUSTOMER_UNAVAILABLE", "DESTINATION_PARTNER_MISMATCH", "DESTINATION_UNAVAILABLE", "INVALID_BOUNDARY", "INVALID_CURSOR", "INVALID_LIMIT", "INVALID_TIMESTAMP", "INVALID_TIMESTAMP_RANGE", "SUPPLIER_UNAVAILABLE",
  "UNAUTHENTICATED", "MEMBERSHIP_REQUIRED", "ROLE_FORBIDDEN", "ORIGIN_FORBIDDEN",
  "CONFLICT", "REFERENCE_CONFLICT", "RETRYABLE_TRANSACTION", "SERVICE_UNAVAILABLE",
  "INVALID_INPUT", "NOT_FOUND", "INVALID_STATE", "REFERENCE_NOT_FOUND", "VERSION_CONFLICT",
  "INACTIVE_REFERENCE", "IN_USE", "DELIVERY_REQUIRED", "IDEMPOTENCY_CONFLICT",
  "INSUFFICIENT_STOCK", "STOCK_OVERFLOW", "WAREHOUSE_CUTOVER_READ_ONLY",
  "APPROVAL_ALREADY_DECIDED", "APPROVAL_FORBIDDEN", "APPROVAL_STALE", "ASSIGNEE_UNAVAILABLE", "ASSIGNMENT_FORBIDDEN", "AUTOMATION_FORBIDDEN", "BELOW_RECEIVED", "CANCELLATION_PENDING", "CANCELLATION_REQUIRED", "CLOSE_APPROVAL_REQUIRED", "DELIVERY_CORRECTION_REASON_REQUIRED", "DUPLICATE_LINE", "ENVIRONMENT_FORBIDDEN", "EXCEEDS_CANCELLABLE", "EXCEEDS_ORDER_REMAINING", "EXCEEDS_PACKABLE", "EXCEEDS_PENDING", "EXCEEDS_PICKED", "EXCEEDS_RESERVED", "EXCEEDS_RETURNABLE", "EXCEEDS_RETURN_APPROVED", "EXCEEDS_SHIPPABLE", "EXTERNAL_ID_CONFLICT", "HANDOVER_REQUIRED", "IMMUTABLE_ITEM", "IMMUTABLE_LINES", "INCOMPLETE_COUNT", "INSPECTION_REQUIRED", "INSUFFICIENT_STOCK", "INVALID_BUCKET", "INVALID_COUNT_STATE", "INVALID_DELIVERY_STATUS", "INVALID_INPUT", "INVALID_OUTCOME", "INVALID_OVERAGE", "INVALID_PACKAGES", "INVALID_PACKAGE_STATE", "INVALID_QUANTITY", "INVALID_SCANS", "INVALID_SCAN_MODE", "ITEM_SCAN_REQUIRED", "ITEM_UNAVAILABLE", "LEGACY_CUTOVER_REQUIRED", "LOCATION_BLOCKED", "LOCATION_LOCKED", "LOCATION_OCCUPIED", "LOCATION_TYPE_FORBIDDEN", "LOCATION_UNAVAILABLE", "MANUAL_ENTRY_REASON_REQUIRED", "NOT_FOUND", "OVERAGE_APPROVAL_REQUIRED", "PARTIAL_CHOICE_REQUIRED", "RECEIPT_CLOSED", "RECEIVING_ALREADY_CONFIRMED", "RECONCILIATION_FAILED", "RECOUNT_REQUIRED", "RETURN_CLOSED", "SAME_LOCATION", "SCAN_QUANTITY_MISMATCH", "SCOPE_FORBIDDEN", "SELF_APPROVAL_FORBIDDEN", "SPLIT_REQUIRED", "STOCK_OCCUPIED", "TASK_ASSIGNEE_MISMATCH", "TERMINAL_DELIVERY", "UNCONFIRMED_RESULTS", "UNKNOWN_COMMAND", "UNPACK_REQUIRED", "VERSION_CONFLICT", "WAREHOUSE_FORBIDDEN", "WAREHOUSE_UNAVAILABLE", "WRONG_ITEM_SCAN", "WRONG_LOCATION_SCAN", "LOCATION_SCAN_REQUIRED",
]);

const workflowCommands=new Set(["approval.decide", "correction.request", "count.record", "count.start", "count.submit", "count.unlock", "hold.release", "order.cancel", "order.create", "order.damage", "order.pick", "order.release", "order.reserve", "order.return_picked", "order.shortage", "order.update", "overage.request", "package.create", "package.unpack", "receipt.cancel", "receipt.close.request", "receipt.create", "receipt.inspect", "receipt.putaway", "receipt.receive", "receipt.update", "return.close", "return.inspect", "return.putaway", "return.receive", "return.request", "shift.close", "shipment.create", "shipment.delivery", "shipment.delivery.correct", "stock.hold", "stock.inspect", "stock.move", "stock.putaway", "task.assign"]);
/** Set only after a fresh server-side warehouse authorization succeeds. */
export function recordAuthorizedWarehouse(tenantId:string,warehouseId:string):void {
 const log=requests.getStore();if(log&&log.tenantId===tenantId&&/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(warehouseId))log.warehouseId=warehouseId;
}
export function recordRequestCommand(command:string):void {const log=requests.getStore();if(log&&workflowCommands.has(command))log.command=command;}

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
  }, () => withTimingDiagnostics(operation,async () => {
    const log = requests.getStore()!;
    const started=performance.now();
    let response: Response;
    try {
      if (documentRoute) {
        const context = args[1] as { params?: Promise<{ id?: unknown }> } | undefined;
        const id = (await context?.params)?.id;
        recordRequestDocument(id);
      }
      response = await timeAsync('request.handler',()=>Promise.resolve(handler(...args)));
    } catch {
      log.resultCode = "SERVICE_UNAVAILABLE";
      response = timeSync('http.json_response',()=>Response.json({ error: "SERVICE_UNAVAILABLE" }, {
        status: 503, headers: { "Cache-Control": "no-store" },
      }));
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
    observeTimingCount('http.status',response.status);observeTimingCount('http.error_responses',response.ok?0:1);
    if(log.tenantId&&log.warehouseId&&log.userId){
      const candidate=args[0] as {method?:unknown}|undefined;const method=typeof candidate?.method==='string'&&['GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS'].includes(candidate.method)?candidate.method:'GET';
      const metric={tenantId:log.tenantId,warehouseId:log.warehouseId,requestId:log.requestId,actorId:log.userId,operation,command:log.command,method,status:response.status,errorCode:log.resultCode??(response.ok?'OK':`HTTP_${response.status}`),durationMs:Math.min(2147483647,Math.max(0,Math.round(performance.now()-started)))};
      await timeAsync('request.telemetry',()=>persistApiMetric(metric));
    }
    return correlated;
  }));
}
