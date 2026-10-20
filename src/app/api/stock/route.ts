import { apiError, json } from "@/server/api";
import { requireIdentity } from "@/server/auth/access";
import { pagedStock, parseQuery } from "@/server/queries";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    const identity = await requireIdentity(request.headers);
    return json(await pagedStock(identity.tenant.id, parseQuery(new URL(request.url).searchParams)));
  } catch (error) { return apiError(error); }
}
