import { randomBytes, randomUUID } from "node:crypto";
import { hashPassword } from "better-auth/crypto";
import type { PoolClient } from "pg";
import { DomainError } from "../../api";
import { type Identity, type Role } from "../../auth/access";
import { withTenant } from "../../db/tenant";
import { requestId } from "../../request-log";
import { machineScopes, requireV2Access, tokenHash, uuid, v2Environment, v2WarehouseIds } from "../access";

const roles: Role[] = ["admin", "supervisor", "worker", "viewer"];
function invalid(): never { throw new DomainError(400, "INVALID_INPUT"); }
function text(value: unknown, limit = 128): string {
  if (typeof value !== "string" || !value.trim().length || value.trim().length > limit) invalid();
  return value.trim();
}
function fields(body: Record<string, unknown>, allowed: string[]) { if (Object.keys(body).some(key => !allowed.includes(key))) invalid(); }
function role(value: unknown): Role { if (!roles.includes(value as Role)) invalid(); return value as Role; }
function warehouseIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 100 || value.some(id => typeof id !== "string" || !uuid.test(id)) || new Set(value).size !== value.length) invalid();
  return value;
}
async function audit(client: PoolClient, identity: Identity, target: string, action: string, details: Record<string,unknown> = {}) {
  await client.query("INSERT INTO v2_identity_audit(tenant_id,actor_id,target_id,action,request_id,details) VALUES($1,$2,$3,$4,$5,$6::jsonb)", [identity.tenant.id,identity.user.id,target,action,requestId() ?? randomUUID(),JSON.stringify(details)]);
}
async function adminTransaction<T>(identity: Identity, operation: (client: PoolClient) => Promise<T>): Promise<T> {
  await requireV2Access(identity, null, "identity.manage");
  return withTenant(identity.tenant.id, async client => {
    // Every lifecycle mutation uses this lock, including final administrator changes.
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 11))", [identity.tenant.id]);
    const actor = (await client.query("SELECT role FROM memberships WHERE tenant_id=$1 AND user_id=$2 AND status='active'", [identity.tenant.id,identity.user.id])).rows[0];
    if (actor?.role !== "admin") throw new DomainError(403, "ROLE_FORBIDDEN");
    return operation(client);
  });
}
async function validateWarehouses(client: PoolClient, identity: Identity, ids: string[]) {
  if (!ids.length) return;
  const rows = await client.query(`SELECT w.id FROM warehouses w JOIN v2_warehouse_grants g ON g.tenant_id=w.tenant_id AND g.warehouse_id=w.id
    WHERE w.tenant_id=$1 AND g.user_id=$2 AND w.id=ANY($3::uuid[])`, [identity.tenant.id,identity.user.id,ids]);
  if (rows.rowCount !== ids.length) throw new DomainError(403,"WAREHOUSE_FORBIDDEN");
}
async function grants(client: PoolClient, identity: Identity, userId: string, ids: string[]) {
  await validateWarehouses(client,identity,ids);
  await client.query("DELETE FROM v2_warehouse_grants WHERE tenant_id=$1 AND user_id=$2", [identity.tenant.id,userId]);
  await client.query("INSERT INTO v2_warehouse_grants(tenant_id,user_id,warehouse_id) SELECT $1,$2,unnest($3::uuid[])",[identity.tenant.id,userId,ids]);
}
async function target(client: PoolClient, identity: Identity, userId: string) {
  const row = (await client.query("SELECT user_id,role,status FROM memberships WHERE tenant_id=$1 AND user_id=$2 FOR UPDATE", [identity.tenant.id,userId])).rows[0];
  if (!row) throw new DomainError(404,"NOT_FOUND");
  const ids=(await client.query<{warehouse_id:string}>("SELECT warehouse_id FROM v2_warehouse_grants WHERE tenant_id=$1 AND user_id=$2",[identity.tenant.id,userId])).rows.map(r=>r.warehouse_id);
  await validateWarehouses(client,identity,ids);
  return row;
}
async function issueLink(client: PoolClient, identity: Identity, userId: string, kind: "invite" | "reset", hours: unknown) {
  const ttl = hours === undefined ? 24 : hours;
  if (typeof ttl !== "number" || !Number.isInteger(ttl) || ttl < 1 || ttl > 168) invalid();
  await client.query("UPDATE v2_identity_links SET revoked_at=CURRENT_TIMESTAMP WHERE tenant_id=$1 AND user_id=$2 AND consumed_at IS NULL AND revoked_at IS NULL",[identity.tenant.id,userId]);
  const id = randomUUID();
  const token = `${identity.tenant.id}.${id}.${randomBytes(32).toString("base64url")}`;
  const expiresAt = new Date(Date.now()+ttl*3600000).toISOString();
  await client.query("INSERT INTO v2_identity_links(id,tenant_id,user_id,kind,token_hash,expires_at,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)",[id,identity.tenant.id,userId,kind,tokenHash(token),expiresAt,identity.user.id]);
  await audit(client,identity,userId,`link.${kind}.issued`);
  return {link:`/invitation?token=${encodeURIComponent(token)}`,expiresAt};
}

