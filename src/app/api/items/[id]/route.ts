import { AccessError, apiError, requireIdentity, requireRole } from "@/server/auth/access";
import { withTenant } from "@/server/db/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const identity = await requireIdentity(request.headers);
    requireRole(identity, ["admin", "worker"]);
    const { id } = await context.params;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      throw new AccessError(404, "NOT_FOUND");
    }
    const item = await withTenant(identity.tenant.id, async (client) => {
      const result = await client.query("SELECT id, code, name, active FROM items WHERE id = $1", [id]);
      return result.rows[0];
    });
    if (!item) throw new AccessError(404, "NOT_FOUND");
    return Response.json({ item }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiError(error);
  }
}
