import { getAuth } from "./config";
import { getPool } from "../db/pool";

export type Role = "admin" | "worker" | "viewer";
export type Identity = {
  user: { id: string; name: string; email: string };
  tenant: { id: string; name: string };
  role: Role;
};

export class AccessError extends Error {
  constructor(public readonly status: 401 | 403 | 404, public readonly code: string) {
    super(code);
  }
}

export async function requireIdentity(headers: Headers): Promise<Identity> {
  const session = await getAuth().api.getSession({ headers });
  if (!session) throw new AccessError(401, "UNAUTHENTICATED");
  // This narrow authentication query intentionally precedes business RLS context.
  // Neither a query parameter nor a request body supplies the tenant or role.
  const result = await getPool().query<{ tenant_id: string; tenant_name: string; role: Role }>(
    `SELECT m.tenant_id, t.name AS tenant_name, m.role
       FROM memberships m JOIN tenants t ON t.id = m.tenant_id
      WHERE m.user_id = $1 AND t.active = true`,
    [session.user.id],
  );
  const membership = result.rows[0];
  if (!membership || !["admin", "worker", "viewer"].includes(membership.role)) {
    throw new AccessError(403, "MEMBERSHIP_REQUIRED");
  }
  return {
    user: { id: session.user.id, name: session.user.name, email: session.user.email },
    tenant: { id: membership.tenant_id, name: membership.tenant_name },
    role: membership.role,
  };
}

export async function getCurrentIdentity(headers: Headers): Promise<Identity | null> {
  try {
    return await requireIdentity(headers);
  } catch (error) {
    if (error instanceof AccessError) return null;
    throw error;
  }
}

export function requireRole(identity: Identity, allowed: readonly Role[]): void {
  if (!allowed.includes(identity.role)) throw new AccessError(403, "ROLE_FORBIDDEN");
}

export function apiError(error: unknown): Response {
  if (error instanceof AccessError) {
    return Response.json({ error: error.code }, { status: error.status, headers: { "Cache-Control": "no-store" } });
  }
  return Response.json({ error: "SERVICE_UNAVAILABLE" }, { status: 503, headers: { "Cache-Control": "no-store" } });
}
