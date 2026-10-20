import { apiError, json } from "@/server/api";
import { requireIdentity, requireRole } from "@/server/auth/access";
import { pagedAuditLogs, parseQuery } from "@/server/queries";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    const identity = await requireIdentity(request.headers);
    requireRole(identity, ["admin"]);
    return json(await pagedAuditLogs(identity.tenant.id, parseQuery(new URL(request.url).searchParams)));
  } catch (error) { return apiError(error); }
}
