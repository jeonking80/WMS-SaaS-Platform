import { withRequestLog } from "@/server/request-log";
import { apiError, json } from "@/server/api";
import { requireIdentity } from "@/server/auth/access";
import { searchMaster } from "@/server/master-search";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
async function handleGET(request: Request) {
  try {
    const identity = await requireIdentity(request.headers);
    return json(await searchMaster(identity.tenant.id, "items", new URL(request.url).searchParams, true));
  } catch (error) { return apiError(error); }
}

export const GET = withRequestLog("item_options.list", handleGET);
