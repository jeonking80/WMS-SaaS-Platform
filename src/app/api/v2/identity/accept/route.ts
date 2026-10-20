import { identityHttp } from "@/server/v2/identity/http";
import { withRequestLog } from "@/server/request-log";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = withRequestLog("v2.identity.accept.post", async (request: Request) => identityHttp(request,"accept"));
