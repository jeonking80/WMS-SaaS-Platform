import { apiError, json, readBody, requireMutationOrigin } from "@/server/api";
import { requireIdentity, requireRole } from "@/server/auth/access";
import { documentVersion, getDocument, parseDocument, updateDocument } from "@/server/documents";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, context: Context) {
  try {
    const identity = await requireIdentity(request.headers);
    const history = new URL(request.url).searchParams.get("view") === "history";
    if (!history) requireRole(identity, ["admin", "worker"]);
    return json({ document: await getDocument(identity.tenant.id, (await context.params).id, history) });
  } catch (error) { return apiError(error); }
}
export async function PATCH(request: Request, context: Context) {
  try {
    const identity = await requireIdentity(request.headers);
    requireRole(identity, ["admin", "worker"]);
    requireMutationOrigin(request);
    const body = await readBody(request);
    return json({ document: await updateDocument(identity.tenant.id, (await context.params).id, documentVersion(body.version), parseDocument(body)) });
  } catch (error) { return apiError(error); }
}
