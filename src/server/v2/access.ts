import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { AccessError, requireIdentity, type Identity, type Role } from "../auth/access";
import { withTenant } from "../db/tenant";
import { recordAuthorizedWarehouse, recordRequestIdentity } from "../request-log";

export type V2MachineIdentity = Identity & {
  tenant: Identity["tenant"] & { isTest: boolean };
  keyId: string; sourceSystem: string; environment: "test" | "production";
  scopes: string[]; warehouseIds: string[]; kind: "integration" | "automation";
};
export const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const machineScopes = ["read", "write", "approve", "master.write", "integration:event", "integration:read", "integration:process", "integration.receive", "integration.read", "integration.process"] as const;
export function tokenHash(token: string): string { return createHash("sha256").update(token).digest("hex"); }
export function v2Environment(): "test" | "production" { return process.env.WMS_ENVIRONMENT === "test" ? "test" : "production"; }

function permitted(role: Role, permission: string): boolean {
  if (permission === "read") return true;
  if (permission === "write") return role !== "viewer";
  if (permission === "approve" || permission === "master.write") return role === "admin" || role === "supervisor";
  return permission === "identity.manage" && role === "admin";
}

/** Re-read current membership and explicit warehouse grant; never trust a session's old role. */
export async function requireV2Access(identity: Identity, warehouseId: string | null, permission: string): Promise<void> {
  if (warehouseId !== null && !uuid.test(warehouseId)) throw new AccessError(404, "NOT_FOUND");
  if ("keyId" in identity) {
    const machine = identity as V2MachineIdentity;
    await inspectMachine(machine.tenant.id, machine.keyId, null, permission, warehouseId);
    if (warehouseId !== null) recordAuthorizedWarehouse(identity.tenant.id,warehouseId);
    return;
  }
  await withTenant(identity.tenant.id, async client => {
    const result = await client.query<{ role: Role }>(`SELECT m.role FROM memberships m JOIN tenants t ON t.id=m.tenant_id
      WHERE m.tenant_id=$1 AND m.user_id=$2 AND m.status='active' AND t.active`, [identity.tenant.id, identity.user.id]);
    const current = result.rows[0];
    if (!current) throw new AccessError(403, "MEMBERSHIP_REQUIRED");
    if (!permitted(current.role, permission)) throw new AccessError(403, "ROLE_FORBIDDEN");
    if (warehouseId !== null && !(await client.query(`SELECT 1 FROM v2_warehouse_grants g JOIN warehouses w ON w.tenant_id=g.tenant_id AND w.id=g.warehouse_id
      WHERE g.tenant_id=$1 AND g.user_id=$2 AND g.warehouse_id=$3`, [identity.tenant.id, identity.user.id, warehouseId])).rowCount) {
      throw new AccessError(403, "WAREHOUSE_FORBIDDEN");
    }
  });
  if (warehouseId !== null) recordAuthorizedWarehouse(identity.tenant.id,warehouseId);
}

async function inspectMachine(tenantId: string, keyId: string, hash: string | null, permission: string, warehouseId: string | null): Promise<V2MachineIdentity> {
  return withTenant(tenantId, client => inspectMachineInTransaction(client,tenantId,keyId,hash,permission,warehouseId));
}

