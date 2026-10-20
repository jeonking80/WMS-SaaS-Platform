import { identityHttp } from "@/server/v2/identity/http";
import { withRequestLog } from "@/server/request-log";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = withRequestLog("v2.identity.users.get", async (request: Request) => identityHttp(request,"users"));
export const POST = withRequestLog("v2.identity.users.post", async (request: Request) => identityHttp(request,"users"));
