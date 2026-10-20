import { withRequestLog } from "@/server/request-log";
import { masterDetail } from "@/server/master-data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };
async function handleGET(request: Request, context: Context) { return masterDetail(request, context, "locations"); }
async function handlePATCH(request: Request, context: Context) { return masterDetail(request, context, "locations"); }

export const GET = withRequestLog("locations.read", handleGET);

export const PATCH = withRequestLog("locations.update", handlePATCH);
