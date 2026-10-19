import { apiError, json, readBody, requireMutationOrigin } from "@/server/api";
import { requireIdentity, requireRole } from "@/server/auth/access";
import { createDocument, listDocuments, parseDocument } from "@/server/documents";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    const identity = await requireIdentity(request.headers);
    requireRole(identity, ["admin", "worker"]);
    return json({ documents: await listDocuments(identity.tenant.id) });
  } catch (error) { return apiError(error); }
}
export async function POST(request: Request) {
  try {
    const identity = await requireIdentity(request.headers);
    requireRole(identity, ["admin", "worker"]);
    requireMutationOrigin(request);
    const input = parseDocument(await readBody(request));
    return json({ document: await createDocument(identity.tenant.id, input) }, 201);
  } catch (error) { return apiError(error); }
}
