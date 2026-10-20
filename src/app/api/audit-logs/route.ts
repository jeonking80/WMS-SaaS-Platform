import { withRequestLog } from "@/server/request-log";
import { apiError, json } from "@/server/api";
import { requireIdentity, requireRole } from "@/server/auth/access";
import { pagedAuditLogs, parseQuery } from "@/server/queries";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
async function handleGET(request: Request) {
  try {
    const identity = await requireIdentity(request.headers);
    requireRole(identity, ["admin"]);
    return json(await pagedAuditLogs(identity.tenant.id, parseQuery(new URL(request.url).searchParams)));
  } catch (error) { return apiError(error); }
}

export const GET = withRequestLog("audit_logs.list", handleGET);
