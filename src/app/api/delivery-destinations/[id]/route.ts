import { withRequestLog } from "@/server/request-log";
import { destinationDetail } from "@/server/delivery-destinations";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
async function handleGET(request: Request, context: Context) { return destinationDetail(request, context); }
async function handlePATCH(request: Request, context: Context) { return destinationDetail(request, context); }

export const GET = withRequestLog("delivery_destinations.read", handleGET);

export const PATCH = withRequestLog("delivery_destinations.update", handlePATCH);
