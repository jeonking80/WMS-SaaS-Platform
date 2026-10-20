import { withRequestLog } from "@/server/request-log";
import { apiError, json } from "@/server/api";
import { requireIdentity } from "@/server/auth/access";
import { pagedLedger, parseQuery } from "@/server/queries";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
async function handleGET(request: Request) {
  try {
    const identity = await requireIdentity(request.headers);
    return json(await pagedLedger(identity.tenant.id, parseQuery(new URL(request.url).searchParams)));
  } catch (error) { return apiError(error); }
}

export const GET = withRequestLog("stock_ledger.list", handleGET);
