import { withRequestLog } from "@/server/request-log";
import { masterDetail } from "@/server/master-data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };
async function handleGET(request: Request, context: Context) { return masterDetail(request, context, "warehouses"); }
async function handlePATCH(request: Request, context: Context) { return masterDetail(request, context, "warehouses"); }

export const GET = withRequestLog("warehouses.read", handleGET);

export const PATCH = withRequestLog("warehouses.update", handlePATCH);
