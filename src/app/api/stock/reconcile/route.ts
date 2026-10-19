import { apiError, json } from "@/server/api";
import { requireIdentity } from "@/server/auth/access";
import { reconcileStock } from "@/server/stock";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    const identity = await requireIdentity(request.headers);
    return json(await reconcileStock(identity.tenant.id));
  } catch (error) { return apiError(error); }
}
