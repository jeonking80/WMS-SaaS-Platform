import { withRequestLog } from "@/server/request-log";
import { masterCollection } from "@/server/master-data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function handleGET(request: Request) { return masterCollection(request, "locations"); }
async function handlePOST(request: Request) { return masterCollection(request, "locations"); }

export const GET = withRequestLog("locations.list", handleGET);

export const POST = withRequestLog("locations.create", handlePOST);
