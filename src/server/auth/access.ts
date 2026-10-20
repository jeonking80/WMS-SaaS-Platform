import { recordAuthenticatedUser, recordRequestIdentity, recordRequestResult } from "../request-log";
import { getAuth } from "./config";
import { getPool } from "../db/pool";

export type Role = "admin" | "supervisor" | "worker" | "viewer";
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
  recordAuthenticatedUser(session.user.id);
  // This narrow authentication query intentionally precedes business RLS context.
  // Neither a query parameter nor a request body supplies the tenant or role.
  const result = await getPool().query<{ tenant_id: string; tenant_name: string; role: Role; idle_lock_minutes: number }>(
    `SELECT m.tenant_id, t.name AS tenant_name, m.role, t.idle_lock_minutes
       FROM memberships m JOIN tenants t ON t.id = m.tenant_id
      WHERE m.user_id = $1 AND m.status = 'active' AND t.active = true`,
    [session.user.id],
  );
  const membership = result.rows[0];
  if (!membership || !["admin", "supervisor", "worker", "viewer"].includes(membership.role)) {
    throw new AccessError(403, "MEMBERSHIP_REQUIRED");
  }
  // Public auth/session polling cannot extend this server-side protected-request idle window.
  // The conditional update serializes concurrent requests and refuses sessions already past the limit.
  const sessionId = session.session?.id;
  if (!sessionId) throw new AccessError(401, "UNAUTHENTICATED");
  const active = await getPool().query<{id:string}>(`UPDATE "session" SET last_protected_at=CURRENT_TIMESTAMP
    WHERE id=$1 AND "userId"=$2 AND "expiresAt">CURRENT_TIMESTAMP
      AND last_protected_at>CURRENT_TIMESTAMP-($3::integer*interval '1 minute') RETURNING id`,
    [sessionId,session.user.id,membership.idle_lock_minutes ?? 15]);
  if (!active.rows.length) {
    await getPool().query('DELETE FROM "session" WHERE id=$1 AND "userId"=$2',[sessionId,session.user.id]);
    throw new AccessError(401, "UNAUTHENTICATED");
  }
  const identity: Identity = {
    user: { id: session.user.id, name: session.user.name, email: session.user.email },
    tenant: { id: membership.tenant_id, name: membership.tenant_name },
    role: membership.role,
  };
  recordRequestIdentity(identity);
  return identity;
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
    recordRequestResult(error.code);
    return Response.json({ error: error.code }, { status: error.status, headers: { "Cache-Control": "no-store" } });
  }
  recordRequestResult("SERVICE_UNAVAILABLE");
  return Response.json({ error: "SERVICE_UNAVAILABLE" }, { status: 503, headers: { "Cache-Control": "no-store" } });
}
