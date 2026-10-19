import { apiError, json } from "@/server/api";
import { requireIdentity } from "@/server/auth/access";
import { listStock } from "@/server/stock";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    const identity = await requireIdentity(request.headers);
    return json({ stock: await listStock(identity.tenant.id) });
  } catch (error) { return apiError(error); }
}
