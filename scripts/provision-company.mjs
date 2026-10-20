import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { open, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import pg from 'pg';

// Operator-only entry point. No public signup, account reassignment or password reset.
export async function provisionCompany(config) {
  const required = ['databaseUrl', 'name', 'adminName', 'adminEmail', 'warehouseCode', 'warehouseName', 'operator', 'reason', 'requestId', 'origin', 'output'];
  for (const key of required) if (typeof config[key] !== 'string' || !config[key].trim()) throw new Error(`Missing ${key}`);
  config={...config};
  for(const key of required)if(key!=='databaseUrl'&&key!=='output')config[key]=config[key].trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(config.requestId) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(config.adminEmail)) throw new Error('Invalid request ID or email');
  const reissue=config.reissueInitialInvitation===true;
  if(reissue && (typeof config.initialRequestId!=='string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(config.initialRequestId) || config.initialRequestId===config.requestId))throw new Error('A distinct original provisioning request ID is required for initial invitation reissue');
  const origin = new URL(config.origin);
  if (!['https:','http:'].includes(origin.protocol) || origin.username || origin.password || (origin.protocol !== 'https:' && !['localhost','127.0.0.1','[::1]'].includes(origin.hostname))) throw new Error('HTTPS application origin required');
  if ([config.name,config.adminName,config.warehouseName,config.operator].some(x=>x.length>128) || config.warehouseCode.length>50 || config.reason.length>1000) throw new Error('Field too long');
  const output = resolve(config.output);
  const file = await open(output, 'wx', 0o600);
  let client;
  let committed = false, commitAttempted = false;
  try {
    client = new pg.Client({ connectionString: config.databaseUrl });
    await client.connect();
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('wms-company-provision'))");
    const existing = await client.query('SELECT u.id,m.tenant_id FROM "user" u LEFT JOIN memberships m ON m.user_id=u.id WHERE lower(u.email)=lower($1)',[config.adminEmail]);
    let tenant,user,warehouse;
    if(reissue) {
      const prior=existing.rows[0];
      if(!prior?.tenant_id)throw new Error('Original provisioned invitation was not found');
      tenant=prior.tenant_id;user=prior.id;
      await client.query("SELECT set_config('app.tenant_id',$1,true)",[tenant]);
      // Shares the tenant lifecycle lock with acceptLink; a racing acceptance wins or
      // sees the old link revoked, with no account-reset path in either order.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,11))",[tenant]);
      const current=(await client.query(`SELECT m.role,m.status,t.name AS company_name,t.active,t.is_test,u.name AS admin_name
        FROM memberships m JOIN tenants t ON t.id=m.tenant_id JOIN "user" u ON u.id=m.user_id
        WHERE m.tenant_id=$1 AND m.user_id=$2 FOR UPDATE OF m`,[tenant,user])).rows[0];
      const used=(await client.query(`SELECT EXISTS(SELECT 1 FROM account WHERE "userId"=$1)
        OR EXISTS(SELECT 1 FROM "session" WHERE "userId"=$1)
        OR EXISTS(SELECT 1 FROM v2_identity_links WHERE tenant_id=$2 AND user_id=$1 AND consumed_at IS NOT NULL) AS used`,[user,tenant])).rows[0].used;
      if(!current?.active || current.role!=='admin' || current.status!=='invited' || used)throw new Error('Only an unused initial administrator invitation can be reissued');
      const original=(await client.query(`SELECT details FROM v2_identity_audit WHERE tenant_id=$1 AND id=$2 AND request_id=$2
        AND actor_id=$3 AND target_id=$3 AND action='COMPANY_PROVISION'`,[tenant,config.initialRequestId,user])).rows[0];
      if(!original)throw new Error('Original provisioning audit does not match the invited administrator');
      warehouse=original.details.warehouse_id;
      const originalWarehouse=(await client.query('SELECT code,name FROM warehouses WHERE tenant_id=$1 AND id=$2',[tenant,warehouse])).rows[0];
      if(current.company_name!==config.name || current.admin_name!==config.adminName || current.is_test!==(config.isTest===true)
        || originalWarehouse?.code!==config.warehouseCode || originalWarehouse?.name!==config.warehouseName)throw new Error('Provisioning recovery parameters do not match the original company');
      await client.query('UPDATE v2_identity_links SET revoked_at=CURRENT_TIMESTAMP WHERE tenant_id=$1 AND user_id=$2 AND consumed_at IS NULL AND revoked_at IS NULL',[tenant,user]);
    } else {
      if(existing.rowCount)throw new Error('Existing account cannot be reassigned; inspect the prior provisioning record');
      tenant=randomUUID();user=randomUUID();warehouse=randomUUID();
      await client.query('INSERT INTO tenants(id,name,is_test) VALUES($1,$2,$3)',[tenant,config.name,config.isTest===true]);
      await client.query("SELECT set_config('app.tenant_id',$1,true)",[tenant]);
      await client.query('INSERT INTO "user"(id,name,email,"emailVerified") VALUES($1,$2,$3,false)',[user,config.adminName,config.adminEmail.toLowerCase()]);
      await client.query("INSERT INTO memberships(user_id,tenant_id,role,status) VALUES($1,$2,'admin','invited')",[user,tenant]);
      await client.query('INSERT INTO warehouses(id,tenant_id,code,name) VALUES($1,$2,$3,$4)',[warehouse,tenant,config.warehouseCode,config.warehouseName]);
      await client.query('INSERT INTO v2_warehouse_grants(tenant_id,user_id,warehouse_id) VALUES($1,$2,$3)',[tenant,user,warehouse]);
    }
    const linkId=randomUUID(),token=`${tenant}.${linkId}.${randomBytes(32).toString('base64url')}`,expires=new Date(Date.now()+24*60*60*1000);
    await client.query("INSERT INTO v2_identity_links(id,tenant_id,user_id,kind,token_hash,expires_at,created_by) VALUES($1,$2,$3,'invite',$4,$5,$3)",[linkId,tenant,user,createHash('sha256').update(token).digest('hex'),expires]);
    const action=reissue?'COMPANY_INITIAL_INVITE_REISSUE':'COMPANY_PROVISION';
    await client.query('INSERT INTO v2_identity_audit(id,tenant_id,actor_id,target_id,action,request_id,details) VALUES($1,$2,$3,$3,$4,$1,$5)',[config.requestId,tenant,user,action,JSON.stringify({operator:config.operator,reason:config.reason,warehouse_id:warehouse,is_test:config.isTest===true,...(reissue?{initial_request_id:config.initialRequestId}:{})})]);
    const invitation = new URL('/invitation',origin); invitation.searchParams.set('token',token);
    await file.writeFile(JSON.stringify({tenant_id:tenant,warehouse_id:warehouse,request_id:config.requestId,expires_at:expires.toISOString(),invitation_url:invitation.href},null,2)+'\n');
    await file.sync();
    const parentDirectory=await open(dirname(output),'r');
    try { await parentDirectory.sync(); } finally { await parentDirectory.close(); }
    commitAttempted = true;
    await client.query('COMMIT'); committed = true;
    return {tenant_id:tenant,warehouse_id:warehouse,request_id:config.requestId};
  } catch(error) {
    if(client)await client.query('ROLLBACK').catch(()=>{});
    if (!commitAttempted) await unlink(output).catch(()=>{});
    if(commitAttempted && !committed) {
      // PostgreSQL may have committed before its response was lost. The durable private
      // invitation is the recovery artifact; removing it can strand the first admin.
      const uncertain = new Error('Commit outcome is uncertain; preserve the private invitation and inspect the provisioning audit before retrying.',{cause:error});
      uncertain.code='PROVISION_COMMIT_UNKNOWN';
      throw uncertain;
    }
    throw error;
  } finally { try { await file.close(); } finally { await client?.end(); } }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  try {
    await provisionCompany({
      databaseUrl:process.env.MIGRATION_DATABASE_URL,name:process.env.PROVISION_COMPANY_NAME,
      adminName:process.env.PROVISION_ADMIN_NAME,adminEmail:process.env.PROVISION_ADMIN_EMAIL,
      warehouseCode:process.env.PROVISION_WAREHOUSE_CODE,warehouseName:process.env.PROVISION_WAREHOUSE_NAME,
      operator:process.env.PROVISION_OPERATOR,reason:process.env.PROVISION_REASON,
      requestId:process.env.PROVISION_REQUEST_ID,origin:process.env.BETTER_AUTH_URL,
      output:process.env.PROVISION_INVITATION_FILE,isTest:process.env.PROVISION_TEST_COMPANY==='true',
      reissueInitialInvitation:process.env.PROVISION_REISSUE_INITIAL_INVITATION==='true',initialRequestId:process.env.PROVISION_INITIAL_REQUEST_ID,
    });
    console.log('Company provisioning committed. Deliver the private invitation file through an approved channel.');
  } catch(error) {
    console.error(error.code==='PROVISION_COMMIT_UNKNOWN' ? 'Company provisioning outcome is unknown. Preserve the private invitation file and inspect the request audit before retrying.' : `Company provisioning failed (${error.code??error.name}). Inspect configuration and the provisioning record before retrying.`);
    process.exitCode=1;
  }
}
