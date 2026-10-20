import { withRequestLog } from "@/server/request-log";
import { masterCollection } from "@/server/master-data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function handleGET(request: Request) { return masterCollection(request, "warehouses"); }
async function handlePOST(request: Request) { return masterCollection(request, "warehouses"); }

export const GET = withRequestLog("warehouses.list", handleGET);

export const POST = withRequestLog("warehouses.create", handlePOST);
