import { withRequestLog } from "@/server/request-log";
import { destinationCollection } from "@/server/delivery-destinations";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
async function handleGET(request: Request) { return destinationCollection(request); }
async function handlePOST(request: Request) { return destinationCollection(request); }

export const GET = withRequestLog("delivery_destinations.list", handleGET);

export const POST = withRequestLog("delivery_destinations.create", handlePOST);
