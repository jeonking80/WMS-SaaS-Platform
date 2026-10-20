import { withRequestLog } from "@/server/request-log";
export const dynamic = "force-dynamic";

function handleGET() {
  return Response.json({ status: "ok" }, { headers: { "Cache-Control": "no-store" } });
}

export const GET = withRequestLog("health", handleGET);
