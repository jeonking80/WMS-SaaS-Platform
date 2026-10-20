import { recordRequestDocument, withRequestLog } from "@/server/request-log";
import { apiError, json, readBody, requireMutationOrigin } from "@/server/api";
import { requireIdentity, requireRole } from "@/server/auth/access";
import { createDocument, parseDocument } from "@/server/documents";
import { pagedDocuments, parseQuery } from "@/server/queries";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
async function handleGET(request: Request) {
  try {
    const identity = await requireIdentity(request.headers);
    const params = new URL(request.url).searchParams;
    const history = params.get("view") === "history";
    if (!history) requireRole(identity, ["admin", "worker"]);
    return json(await pagedDocuments(identity.tenant.id, parseQuery(params), history));
  } catch (error) { return apiError(error); }
}
async function handlePOST(request: Request) {
  try {
    const identity = await requireIdentity(request.headers);
    requireRole(identity, ["admin", "worker"]);
    requireMutationOrigin(request);
    const input = parseDocument(await readBody(request));
    const document = await createDocument(identity.tenant.id, input);
    recordRequestDocument(document.id);
    return json({ document }, 201);
  } catch (error) { return apiError(error); }
}

export const GET = withRequestLog("documents.list", handleGET);

export const POST = withRequestLog("documents.create", handlePOST);
