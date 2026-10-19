import { masterDetail } from "@/server/master-data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, context: Context) { return masterDetail(request, context, "locations"); }
export async function PATCH(request: Request, context: Context) { return masterDetail(request, context, "locations"); }
