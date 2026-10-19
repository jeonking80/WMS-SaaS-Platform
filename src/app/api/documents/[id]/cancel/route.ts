import { apiError, json, readBody, requireMutationOrigin } from "@/server/api";
import { requireIdentity, requireRole } from "@/server/auth/access";
import { documentVersion, updateDocument } from "@/server/documents";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const identity = await requireIdentity(request.headers);
    requireRole(identity, ["admin", "worker"]);
    requireMutationOrigin(request);
    const body = await readBody(request);
    return json({ document: await updateDocument(identity.tenant.id, (await context.params).id, documentVersion(body.version)) });
  } catch (error) { return apiError(error); }
}
