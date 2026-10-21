import { apiError, DomainError, json } from "../../api";
import { requireIdentity } from "../../auth/access";
import { authenticateV2Machine, requireV2Access } from "../access";
import { BackpressureError } from "./index";
import { uuid } from "./contract";
export async function integrationReader(request: Request, warehouseId: string, process = false) {
  if (!uuid(warehouseId)) throw new DomainError(400, "WAREHOUSE_REQUIRED");
  if (request.headers.has("authorization"))
    return authenticateV2Machine(request.headers, process ? "integration:process" : "integration:read", warehouseId);
  const identity = await requireIdentity(request.headers);
  await requireV2Access(identity, warehouseId, process ? "approve" : "read");
  return identity;
}
export function integrationError(error: unknown) {
  if (error instanceof BackpressureError) {
    const response = json({ error: error.code, retry_after: error.retryAfter }, 429);
    response.headers.set("Retry-After", String(error.retryAfter));
    return response;
  }
  return apiError(error);
}
