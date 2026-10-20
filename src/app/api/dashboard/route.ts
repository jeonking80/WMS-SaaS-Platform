import { withRequestLog } from "@/server/request-log";
import { dashboardRequest } from "@/server/dashboard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
async function handleGET(request: Request) { return dashboardRequest(request); }

export const GET = withRequestLog("dashboard", handleGET);