export async function identityContext(identity: Identity) {
  const ids = await v2WarehouseIds(identity);
  return withTenant(identity.tenant.id,async client => {
    const tenant = (await client.query("SELECT is_test,idle_lock_minutes FROM tenants WHERE id=$1",[identity.tenant.id])).rows[0];
    const warehouses = (await client.query("SELECT id,code,name FROM warehouses WHERE tenant_id=$1 AND id=ANY($2::uuid[]) ORDER BY code",[identity.tenant.id,ids])).rows;
    const assignees=(await client.query(`SELECT m.user_id AS "userId",u.name,m.role,m.status,
      ARRAY(SELECT warehouse_id::text FROM v2_warehouse_grants g WHERE g.tenant_id=m.tenant_id AND g.user_id=m.user_id AND g.warehouse_id=ANY($2::uuid[]) ORDER BY warehouse_id) AS "warehouseIds"
      FROM memberships m JOIN "user" u ON u.id=m.user_id WHERE m.tenant_id=$1 AND m.status='active'
      AND EXISTS(SELECT 1 FROM v2_warehouse_grants g WHERE g.tenant_id=m.tenant_id AND g.user_id=m.user_id AND g.warehouse_id=ANY($2::uuid[])) ORDER BY u.name`,[identity.tenant.id,ids])).rows;
    const automationAccounts=tenant.is_test && v2Environment()==="test" ? (await client.query(`SELECT 'machine:'||k.id::text AS "userId",k.name,k.role,'active'::text AS status,
      ARRAY(SELECT warehouse_id::text FROM v2_machine_warehouses g WHERE g.tenant_id=k.tenant_id AND g.key_id=k.id AND g.warehouse_id=ANY($2::uuid[]) ORDER BY warehouse_id) AS "warehouseIds"
      FROM v2_machine_keys k WHERE k.tenant_id=$1 AND k.kind='automation' AND k.environment='test'
      AND k.revoked_at IS NULL AND k.expires_at>CURRENT_TIMESTAMP AND k.scopes @> ARRAY['read','write']::text[]
      AND EXISTS(SELECT 1 FROM v2_machine_warehouses g WHERE g.tenant_id=k.tenant_id AND g.key_id=k.id AND g.warehouse_id=ANY($2::uuid[])) ORDER BY k.name,k.id`,[identity.tenant.id,ids])).rows : [];
    return {tenant:{...identity.tenant,isTest:tenant.is_test},environment:v2Environment(),idleLockMinutes:tenant.idle_lock_minutes,role:identity.role,warehouseIds:ids,warehouses,assignees,automationAccounts};
  });
}
export async function listUsers(identity: Identity) {
  await requireV2Access(identity,null,"identity.manage");
  const context = await identityContext(identity);
  const users = await withTenant(identity.tenant.id,async client => (await client.query(`SELECT m.user_id AS "userId",u.name,u.email,m.role,m.status,
    ARRAY(SELECT warehouse_id::text FROM v2_warehouse_grants g WHERE g.tenant_id=m.tenant_id AND g.user_id=m.user_id ORDER BY warehouse_id) AS "warehouseIds"
    FROM memberships m JOIN "user" u ON u.id=m.user_id WHERE m.tenant_id=$1
    AND NOT EXISTS(SELECT 1 FROM v2_warehouse_grants target WHERE target.tenant_id=m.tenant_id AND target.user_id=m.user_id
      AND NOT EXISTS(SELECT 1 FROM v2_warehouse_grants actor WHERE actor.tenant_id=target.tenant_id AND actor.user_id=$2 AND actor.warehouse_id=target.warehouse_id))
    ORDER BY u.name,m.user_id`,[identity.tenant.id,identity.user.id])).rows);
  return {users,warehouses:context.warehouses};
}
export async function inviteUser(identity: Identity, body: Record<string,unknown>) {
  fields(body,["name","email","role","warehouseIds","expiresInHours"]);
  const name=text(body.name), email=text(body.email,254).toLowerCase(), selectedRole=role(body.role), ids=warehouseIds(body.warehouseIds);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) invalid();
  return adminTransaction(identity,async client => {
    await validateWarehouses(client,identity,ids);
    const id=randomUUID();
    await client.query('INSERT INTO "user"(id,name,email) VALUES($1,$2,$3)',[id,name,email]);
    await client.query("INSERT INTO memberships(user_id,tenant_id,role,status) VALUES($1,$2,$3,'invited')",[id,identity.tenant.id,selectedRole]);
    await grants(client,identity,id,ids);
    await audit(client,identity,id,"user.invited",{role:selectedRole,warehouseIds:ids});
    return {userId:id,...await issueLink(client,identity,id,"invite",body.expiresInHours)};
  });
}
export async function updateUser(identity: Identity, userId: string, body: Record<string,unknown>) {
  fields(body,["role","status","warehouseIds"]);
  if (!Object.keys(body).length) invalid();
  const selectedRole=body.role === undefined ? undefined : role(body.role);
  if (body.status !== undefined && !["active","suspended","departed"].includes(String(body.status))) invalid();
  const ids=body.warehouseIds === undefined ? undefined : warehouseIds(body.warehouseIds);
  return adminTransaction(identity,async client => {
    const current=await target(client,identity,userId);
    if (current.status === "departed" || (current.status === "invited" && body.status === "active")) throw new DomainError(409,"INVALID_STATE");
    const nextRole=selectedRole ?? current.role, nextStatus=body.status ?? current.status;
    if (current.role === "admin" && current.status === "active" && (nextRole !== "admin" || nextStatus !== "active" || (ids && !ids.length))) {
      const peers=await client.query("SELECT 1 FROM memberships WHERE tenant_id=$1 AND role='admin' AND status='active' AND user_id<>$2",[identity.tenant.id,userId]);
      if (!peers.rowCount) throw new DomainError(409,"LAST_ADMIN_REQUIRED");
    }
    await client.query("UPDATE memberships SET role=$3,status=$4,updated_at=CURRENT_TIMESTAMP WHERE tenant_id=$1 AND user_id=$2",[identity.tenant.id,userId,nextRole,nextStatus]);
    if (ids) await grants(client,identity,userId,ids);
    await client.query('DELETE FROM "session" WHERE "userId"=$1',[userId]);
    if (nextStatus !== "active") await client.query("UPDATE v2_identity_links SET revoked_at=CURRENT_TIMESTAMP WHERE tenant_id=$1 AND user_id=$2 AND consumed_at IS NULL AND revoked_at IS NULL",[identity.tenant.id,userId]);
    await audit(client,identity,userId,"user.access.changed",{before:{role:current.role,status:current.status},after:{role:nextRole,status:nextStatus,...(ids ? {warehouseIds:ids} : {})}});
    return {ok:true};
  });
}
export async function manageLink(identity: Identity,userId: string,body: Record<string,unknown>|null) {
  if (body) { fields(body,["kind","expiresInHours"]); if (!["invite","reset"].includes(String(body.kind))) invalid(); }
  return adminTransaction(identity,async client => {
    const current=await target(client,identity,userId);
    if (!body) {
      await client.query("UPDATE v2_identity_links SET revoked_at=CURRENT_TIMESTAMP WHERE tenant_id=$1 AND user_id=$2 AND consumed_at IS NULL AND revoked_at IS NULL",[identity.tenant.id,userId]);
      await audit(client,identity,userId,"link.revoked"); return {ok:true};
    }
    const kind=body.kind as "invite"|"reset";
    if ((kind === "invite" && current.status !== "invited") || (kind === "reset" && current.status !== "active")) throw new DomainError(409,"INVALID_STATE");
    return issueLink(client,identity,userId,kind,body.expiresInHours);
  });
}
export async function acceptLink(body: Record<string,unknown>) {
  fields(body,["token","password"]);
  if (typeof body.token !== "string" || body.token.length > 200 || typeof body.password !== "string" || body.password.length < 12 || body.password.length > 128) invalid();
  const parts=body.token.split(".");
  if (parts.length !== 3 || !uuid.test(parts[0]) || !uuid.test(parts[1]) || !/^[A-Za-z0-9_-]{43}$/.test(parts[2])) throw new DomainError(400,"INVALID_LINK");
  const token=body.token, password=body.password;
  return withTenant(parts[0],async client => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 11))",[parts[0]]);
    const link=(await client.query(`SELECT l.*,m.status,t.active AS tenant_active FROM v2_identity_links l
      JOIN memberships m ON m.tenant_id=l.tenant_id AND m.user_id=l.user_id JOIN tenants t ON t.id=l.tenant_id
      WHERE l.id=$1 AND l.token_hash=$2 AND l.consumed_at IS NULL AND l.revoked_at IS NULL AND l.expires_at>CURRENT_TIMESTAMP FOR UPDATE OF l`,[parts[1],tokenHash(token)])).rows[0];
    if (!link || !link.tenant_active || (link.kind === "invite" ? link.status !== "invited" : link.status !== "active")) throw new DomainError(400,"INVALID_LINK");
    const hashed=await hashPassword(password);
    // Same Better Auth crypto/provider schema as the existing trusted auth seed.
    await client.query(`INSERT INTO account(id,"accountId","providerId","userId",password) VALUES($1,$2,'credential',$2,$3)
      ON CONFLICT("providerId","accountId") DO UPDATE SET password=EXCLUDED.password,"updatedAt"=CURRENT_TIMESTAMP`,[randomUUID(),link.user_id,hashed]);
    await client.query("UPDATE memberships SET status='active',updated_at=CURRENT_TIMESTAMP WHERE tenant_id=$1 AND user_id=$2",[parts[0],link.user_id]);
    await client.query("UPDATE v2_identity_links SET consumed_at=CURRENT_TIMESTAMP WHERE id=$1",[link.id]);
    await client.query("UPDATE v2_identity_links SET revoked_at=CURRENT_TIMESTAMP WHERE tenant_id=$1 AND user_id=$2 AND id<>$3 AND consumed_at IS NULL AND revoked_at IS NULL",[parts[0],link.user_id,link.id]);
    await client.query('DELETE FROM "session" WHERE "userId"=$1',[link.user_id]);
    await client.query("INSERT INTO v2_identity_audit(tenant_id,actor_id,target_id,action,request_id) VALUES($1,$2,$2,'link.accepted',$3)",[parts[0],link.user_id,requestId() ?? randomUUID()]);
    return {ok:true};
  });
}

