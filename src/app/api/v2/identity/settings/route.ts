import { identityHttp } from "@/server/v2/identity/http";
import { withRequestLog } from "@/server/request-log";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const PATCH = withRequestLog("v2.identity.settings", async (request:Request) => identityHttp(request,"settings"));
