import { apiError, requireIdentity, requireRole } from "@/server/auth/access";
import { withTenant } from "@/server/db/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// P1 read-only slice for verifying the authorization boundary. CRUD UI is P2.
export async function GET(request: Request) {
  try {
    const identity = await requireIdentity(request.headers);
    requireRole(identity, ["admin", "worker"]);
    const items = await withTenant(identity.tenant.id, async (client) => {
      const result = await client.query(
        "SELECT id, code, name, active FROM items ORDER BY code, id LIMIT 100",
      );
      return result.rows;
    });
    return Response.json({ items }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiError(error);
  }
}
