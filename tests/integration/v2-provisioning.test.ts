import { randomUUID, randomBytes, createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { beforeAll, afterAll, expect, test, vi } from "vitest";
import { migrate } from "../../scripts/db-migrate.mjs";
import { provisionCompany } from "../../scripts/provision-company.mjs";
const state=vi.hoisted(()=>({pool:undefined as pg.Pool|undefined}));
vi.mock("../../src/server/db/pool",()=>({getPool:()=>state.pool}));
import { acceptLink } from "../../src/server/v2/identity/service";
import { getAuth } from "../../src/server/auth/config";
import { requireIdentity } from "../../src/server/auth/access";

const url=process.env.TEST_DATABASE_URL;
if(!url || !new URL(url).pathname.endsWith("_test"))throw Error("Dedicated test DB required");
const schema=`provision_${randomUUID().replaceAll("-","")}`;
const migratorRole=`provision_mig_${randomUUID().replaceAll("-","")}`,appRole=`provision_app_${randomUUID().replaceAll("-","")}`;
const admin=new pg.Pool({connectionString:url});
const control=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`});
let directory:string,migratorUrl:string;
const rolesCreated:string[]=[];
function connection(role:string,password:string) {const binding=new URL(url!);binding.username=role;binding.password=password;binding.searchParams.set("options",`-c search_path=${schema}`);binding.searchParams.set("application_name",schema);return binding.href;}
function config(overrides:Record<string,unknown>={}) {
  const requestId=randomUUID();
  return {databaseUrl:migratorUrl,name:"Provision test",adminName:"Initial admin",adminEmail:`${randomUUID()}@example.test`,warehouseCode:"MAIN",warehouseName:"Main",operator:"local-verification",reason:"Provision acceptance test",requestId,origin:"http://localhost:3000",output:join(directory,`${requestId}.json`),isTest:true,...overrides};
}
async function fingerprint() {
  const hash=createHash("sha256");
  for(const table of ["tenants","user","account","session","memberships","warehouses","v2_warehouse_grants","v2_identity_links","v2_identity_audit"]){const result=await control.query(`SELECT row_to_json(t)::text value FROM ${pg.escapeIdentifier(table)} t ORDER BY row_to_json(t)::text`);hash.update(JSON.stringify([table,result.rows]));}
  return hash.digest("hex");
}
beforeAll(async()=>{
  directory=await mkdtemp(join(tmpdir(),"wms-provision-"));
  const migrationPassword=randomBytes(32).toString("hex"),appPassword=randomBytes(32).toString("hex");
  for(const[role,password]of [[migratorRole,migrationPassword],[appRole,appPassword]]){
    await admin.query(`CREATE ROLE ${pg.escapeIdentifier(role)} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD ${pg.escapeLiteral(password)}`);rolesCreated.push(role);
  }
  await admin.query(`CREATE SCHEMA "${schema}" AUTHORIZATION "${migratorRole}"`);
  migratorUrl=connection(migratorRole,migrationPassword);
  await migrate(migratorUrl,{schema,migrationsSchema:schema,createSchema:false,createMigrationsSchema:false,log:()=>{}});
  await admin.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${appRole}"`);
  await admin.query(`GRANT SELECT ON "${schema}".tenants,"${schema}".memberships,"${schema}".warehouses,"${schema}".v2_warehouse_grants TO "${appRole}"`);
  await admin.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON "${schema}"."user","${schema}"."session","${schema}".account,"${schema}".verification,"${schema}"."rateLimit" TO "${appRole}"`);
  await admin.query(`GRANT SELECT,UPDATE ON "${schema}".v2_identity_links TO "${appRole}"`);
  await admin.query(`GRANT SELECT,INSERT ON "${schema}".v2_identity_audit TO "${appRole}"`);
  await admin.query(`GRANT UPDATE(status,updated_at) ON "${schema}".memberships TO "${appRole}"`);
  state.pool=new pg.Pool({connectionString:connection(appRole,appPassword),max:3});
  process.env.BETTER_AUTH_URL="http://localhost:3000";process.env.BETTER_AUTH_SECRET=randomBytes(48).toString("hex");
});
afterAll(async()=>{
  await state.pool?.end();await control.end();
  try{await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);}
  finally{for(const role of rolesCreated.reverse())await admin.query(`DROP ROLE ${pg.escapeIdentifier(role)}`);await admin.end();if(directory)await rm(directory,{recursive:true,force:true});}
});

test("non-superuser migrator provisions a hashed invitation that the restricted application accepts once and logs in",async()=>{
  const input=config();
  const result=await provisionCompany(input),invitation=JSON.parse(await readFile(input.output,"utf8"));
  expect((await stat(input.output)).mode&0o777).toBe(0o600);
  const token=new URL(invitation.invitation_url).searchParams.get("token")!;
  expect(token.split(".")).toHaveLength(3);
  const roles=(await control.query("SELECT rolname,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=ANY($1::text[])",[[migratorRole,appRole]])).rows;
  expect(roles).toHaveLength(2);expect(roles.every(row=>!row.rolsuper&&!row.rolbypassrls)).toBe(true);
  const links=(await control.query("SELECT token_hash,consumed_at FROM v2_identity_links WHERE tenant_id=$1",[result.tenant_id])).rows;
  expect(links).toEqual([{token_hash:createHash("sha256").update(token).digest("hex"),consumed_at:null}]);
  expect((await control.query("SELECT role,status FROM memberships WHERE tenant_id=$1",[result.tenant_id])).rows).toEqual([{role:"admin",status:"invited"}]);
  expect((await control.query("SELECT count(*)::int n FROM v2_warehouse_grants WHERE tenant_id=$1",[result.tenant_id])).rows[0].n).toBe(1);
  expect((await control.query("SELECT action,details->>'operator' operator FROM v2_identity_audit WHERE tenant_id=$1",[result.tenant_id])).rows).toEqual([{action:"COMPANY_PROVISION",operator:"local-verification"}]);
  await expect(control.query("DELETE FROM v2_identity_audit WHERE tenant_id=$1",[result.tenant_id])).rejects.toMatchObject({code:"23514"});
  const password=randomBytes(24).toString("base64url");
  await acceptLink({token,password});
  await expect(acceptLink({token,password})).rejects.toMatchObject({code:"INVALID_LINK"});
  const login=await getAuth().handler(new Request("http://localhost:3000/api/auth/sign-in/email",{method:"POST",headers:{"content-type":"application/json",origin:"http://localhost:3000"},body:JSON.stringify({email:input.adminEmail,password})}));
  expect(login.status).toBe(200);
  const cookie=login.headers.getSetCookie().map(value=>value.split(";")[0]).join("; ");
  const identity=await requireIdentity(new Headers({cookie}));expect(identity.tenant.id).toBe(result.tenant_id);expect(identity.role).toBe("admin");
  const before=await fingerprint();
  await expect(provisionCompany({...input,output:join(directory,"existing-email.json")})).rejects.toThrow("Existing account");
  expect(await fingerprint()).toBe(before);
  await expect(stat(join(directory,"existing-email.json"))).rejects.toMatchObject({code:"ENOENT"});
});

test("reruns refuse file overwrite, request reuse with another email and case-varied account reassignment without resetting data",async()=>{
  const input=config();await provisionCompany(input);const before=await fingerprint();
  const originalFile=await readFile(input.output,"utf8");
  await expect(provisionCompany(input)).rejects.toMatchObject({code:"EEXIST"});
  expect((await readFile(input.output,"utf8"))===originalFile).toBe(true);
  await expect(provisionCompany({...input,adminEmail:input.adminEmail.toUpperCase(),requestId:randomUUID(),output:join(directory,"case-retry.json")})).rejects.toThrow("Existing account");
  await expect(provisionCompany({...input,adminEmail:`${randomUUID()}@example.test`,output:join(directory,"request-retry.json")})).rejects.toMatchObject({code:"23505"});
  expect(await fingerprint()).toBe(before);
  await expect(stat(join(directory,"request-retry.json"))).rejects.toMatchObject({code:"ENOENT"});
});

test("a failure after company, user and warehouse creation rolls the entire provisioning transaction back",async()=>{
  const input=config(),before=await fingerprint();
  // A real server-side statement failure after company/user/warehouse creation proves atomic rollback.
  const requestId=randomUUID();
  await control.query("CREATE FUNCTION provision_reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic provisioning failure' USING ERRCODE='23514'; END $$");
  await control.query("CREATE TRIGGER provision_reject_audit BEFORE INSERT ON v2_identity_audit FOR EACH ROW EXECUTE FUNCTION provision_reject_audit()");
  try{await expect(provisionCompany({...input,requestId})).rejects.toMatchObject({code:"23514"});}
  finally{await control.query("DROP TRIGGER provision_reject_audit ON v2_identity_audit");await control.query("DROP FUNCTION provision_reject_audit()");}
  expect(await fingerprint()).toBe(before);await expect(stat(input.output)).rejects.toMatchObject({code:"ENOENT"});
});

test("a lost COMMIT response preserves the only private invitation and never resets an existing account on retry",async()=>{
  const input=config(),original=pg.Client.prototype.query;
  let injected=false;
  const spy=vi.spyOn(pg.Client.prototype,"query").mockImplementation(function(this:pg.Client,...args:unknown[]) {
    const promise=Reflect.apply(original,this,args) as Promise<unknown>;
    if(args[0]==="COMMIT"&&!injected){injected=true;return promise.then(()=>{throw new Error("Synthetic response loss after actual COMMIT");});}
    return promise;
  } as typeof pg.Client.prototype.query);
  try{await expect(provisionCompany(input)).rejects.toMatchObject({code:"PROVISION_COMMIT_UNKNOWN"});}
  finally{spy.mockRestore();}
  expect(injected).toBe(true);expect((await stat(input.output)).mode&0o777).toBe(0o600);
  const invitation=JSON.parse(await readFile(input.output,"utf8"));
  expect((await control.query("SELECT count(*)::int n FROM v2_identity_audit WHERE request_id=$1",[input.requestId])).rows[0].n).toBe(1);
  await acceptLink({token:new URL(invitation.invitation_url).searchParams.get("token"),password:randomBytes(24).toString("base64url")});
  const before=await fingerprint();
  await expect(provisionCompany({...input,output:join(directory,"uncertain-retry.json")})).rejects.toThrow("Existing account");
  expect(await fingerprint()).toBe(before);
});

test("ordinary application credentials cannot provision a company and invalid input creates no invitation",async()=>{
  const input=config(),before=await fingerprint();
  const appBinding=state.pool!.options.connectionString!;
  await expect(provisionCompany({...input,databaseUrl:appBinding})).rejects.toMatchObject({code:"42501"});
  await expect(stat(input.output)).rejects.toMatchObject({code:"ENOENT"});
  await expect(provisionCompany({...input,requestId:"-".repeat(36)})).rejects.toThrow("Invalid request ID");
  await expect(provisionCompany({...input,origin:"http://public.example.test"})).rejects.toThrow("HTTPS");
  expect(await fingerprint()).toBe(before);
});

test("operator explicitly reissues an unused expired initial invitation, revokes the old link and audits a new request",async()=>{
  const input=config(),first=await provisionCompany(input);
  const oldInvitation=JSON.parse(await readFile(input.output,"utf8")),oldToken=new URL(oldInvitation.invitation_url).searchParams.get("token")!;
  await control.query("UPDATE v2_identity_links SET expires_at=CURRENT_TIMESTAMP-interval '1 hour' WHERE tenant_id=$1",[first.tenant_id]);
  const beforeCounts=(await control.query("SELECT (SELECT count(*)::int FROM tenants) tenants,(SELECT count(*)::int FROM \"user\") users,(SELECT count(*)::int FROM memberships) memberships,(SELECT count(*)::int FROM warehouses) warehouses")).rows;
  const recovery={...input,requestId:randomUUID(),initialRequestId:input.requestId,reissueInitialInvitation:true,output:join(directory,"initial-reissue.json"),reason:"Expired initial invitation recovery"};
  const second=await provisionCompany(recovery);
  expect(second.tenant_id).toBe(first.tenant_id);expect(second.warehouse_id).toBe(first.warehouse_id);
  const nextInvitation=JSON.parse(await readFile(recovery.output,"utf8")),nextToken=new URL(nextInvitation.invitation_url).searchParams.get("token")!;
  expect(nextToken===oldToken).toBe(false);expect((await stat(recovery.output)).mode&0o777).toBe(0o600);
  const afterCounts=(await control.query("SELECT (SELECT count(*)::int FROM tenants) tenants,(SELECT count(*)::int FROM \"user\") users,(SELECT count(*)::int FROM memberships) memberships,(SELECT count(*)::int FROM warehouses) warehouses")).rows;
  expect(afterCounts).toEqual(beforeCounts);
  const audit=(await control.query("SELECT action,details->>'initial_request_id' original,details->>'reason' reason FROM v2_identity_audit WHERE request_id=$1",[recovery.requestId])).rows;
  expect(audit).toEqual([{action:"COMPANY_INITIAL_INVITE_REISSUE",original:input.requestId,reason:recovery.reason}]);
  const password=randomBytes(24).toString("base64url");
  await expect(acceptLink({token:oldToken,password})).rejects.toMatchObject({code:"INVALID_LINK"});
  await acceptLink({token:nextToken,password});
  const before=await fingerprint();
  await expect(provisionCompany({...recovery,requestId:randomUUID(),output:join(directory,"active-initial-reissue.json")})).rejects.toThrow("Only an unused initial administrator");
  expect(await fingerprint()).toBe(before);
});

test("initial reissue rejects a wrong original audit, mismatched company, missing reason and any pre-existing credential",async()=>{
  const input=config(),first=await provisionCompany(input);
  const recovery={...input,requestId:randomUUID(),initialRequestId:input.requestId,reissueInitialInvitation:true,output:join(directory,"rejected-initial-reissue.json")};
  const before=await fingerprint();
  await expect(provisionCompany({...recovery,initialRequestId:randomUUID()})).rejects.toThrow("Original provisioning audit");
  await expect(provisionCompany({...recovery,name:"Different company"})).rejects.toThrow("parameters do not match");
  await expect(provisionCompany({...recovery,reason:" "})).rejects.toThrow("Missing reason");
  expect(await fingerprint()).toBe(before);
  const user=(await control.query("SELECT user_id FROM memberships WHERE tenant_id=$1",[first.tenant_id])).rows[0].user_id;
  await control.query('INSERT INTO account(id,"accountId","providerId","userId",password) VALUES($1,$2,\'credential\',$2,$3)',[randomUUID(),user,"synthetic-existing-credential-marker"]);
  const existingCredential=await fingerprint();
  await expect(provisionCompany(recovery)).rejects.toThrow("Only an unused initial administrator");
  expect(await fingerprint()).toBe(existingCredential);
});

test("initial reissue refuses any prior session or consumed link even if membership still says invited",async()=>{
  const input=config(),first=await provisionCompany(input);
  const user=(await control.query("SELECT user_id FROM memberships WHERE tenant_id=$1",[first.tenant_id])).rows[0].user_id;
  const recovery={...input,requestId:randomUUID(),initialRequestId:input.requestId,reissueInitialInvitation:true,output:join(directory,"used-initial-reissue.json")};
  await control.query('INSERT INTO "session"(id,"expiresAt",token,"userId") VALUES($1,CURRENT_TIMESTAMP-interval \'1 day\',$2,$3)',[randomUUID(),randomBytes(32).toString("base64url"),user]);
  const sessionFingerprint=await fingerprint();
  await expect(provisionCompany(recovery)).rejects.toThrow("Only an unused initial administrator");
  expect(await fingerprint()).toBe(sessionFingerprint);
  await control.query('DELETE FROM "session" WHERE "userId"=$1',[user]);
  await control.query("UPDATE v2_identity_links SET consumed_at=CURRENT_TIMESTAMP WHERE tenant_id=$1",[first.tenant_id]);
  const consumedFingerprint=await fingerprint();
  await expect(provisionCompany(recovery)).rejects.toThrow("Only an unused initial administrator");
  expect(await fingerprint()).toBe(consumedFingerprint);
});

test("a real concurrent initial acceptance and reissue serialize to exactly one valid winning link",async()=>{
  const input=config(),first=await provisionCompany(input),original=JSON.parse(await readFile(input.output,"utf8"));
  const token=new URL(original.invitation_url).searchParams.get("token")!,password=randomBytes(24).toString("base64url");
  const recovery={...input,requestId:randomUUID(),initialRequestId:input.requestId,reissueInitialInvitation:true,output:join(directory,"raced-initial-reissue.json")};
  const blocker=await control.connect();
  let operations:PromiseSettledResult<unknown>[]=[];
  try {
    await blocker.query("BEGIN");await blocker.query("SELECT pg_advisory_xact_lock(hashtextextended($1,11))",[first.tenant_id]);
    const pending=Promise.allSettled([acceptLink({token,password}),provisionCompany(recovery)]);
    // Both operations have independent database transactions; let them reach the held tenant lock.
    const deadline=Date.now()+5000;
    let waiting=0;
    while(Date.now()<deadline){waiting=(await control.query("SELECT count(*)::int n FROM pg_stat_activity WHERE usename=ANY($1::text[]) AND datname=current_database() AND wait_event_type='Lock'",[[migratorRole,appRole]])).rows[0].n;if(waiting>=2)break;await new Promise(resolve=>setTimeout(resolve,20));}
    expect(waiting).toBeGreaterThanOrEqual(2);
    await blocker.query("COMMIT");operations=await pending;
  }finally{await blocker.query("ROLLBACK");blocker.release();}
  expect(operations.filter(result=>result.status==="fulfilled")).toHaveLength(1);
  if(operations[1].status==="fulfilled"){
    const replacement=JSON.parse(await readFile(recovery.output,"utf8"));await acceptLink({token:new URL(replacement.invitation_url).searchParams.get("token"),password});
  }
  const rows=(await control.query('SELECT m.status,(SELECT count(*)::int FROM account a WHERE a."userId"=m.user_id) credentials FROM memberships m WHERE m.tenant_id=$1',[first.tenant_id])).rows;
  expect(rows).toEqual([{status:"active",credentials:1}]);
});
