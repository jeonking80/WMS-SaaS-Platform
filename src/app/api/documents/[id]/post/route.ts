import { apiError, json, readBody, requireMutationOrigin } from "@/server/api";
import { requireIdentity, requireRole } from "@/server/auth/access";
import { documentVersion } from "@/server/documents";
import { idempotencyKey, postInbound } from "@/server/posting";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const identity = await requireIdentity(request.headers);
    requireRole(identity, ["admin", "worker"]);
    requireMutationOrigin(request);
    const key = idempotencyKey(request.headers.get("idempotency-key"));
    const body = await readBody(request);
    return json(await postInbound(identity, (await context.params).id, documentVersion(body.version), key));
  } catch (error) { return apiError(error); }
}