export async function listKeys(identity: Identity) {
  await requireV2Access(identity,null,"identity.manage");
  return withTenant(identity.tenant.id,async client => ({keys:(await client.query(`SELECT k.id,k.name,k.source_system AS "sourceSystem",k.environment,k.kind,k.role,k.scopes,
    k.expires_at AS "expiresAt",k.revoked_at AS "revokedAt",k.created_at AS "createdAt",k.rotated_from AS "rotatedFrom",
    ARRAY(SELECT warehouse_id::text FROM v2_machine_warehouses g WHERE g.tenant_id=k.tenant_id AND g.key_id=k.id ORDER BY warehouse_id) AS "warehouseIds"
    FROM v2_machine_keys k WHERE k.tenant_id=$1
    AND NOT EXISTS(SELECT 1 FROM v2_machine_warehouses target WHERE target.tenant_id=k.tenant_id AND target.key_id=k.id
      AND NOT EXISTS(SELECT 1 FROM v2_warehouse_grants actor WHERE actor.tenant_id=target.tenant_id AND actor.user_id=$2 AND actor.warehouse_id=target.warehouse_id))
    ORDER BY k.created_at DESC,k.id`,[identity.tenant.id,identity.user.id])).rows}));
}
export async function createKey(identity: Identity,body: Record<string,unknown>) {
  fields(body,["name","sourceSystem","environment","kind","role","scopes","warehouseIds","expiresAt"]);
  const name=text(body.name),source=text(body.sourceSystem),ids=warehouseIds(body.warehouseIds);
  const kind=body.kind,env=body.environment,selectedRole=body.role ?? "worker";
  if (!["test","production"].includes(String(env)) || !["integration","automation"].includes(String(kind)) || !["worker","supervisor"].includes(String(selectedRole)) || !ids.length) invalid();
  if (!Array.isArray(body.scopes) || !body.scopes.length || body.scopes.some(s=>!machineScopes.includes(s as typeof machineScopes[number])) || new Set(body.scopes).size !== body.scopes.length) invalid();
  const scopes=body.scopes as string[];
  if (kind === "integration" && scopes.some(s=>["write","approve"].includes(s))) invalid();
  if (scopes.includes("approve") && selectedRole !== "supervisor") invalid();
  const expiry=body.expiresAt === undefined ? new Date(Date.now()+30*86400000) : new Date(String(body.expiresAt));
  if (!Number.isFinite(expiry.getTime()) || expiry.getTime() <= Date.now() || expiry.getTime() > Date.now()+366*86400000) invalid();
  return adminTransaction(identity,async client => {
    const tenant=(await client.query("SELECT is_test,idle_lock_minutes FROM tenants WHERE id=$1",[identity.tenant.id])).rows[0];
    if (env !== v2Environment() || (env === "test" && !tenant.is_test) || (kind === "automation" && (env !== "test" || !tenant.is_test))) throw new DomainError(403,"ENVIRONMENT_FORBIDDEN");
    await validateWarehouses(client,identity,ids);
    const id=randomUUID(), token=`wms_${identity.tenant.id}.${id}.${randomBytes(32).toString("base64url")}`;
    await client.query(`INSERT INTO v2_machine_keys(id,tenant_id,name,source_system,environment,kind,role,scopes,token_hash,expires_at,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[id,identity.tenant.id,name,source,env,kind,selectedRole,scopes,tokenHash(token),expiry,identity.user.id]);
    await client.query("INSERT INTO v2_machine_warehouses(tenant_id,key_id,warehouse_id) SELECT $1,$2,unnest($3::uuid[])",[identity.tenant.id,id,ids]);
    await audit(client,identity,id,"key.issued",{environment:env,kind,role:selectedRole,scopes,warehouseIds:ids});
    return {keyId:id,token};
  });
}
export async function revokeKey(identity: Identity,id: string) {
  if (!uuid.test(id)) throw new DomainError(404,"NOT_FOUND");
  return adminTransaction(identity,async client => {
    const key=(await client.query("SELECT id FROM v2_machine_keys WHERE tenant_id=$1 AND id=$2",[identity.tenant.id,id])).rows[0];
    if (!key) throw new DomainError(404,"NOT_FOUND");
    const ids=(await client.query<{warehouse_id:string}>("SELECT warehouse_id FROM v2_machine_warehouses WHERE tenant_id=$1 AND key_id=$2",[identity.tenant.id,id])).rows.map(r=>r.warehouse_id);
    await validateWarehouses(client,identity,ids);
    const result=await client.query("UPDATE v2_machine_keys SET revoked_at=COALESCE(revoked_at,CURRENT_TIMESTAMP) WHERE tenant_id=$1 AND id=$2 RETURNING id",[identity.tenant.id,id]);
    if (!result.rowCount) throw new DomainError(404,"NOT_FOUND");
    await audit(client,identity,id,"key.revoked"); return {ok:true};
  });
}

/** Rotation issues one replacement and revokes the previous secret in the same commit. */
export async function rotateKey(identity: Identity,id: string,body: Record<string,unknown>) {
  fields(body,["expiresAt"]);
  if (!uuid.test(id)) throw new DomainError(404,"NOT_FOUND");
  const expiry=body.expiresAt === undefined ? new Date(Date.now()+30*86400000) : new Date(String(body.expiresAt));
  if (!Number.isFinite(expiry.getTime()) || expiry.getTime() <= Date.now() || expiry.getTime() > Date.now()+366*86400000) invalid();
  return adminTransaction(identity,async client=>{
    const key=(await client.query("SELECT k.*,t.is_test FROM v2_machine_keys k JOIN tenants t ON t.id=k.tenant_id WHERE k.tenant_id=$1 AND k.id=$2 FOR UPDATE OF k",[identity.tenant.id,id])).rows[0];
    if (!key) throw new DomainError(404,"NOT_FOUND");
    if (key.revoked_at) throw new DomainError(409,"INVALID_STATE");
    if (key.environment !== v2Environment() || (key.environment === "test" && !key.is_test)) throw new DomainError(403,"ENVIRONMENT_FORBIDDEN");
    const ids=(await client.query<{warehouse_id:string}>("SELECT warehouse_id FROM v2_machine_warehouses WHERE tenant_id=$1 AND key_id=$2 ORDER BY warehouse_id",[identity.tenant.id,id])).rows.map(r=>r.warehouse_id);
    await validateWarehouses(client,identity,ids);
    const replacementId=randomUUID(), token=`wms_${identity.tenant.id}.${replacementId}.${randomBytes(32).toString("base64url")}`;
    await client.query(`INSERT INTO v2_machine_keys(id,tenant_id,name,source_system,environment,kind,role,scopes,token_hash,expires_at,created_by,rotated_from)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,[replacementId,identity.tenant.id,key.name,key.source_system,key.environment,key.kind,key.role,key.scopes,tokenHash(token),expiry,identity.user.id,id]);
    await client.query("INSERT INTO v2_machine_warehouses(tenant_id,key_id,warehouse_id) SELECT $1,$2,unnest($3::uuid[])",[identity.tenant.id,replacementId,ids]);
    await client.query("UPDATE v2_machine_keys SET revoked_at=CURRENT_TIMESTAMP WHERE tenant_id=$1 AND id=$2",[identity.tenant.id,id]);
    await audit(client,identity,replacementId,"key.rotated",{previousKeyId:id});
    await audit(client,identity,id,"key.revoked",{replacementKeyId:replacementId});
    return {keyId:replacementId,token};
  });
}

export async function identitySettings(identity: Identity,body: Record<string,unknown>) {
  fields(body,["idleLockMinutes"]);
  const minutes=body.idleLockMinutes;
  if(typeof minutes !== "number" || !Number.isInteger(minutes) || minutes<1 || minutes>240)invalid();
  return adminTransaction(identity,async client=>{
    await client.query("UPDATE tenants SET idle_lock_minutes=$2 WHERE id=$1",[identity.tenant.id,minutes]);
    await audit(client,identity,identity.tenant.id,"settings.idle.changed",{idleLockMinutes:minutes});
    return {idleLockMinutes:minutes};
  });
}
