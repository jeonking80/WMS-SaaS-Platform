import { withRequestLog } from "@/server/request-log";
import { DomainError, apiError, json, readBody, requireMutationOrigin } from "@/server/api";
import { requireIdentity, requireRole } from "@/server/auth/access";
import { documentVersion } from "@/server/documents";
import { idempotencyKey } from "@/server/posting";
import { reverseDocument } from "@/server/reverse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function handlePOST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const identity = await requireIdentity(request.headers);
    requireRole(identity, ["admin"]);
    requireMutationOrigin(request);
    const key = idempotencyKey(request.headers.get("idempotency-key"));
    const body = await readBody(request);
    if (Object.keys(body).some(field => field !== "version")) {
      throw new DomainError(400, "INVALID_INPUT");
    }
    return json(await reverseDocument(identity, (await context.params).id, documentVersion(body.version), key));
  } catch (error) { return apiError(error); }
}

export const POST = withRequestLog("documents.reverse", handlePOST, true);
