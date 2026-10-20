import { withRequestLog } from "@/server/request-log";
import { apiError, json } from "@/server/api";
import { requireIdentity } from "@/server/auth/access";
import { listLookups } from "@/server/queries";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
async function handleGET(request: Request) {
  try {
    const identity = await requireIdentity(request.headers);
    return json(await listLookups(identity.tenant.id));
  } catch (error) { return apiError(error); }
}

export const GET = withRequestLog("lookups.list", handleGET);
