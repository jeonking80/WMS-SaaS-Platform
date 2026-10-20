import { identityHttp } from "@/server/v2/identity/http";
import { withRequestLog } from "@/server/request-log";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = withRequestLog("v2.identity.context.get", async (request: Request) => identityHttp(request,"context"));
