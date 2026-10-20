import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { migrate } from "../../scripts/db-migrate.mjs";
const state=vi.hoisted(()=>({pool:undefined as pg.Pool|undefined}));
vi.mock("../../src/server/db/pool",()=>({getPool:()=>state.pool}));
import { getAuth } from "../../src/server/auth/config";
import { requireIdentity, type Identity } from "../../src/server/auth/access";
import { withTenant } from "../../src/server/db/tenant";
import { authenticateV2Machine, requireV2Access, tokenHash } from "../../src/server/v2/access";
import { acceptLink, createKey, identitySettings, identityContext, inviteUser, listKeys, listUsers, manageLink, revokeKey, rotateKey, updateUser } from "../../src/server/v2/identity/service";

const databaseUrl=process.env.TEST_DATABASE_URL;
if (!databaseUrl || !decodeURIComponent(new URL(databaseUrl).pathname).endsWith("_test")) throw new Error("A dedicated TEST_DATABASE_URL ending in _test is required.");
const schema=`identity_${randomUUID().replaceAll("-","")}`, appRole=`app_${randomUUID().replaceAll("-","")}`, appPassword=randomBytes(32).toString("hex");
const owner=new pg.Pool({connectionString:databaseUrl});
const tenantA=randomUUID(),tenantB=randomUUID(),warehouseA=randomUUID(),warehouseA2=randomUUID(),warehouseB=randomUUID();
const adminId=randomUUID();
const admin:Identity={user:{id:adminId,name:"Company admin",email:"admin@identity.invalid"},tenant:{id:tenantA,name:"Test A"},role:"admin"};
let roleCreated=false;
const tokenFrom=(link:string)=>new URL(link,"http://localhost:3000").searchParams.get("token")!;
async function invite(email:string,role="worker",ids=[warehouseA]) { return inviteUser(admin,{name:"Invited user",email,role,warehouseIds:ids}); }
async function activate(email:string,role="worker",ids=[warehouseA]) {
  const invitation=await invite(email,role,ids);
  await acceptLink({token:tokenFrom(invitation.link),password:"valid-identity-password-2026"});
  return {...admin,user:{id:invitation.userId,name:"Invited user",email},role:role as Identity["role"]};
}
beforeAll(async()=>{
  process.env.WMS_ENVIRONMENT="test";
  process.env.BETTER_AUTH_URL="http://localhost:3000";
  process.env.BETTER_AUTH_SECRET=randomBytes(48).toString("hex");
  await migrate(databaseUrl,{schema,migrationsSchema:schema,createSchema:true,createMigrationsSchema:true,log:()=>{}});
  await owner.query(`CREATE ROLE "${appRole}" LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD ${pg.escapeLiteral(appPassword)}`); roleCreated=true;
  await owner.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${appRole}"`);
  await owner.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA "${schema}" TO "${appRole}"`);
  const url=new URL(databaseUrl);url.username=appRole;url.password=appPassword;
  state.pool=new pg.Pool({connectionString:url.toString(),options:`-c search_path=${schema}`,max:5});
  await owner.query(`INSERT INTO "${schema}".tenants(id,name,is_test) VALUES($1,'Test A',true),($2,'Production B',false)`,[tenantA,tenantB]);
  await owner.query(`INSERT INTO "${schema}".warehouses(id,tenant_id,code,name) VALUES($1,$2,'A','Warehouse A'),($3,$2,'A2','Warehouse A2'),($4,$5,'B','Warehouse B')`,[warehouseA,tenantA,warehouseA2,warehouseB,tenantB]);
  await owner.query(`INSERT INTO "${schema}"."user"(id,name,email) VALUES($1,'Company admin','admin@identity.invalid')`,[adminId]);
  await owner.query(`INSERT INTO "${schema}".memberships(user_id,tenant_id,role) VALUES($1,$2,'admin')`,[adminId,tenantA]);
  await withTenant(tenantA,c=>c.query("INSERT INTO v2_warehouse_grants(tenant_id,user_id,warehouse_id) VALUES($1,$2,$3),($1,$2,$4)",[tenantA,adminId,warehouseA,warehouseA2]));
});
afterAll(async()=>{
  await state.pool?.end();
  try { await owner.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
  finally { try {if(roleCreated)await owner.query(`DROP ROLE "${appRole}"`);} finally {await owner.end();} }
});

describe("IAM real PostgreSQL lifecycle and boundaries",()=>{
  it("stores only link hashes and accepts invitations once through Better Auth credentials",async()=>{
    const invitation=await invite("first@identity.invalid"),token=tokenFrom(invitation.link);
    const stored=await withTenant(tenantA,async c=>(await c.query("SELECT token_hash,kind FROM v2_identity_links WHERE user_id=$1",[invitation.userId])).rows[0]);
    expect(stored).toEqual({token_hash:tokenHash(token),kind:"invite"});
    expect(JSON.stringify(stored).includes(token)).toBe(false);
    await acceptLink({token,password:"valid-identity-password-2026"});
    await expect(acceptLink({token,password:"valid-identity-password-2026"})).rejects.toMatchObject({code:"INVALID_LINK"});
    const login=await getAuth().handler(new Request("http://localhost:3000/api/auth/sign-in/email",{method:"POST",headers:{"content-type":"application/json",origin:"http://localhost:3000"},body:JSON.stringify({email:"first@identity.invalid",password:"valid-identity-password-2026"})}));
    expect(login.status).toBe(200);
    const cookies=login.headers.getSetCookie().map(value=>value.split(";")[0]).join("; ");
    const headers=new Headers({cookie:cookies});
    expect((await requireIdentity(headers)).user.id).toBe(invitation.userId);
    await updateUser(admin,invitation.userId,{status:"suspended"});
    await expect(requireIdentity(headers)).rejects.toMatchObject({status:401});
  });
  it("invalidates old/expired/cancelled invitation links and prevents another tenant's email reassignment",async()=>{
    const invitation=await invite("reissue@identity.invalid"),first=tokenFrom(invitation.link);
    const next=await manageLink(admin,invitation.userId,{kind:"invite"});
    if (!("link" in next)) throw new Error("Expected link");
    await expect(acceptLink({token:first,password:"valid-identity-password-2026"})).rejects.toMatchObject({code:"INVALID_LINK"});
    await withTenant(tenantA,c=>c.query("UPDATE v2_identity_links SET expires_at=CURRENT_TIMESTAMP-interval '1 minute' WHERE user_id=$1",[invitation.userId]));
    await expect(acceptLink({token:tokenFrom(next.link),password:"valid-identity-password-2026"})).rejects.toMatchObject({code:"INVALID_LINK"});
    const cancelled=await manageLink(admin,invitation.userId,{kind:"invite"});
    await manageLink(admin,invitation.userId,null);
    if (!("link" in cancelled)) throw new Error("Expected link");
    await expect(acceptLink({token:tokenFrom(cancelled.link),password:"valid-identity-password-2026"})).rejects.toMatchObject({code:"INVALID_LINK"});
    await expect(invite("reissue@identity.invalid")).rejects.toMatchObject({code:"23505"});
  });
  it("protects the final active admin, including concurrent demotions",async()=>{
    await expect(updateUser(admin,adminId,{status:"suspended"})).rejects.toMatchObject({code:"LAST_ADMIN_REQUIRED"});
    const successor=await activate("successor@identity.invalid","admin",[warehouseA,warehouseA2]);
    const results=await Promise.allSettled([updateUser(admin,adminId,{status:"suspended"}),updateUser(successor,successor.user.id,{status:"suspended"})]);
    expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);
    const current=(await owner.query(`SELECT user_id FROM "${schema}".memberships WHERE tenant_id=$1 AND role='admin' AND status='active'`,[tenantA])).rows;
    expect(current).toHaveLength(1);
    const survivor=current[0].user_id===adminId?admin:successor;
    await updateUser(survivor,adminId,{status:"active"});
  });
  it("rechecks current role/status/warehouse grants despite a stale Identity object",async()=>{
    const worker=await activate("scope@identity.invalid");
    await requireV2Access(worker,warehouseA,"write");
    await expect(requireV2Access(worker,warehouseA2,"read")).rejects.toMatchObject({code:"WAREHOUSE_FORBIDDEN"});
    await updateUser(admin,worker.user.id,{role:"viewer",warehouseIds:[warehouseA2]});
    await expect(requireV2Access(worker,warehouseA,"read")).rejects.toMatchObject({code:"WAREHOUSE_FORBIDDEN"});
    await expect(requireV2Access(worker,warehouseA2,"write")).rejects.toMatchObject({code:"ROLE_FORBIDDEN"});
    await updateUser(admin,worker.user.id,{status:"departed"});
    await expect(requireV2Access(worker,warehouseA2,"read")).rejects.toMatchObject({code:"MEMBERSHIP_REQUIRED"});
    await expect(updateUser(admin,worker.user.id,{status:"active"})).rejects.toMatchObject({code:"INVALID_STATE"});
    expect((await listUsers(admin)).users.some(u=>u.userId===worker.user.id&&u.status==="departed")).toBe(true);
  });
  it("allows supervisor approvals but forbids account administration and viewer writes",async()=>{
    const supervisor=await activate("supervisor@identity.invalid","supervisor");
    await requireV2Access(supervisor,warehouseA,"approve");
    await expect(listUsers(supervisor)).rejects.toMatchObject({code:"ROLE_FORBIDDEN"});
    const viewer=await activate("viewer@identity.invalid","viewer");
    await requireV2Access(viewer,warehouseA,"read");
    await expect(requireV2Access(viewer,warehouseA,"write")).rejects.toMatchObject({code:"ROLE_FORBIDDEN"});
    const context=await identityContext(supervisor);
    expect(context.warehouseIds).toEqual([warehouseA]);
    expect(context.warehouses.map(w=>w.id)).toEqual([warehouseA]);
    expect(context.assignees.every(a=>a.warehouseIds.every((id:string)=>id===warehouseA))).toBe(true);
  });
  it("sets a reset password once, preserves user id, and invalidates all existing sessions",async()=>{
    const worker=await activate("reset@identity.invalid");
    await state.pool!.query('INSERT INTO "session"(id,"expiresAt",token,"userId") VALUES($1,CURRENT_TIMESTAMP+interval \'1 day\',$2,$3)',[randomUUID(),randomBytes(32).toString("hex"),worker.user.id]);
    const reset=await manageLink(admin,worker.user.id,{kind:"reset"});
    if (!("link" in reset)) throw new Error("Expected link");
    await acceptLink({token:tokenFrom(reset.link),password:"new-identity-password-2026"});
    expect((await state.pool!.query('SELECT 1 FROM "session" WHERE "userId"=$1',[worker.user.id])).rowCount).toBe(0);
    await expect(acceptLink({token:tokenFrom(reset.link),password:"new-identity-password-2026"})).rejects.toMatchObject({code:"INVALID_LINK"});
    const credential=(await state.pool!.query('SELECT password FROM account WHERE "userId"=$1',[worker.user.id])).rows[0].password;
    expect(credential.includes("new-identity-password-2026")).toBe(false);
  });
  it("enforces FORCE RLS and tenant composite warehouse/membership FKs as a nonowner role",async()=>{
    const flags=await state.pool!.query(`SELECT relrowsecurity,relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND relname IN ('v2_warehouse_grants','v2_identity_links','v2_machine_keys','v2_machine_warehouses','v2_identity_audit')`,[schema]);
    expect(flags.rows).toHaveLength(5);expect(flags.rows.every(r=>r.relrowsecurity&&r.relforcerowsecurity)).toBe(true);
    expect((await state.pool!.query("SELECT * FROM v2_warehouse_grants")).rowCount).toBe(0);
    await expect(withTenant(tenantA,c=>c.query("INSERT INTO v2_warehouse_grants VALUES($1,$2,$3)",[tenantA,adminId,warehouseB]))).rejects.toMatchObject({code:"23503"});
    await expect(withTenant(tenantB,c=>c.query("INSERT INTO v2_warehouse_grants VALUES($1,$2,$3)",[tenantB,adminId,warehouseB]))).rejects.toMatchObject({code:"23503"});
    await expect(withTenant(tenantB,c=>c.query("INSERT INTO v2_warehouse_grants VALUES($1,$2,$3)",[tenantA,adminId,warehouseA]))).rejects.toMatchObject({code:"42501"});
    await expect(state.pool!.query("ALTER TABLE v2_warehouse_grants DISABLE ROW LEVEL SECURITY")).rejects.toMatchObject({code:"42501"});
    await expect(withTenant(tenantA,c=>c.query("UPDATE v2_identity_audit SET action='tampered'"))).rejects.toMatchObject({code:"23514"});
  });
  it("binds machine keys to explicit scopes, warehouse, source, test environment and company",async()=>{
    const issued=await createKey(admin,{name:"Supplier",sourceSystem:"supplier",kind:"integration",environment:"test",scopes:["integration:event","integration:read","read"],warehouseIds:[warehouseA]});
    const headers=new Headers({authorization:`Bearer ${issued.token}`});
    const machine=await authenticateV2Machine(headers,"integration:event",warehouseA);
    expect(machine.sourceSystem).toBe("supplier");expect(machine.tenant.isTest).toBe(true);
    expect(JSON.stringify(await listKeys(admin))).not.toContain(issued.token);
    await expect(authenticateV2Machine(headers,"integration:event",warehouseA2)).rejects.toMatchObject({code:"WAREHOUSE_FORBIDDEN"});
    await expect(authenticateV2Machine(headers,"master.write",warehouseA)).rejects.toMatchObject({code:"SCOPE_FORBIDDEN"});
    process.env.WMS_ENVIRONMENT="production";
    await expect(authenticateV2Machine(headers,"integration:event",warehouseA)).rejects.toMatchObject({code:"ENVIRONMENT_FORBIDDEN"});
    process.env.WMS_ENVIRONMENT="test";
    await owner.query(`UPDATE "${schema}".tenants SET is_test=false WHERE id=$1`,[tenantA]);
    await expect(authenticateV2Machine(headers,"integration:event",warehouseA)).rejects.toMatchObject({code:"ENVIRONMENT_FORBIDDEN"});
    await owner.query(`UPDATE "${schema}".tenants SET is_test=true WHERE id=$1`,[tenantA]);
    await revokeKey(admin,issued.keyId);
    await expect(authenticateV2Machine(headers,"integration:event",warehouseA)).rejects.toMatchObject({code:"INVALID_MACHINE_KEY"});
    await expect(requireV2Access(machine,warehouseA,"read")).rejects.toMatchObject({code:"INVALID_MACHINE_KEY"});
  });
  it("stores bounded company idle settings and expires an existing Better Auth session on its next protected request",async()=>{
    expect((await identityContext(admin)).idleLockMinutes).toBe(15);
    await identitySettings(admin,{idleLockMinutes:1});
    expect((await identityContext(admin)).idleLockMinutes).toBe(1);
    await expect(identitySettings(admin,{idleLockMinutes:0})).rejects.toMatchObject({code:"INVALID_INPUT"});
    await expect(identitySettings(admin,{idleLockMinutes:241})).rejects.toMatchObject({code:"INVALID_INPUT"});
    const worker=await activate("idle@identity.invalid");
    await expect(identitySettings(worker,{idleLockMinutes:15})).rejects.toMatchObject({code:"ROLE_FORBIDDEN"});
    const login=await getAuth().handler(new Request("http://localhost:3000/api/auth/sign-in/email",{method:"POST",headers:{"content-type":"application/json",origin:"http://localhost:3000"},body:JSON.stringify({email:worker.user.email,password:"valid-identity-password-2026"})}));
    expect(login.status).toBe(200);
    const cookies=login.headers.getSetCookie().map(value=>value.split(";")[0]).join("; "),headers=new Headers({cookie:cookies});
    await requireIdentity(headers);
    await owner.query(`UPDATE "${schema}"."session" SET last_protected_at=CURRENT_TIMESTAMP-interval '2 minutes' WHERE "userId"=$1`,[worker.user.id]);
    const librarySession=await getAuth().api.getSession({headers});expect(Boolean(librarySession)).toBe(true);
    await expect(requireIdentity(headers)).rejects.toMatchObject({status:401});
    expect((await state.pool!.query('SELECT 1 FROM "session" WHERE "userId"=$1',[worker.user.id])).rowCount).toBe(0);
    await identitySettings(admin,{idleLockMinutes:15});
  });
  it("rotates a key atomically with a one-time secret and predecessor audit history",async()=>{
    const first=await createKey(admin,{name:"Rotating",sourceSystem:"rotating",kind:"integration",environment:"test",scopes:["integration:read"],warehouseIds:[warehouseA]});
    const next=await rotateKey(admin,first.keyId,{});
    await expect(authenticateV2Machine(new Headers({authorization:`Bearer ${first.token}`}),"integration:read",warehouseA)).rejects.toMatchObject({code:"INVALID_MACHINE_KEY"});
    const identity=await authenticateV2Machine(new Headers({authorization:`Bearer ${next.token}`}),"integration:read",warehouseA);
    expect(identity.sourceSystem).toBe("rotating");
    expect((await listKeys(admin)).keys.find(k=>k.id===next.keyId).rotatedFrom).toBe(first.keyId);
    await expect(rotateKey(admin,first.keyId,{})).rejects.toMatchObject({code:"INVALID_STATE"});
    const audits=await withTenant(tenantA,async c=>(await c.query("SELECT action,details,request_id FROM v2_identity_audit WHERE target_id=$1",[next.keyId])).rows);
    expect(audits).toHaveLength(1);expect(audits[0].details).toEqual({previousKeyId:first.keyId});expect(audits[0].request_id).toMatch(/^[0-9a-f-]{36}$/);
  });
  it("limits account and key administration to the actor's entire management scope",async()=>{
    const narrow=await activate("narrow-admin@identity.invalid","admin");
    const broad=await activate("broad-user@identity.invalid","worker",[warehouseA,warehouseA2]);
    await expect(updateUser(narrow,broad.user.id,{status:"suspended"})).rejects.toMatchObject({code:"WAREHOUSE_FORBIDDEN"});
    await expect(manageLink(narrow,broad.user.id,{kind:"reset"})).rejects.toMatchObject({code:"WAREHOUSE_FORBIDDEN"});
    expect((await listUsers(narrow)).users.some(u=>u.userId===broad.user.id)).toBe(false);
    const key=await createKey(admin,{name:"Broad key",sourceSystem:"broad",kind:"integration",environment:"test",scopes:["integration:event"],warehouseIds:[warehouseA,warehouseA2]});
    expect((await listKeys(narrow)).keys.some(k=>k.id===key.keyId)).toBe(false);
    await expect(revokeKey(narrow,key.keyId)).rejects.toMatchObject({code:"WAREHOUSE_FORBIDDEN"});
    await expect(rotateKey(narrow,key.keyId,{})).rejects.toMatchObject({code:"WAREHOUSE_FORBIDDEN"});
    await expect(inviteUser(narrow,{name:"Out of scope",email:"out@identity.invalid",role:"worker",warehouseIds:[warehouseA2]})).rejects.toMatchObject({code:"WAREHOUSE_FORBIDDEN"});
  });
  it("requires separate machine master-data preparation and test-only automation approvals",async()=>{
    await expect(createKey(admin,{name:"Bad",sourceSystem:"s",kind:"integration",environment:"test",scopes:["write"],warehouseIds:[warehouseA]})).rejects.toMatchObject({code:"INVALID_INPUT"});
    const issued=await createKey(admin,{name:"Runner",sourceSystem:"runner",kind:"automation",role:"supervisor",environment:"test",scopes:["read","write","approve","master.write"],warehouseIds:[warehouseA]});
    const headers=new Headers({authorization:`Bearer ${issued.token}`});
    await authenticateV2Machine(headers,"approve",warehouseA);
    await authenticateV2Machine(headers,"master.write",warehouseA);
    await expect(createKey(admin,{name:"Runner",sourceSystem:"runner",kind:"automation",role:"supervisor",environment:"production",scopes:["approve"],warehouseIds:[warehouseA]})).rejects.toMatchObject({code:"ENVIRONMENT_FORBIDDEN"});
    await withTenant(tenantA,c=>c.query("UPDATE v2_machine_keys SET expires_at=CURRENT_TIMESTAMP-interval '1 minute' WHERE id=$1",[issued.keyId]));
    await expect(authenticateV2Machine(headers,"approve",warehouseA)).rejects.toMatchObject({code:"INVALID_MACHINE_KEY"});
  });
});

it("exposes only active scoped automation assignees in a test company and test server",async()=>{
  const viewer=await activate("automation-candidates@identity.invalid","viewer");
  const worker=await createKey(admin,{name:"Candidate worker",sourceSystem:"candidate-worker",kind:"automation",environment:"test",scopes:["read","write"],warehouseIds:[warehouseA,warehouseA2]});
  const outside=await createKey(admin,{name:"Outside",sourceSystem:"candidate-outside",kind:"automation",environment:"test",scopes:["read","write"],warehouseIds:[warehouseA2]});
  const supplier=await createKey(admin,{name:"Supplier excluded",sourceSystem:"candidate-supplier",kind:"integration",environment:"test",scopes:["read","integration:event"],warehouseIds:[warehouseA]});
  const approver=await createKey(admin,{name:"Approver excluded",sourceSystem:"candidate-approver",kind:"automation",role:"supervisor",environment:"test",scopes:["read","approve"],warehouseIds:[warehouseA]});
  const expired=await createKey(admin,{name:"Expired excluded",sourceSystem:"candidate-expired",kind:"automation",environment:"test",scopes:["read","write"],warehouseIds:[warehouseA]});
  await withTenant(tenantA,c=>c.query("UPDATE v2_machine_keys SET expires_at=CURRENT_TIMESTAMP-interval '1 minute' WHERE id=$1",[expired.keyId]));
  let context=await identityContext(viewer);
  expect(context.automationAccounts.find(a=>a.userId===`machine:${worker.keyId}`)).toEqual({userId:`machine:${worker.keyId}`,name:"Candidate worker",role:"worker",status:"active",warehouseIds:[warehouseA]});
  for(const key of [outside,supplier,approver,expired])expect(context.automationAccounts.some(a=>a.userId===`machine:${key.keyId}`)).toBe(false);
  process.env.WMS_ENVIRONMENT="production";expect((await identityContext(viewer)).automationAccounts).toEqual([]);process.env.WMS_ENVIRONMENT="test";
  await owner.query(`UPDATE "${schema}".tenants SET is_test=false WHERE id=$1`,[tenantA]);expect((await identityContext(viewer)).automationAccounts).toEqual([]);await owner.query(`UPDATE "${schema}".tenants SET is_test=true WHERE id=$1`,[tenantA]);
  await revokeKey(admin,worker.keyId);context=await identityContext(viewer);expect(context.automationAccounts.some(a=>a.userId===`machine:${worker.keyId}`)).toBe(false);
});