async function inspectMachineInTransaction(client:PoolClient,tenantId:string,keyId:string,hash:string|null,permission:string,warehouseId:string|null):Promise<V2MachineIdentity> {
    // Never change an existing transaction's tenant to make a key visible. A process
    // credential may differ from the queued source key, but both belong to this tenant.
    const context=(await client.query<{tenant_id:string|null;environment:string|null}>("SELECT NULLIF(current_setting('app.tenant_id',true),'') AS tenant_id,NULLIF(current_setting('app.environment',true),'') AS environment")).rows[0];
    if(context?.tenant_id?.toLowerCase()!==tenantId.toLowerCase())throw new AccessError(403,"TENANT_CONTEXT_MISMATCH");
    if(context.environment!==null&&context.environment!==v2Environment())throw new AccessError(403,"ENVIRONMENT_FORBIDDEN");
    // As before, this is a fresh READ COMMITTED authorization read without row locks.
    // Statement time keeps expiry fresh even when the caller's transaction began earlier.
    const result = await client.query(`SELECT k.id,k.name,k.source_system,k.environment,k.kind,k.role,k.scopes,t.name AS tenant_name,t.is_test,
      ARRAY(SELECT warehouse_id::text FROM v2_machine_warehouses g WHERE g.tenant_id=k.tenant_id AND g.key_id=k.id ORDER BY warehouse_id) AS warehouse_ids
      FROM v2_machine_keys k JOIN tenants t ON t.id=k.tenant_id
      WHERE k.id=$1 AND k.tenant_id=$2 AND k.revoked_at IS NULL AND k.expires_at>statement_timestamp()
      AND t.active AND ($3::text IS NULL OR k.token_hash=$3)`, [keyId, tenantId, hash]);
    const key = result.rows[0];
    if (!key) throw new AccessError(401, "INVALID_MACHINE_KEY");
    if (key.environment !== v2Environment() || (key.environment === "test" && !key.is_test) || (key.kind === "automation" && (v2Environment() !== "test" || !key.is_test))) {
      throw new AccessError(403, "ENVIRONMENT_FORBIDDEN");
    }
    if (!key.scopes.includes(permission)) throw new AccessError(403, "SCOPE_FORBIDDEN");
    if (key.kind === "integration" && ["write", "approve", "identity.manage"].includes(permission)) throw new AccessError(403, "SCOPE_FORBIDDEN");
    if (permission === "approve" && key.role !== "supervisor") throw new AccessError(403, "ROLE_FORBIDDEN");
    if (!key.warehouse_ids.length || (warehouseId !== null && (!uuid.test(warehouseId) || !key.warehouse_ids.includes(warehouseId)))) throw new AccessError(403, "WAREHOUSE_FORBIDDEN");
    return { user: { id: `machine:${key.id}`, name: key.name, email: "" }, tenant: { id: tenantId, name: key.tenant_name, isTest: key.is_test }, role: key.role,
      keyId: key.id, sourceSystem: key.source_system, environment: key.environment, kind: key.kind, scopes: key.scopes, warehouseIds: key.warehouse_ids };
}

/** Secret is verified on every request against a tenant-isolated SHA-256 digest. */
export async function authenticateV2Machine(headers: Headers, permission: string, warehouseId: string | null = null): Promise<V2MachineIdentity> {
  const bearer = headers.get("authorization");
  const token = bearer?.match(/^Bearer (wms_([^ .]+)\.([^ .]+)\.([A-Za-z0-9_-]{43}))$/);
  if (!token || !uuid.test(token[2]) || !uuid.test(token[3])) throw new AccessError(401, "INVALID_MACHINE_KEY");
  const identity = await inspectMachine(token[2], token[3], tokenHash(token[1]), permission, warehouseId);
  recordRequestIdentity(identity);
  if (warehouseId !== null) recordAuthorizedWarehouse(identity.tenant.id,warehouseId);
  return identity;
}

export async function v2WarehouseIds(identity: Identity): Promise<string[]> {
  await requireV2Access(identity, null, "read");
  if ("keyId" in identity) return (identity as V2MachineIdentity).warehouseIds;
  return withTenant(identity.tenant.id, async client => (await client.query<{ warehouse_id: string }>(
    "SELECT warehouse_id FROM v2_warehouse_grants WHERE tenant_id=$1 AND user_id=$2 ORDER BY warehouse_id", [identity.tenant.id,identity.user.id])).rows.map(row => row.warehouse_id));
}

/** Trusted queued jobs re-check the issuing key before applying a stored event. */
export async function assertV2MachineKey(tenantId: string, keyId: string, permission: string, warehouseId: string | null = null): Promise<V2MachineIdentity> {
  if (!uuid.test(tenantId) || !uuid.test(keyId)) throw new AccessError(401, "INVALID_MACHINE_KEY");
  return inspectMachine(tenantId,keyId,null,permission,warehouseId);
}
/** Re-check a queued source key on the caller's already tenant-scoped transaction;
 * this performs every live key/tenant/environment/scope/warehouse check without acquiring a pool client. */
export async function assertV2MachineKeyInTransaction(client:PoolClient,tenantId:string,keyId:string,permission:string,warehouseId:string|null=null):Promise<V2MachineIdentity> {
  if(!uuid.test(tenantId)||!uuid.test(keyId))throw new AccessError(401,"INVALID_MACHINE_KEY");
  return inspectMachineInTransaction(client,tenantId,keyId,null,permission,warehouseId);
}
export async function requireV2Identity(headers: Headers, permission = "read", warehouseId: string | null = null): Promise<Identity> {
  const identity = headers.has("authorization") ? await authenticateV2Machine(headers,permission,warehouseId) : await requireIdentity(headers);
  await requireV2Access(identity,warehouseId,permission);
  return identity;
}
