import { identityHttp } from "@/server/v2/identity/http";
import { withRequestLog } from "@/server/request-log";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const PATCH = withRequestLog("v2.identity.user.patch", async (request: Request, context: {params:Promise<{id:string}>}) => identityHttp(request,"user",context));
