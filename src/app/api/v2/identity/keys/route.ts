import { identityHttp } from "@/server/v2/identity/http";
import { withRequestLog } from "@/server/request-log";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = withRequestLog("v2.identity.keys.get", async (request: Request) => identityHttp(request,"keys"));
export const POST = withRequestLog("v2.identity.keys.post", async (request: Request) => identityHttp(request,"keys"));
