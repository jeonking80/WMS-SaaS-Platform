import { withRequestLog } from "@/server/request-log";
import { masterCollection } from "@/server/master-data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function handleGET(request: Request) { return masterCollection(request, "items"); }
async function handlePOST(request: Request) { return masterCollection(request, "items"); }

export const GET = withRequestLog("items.list", handleGET);

export const POST = withRequestLog("items.create", handlePOST);
