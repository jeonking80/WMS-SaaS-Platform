/** Operator-only durable webhook outbox. Never imported by the web application. */
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, open } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const failure=code=>Object.assign(new Error(code),{code});
export function webhookConfiguration(env=process.env){
  if(!env.WMS_ALERT_WEBHOOK_URL)return null;
  let url;try{url=new URL(env.WMS_ALERT_WEBHOOK_URL);}catch{throw failure('ALERT_WEBHOOK_INVALID');}
  if(url.protocol!=='https:'||url.username||url.password||url.hash||url.search)throw failure('ALERT_WEBHOOK_HTTPS_REQUIRED');
  const token=env.WMS_ALERT_WEBHOOK_TOKEN;
  if(token&&(!/^[\x21-\x7e]{1,4096}$/.test(token)))throw failure('ALERT_WEBHOOK_TOKEN_INVALID');
  return {url:url.href,token,receiverId:digest(url.href),timeoutMs:5000};
}
export async function openAlertOutbox(file){
  if(!file)throw failure('ALERT_OUTBOX_REQUIRED');
  const path=resolve(file);await mkdir(dirname(path),{recursive:true,mode:0o700});
  try{const info=await lstat(path);if(!info.isFile()||info.isSymbolicLink()||(info.mode&0o077))throw failure('ALERT_OUTBOX_PRIVATE_FILE_REQUIRED');}
  catch(error){if(error.code!=='ENOENT')throw error;const handle=await open(path,'wx',0o600);await handle.close();}
  // DELETE journal keeps one private durable database; SQLite FULL sync commits before network I/O.
  const {DatabaseSync}=await import('node:sqlite');const db=new DatabaseSync(path);
  try{db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS incidents(scope TEXT NOT NULL,fingerprint TEXT NOT NULL,occurrence INTEGER NOT NULL,active INTEGER NOT NULL,PRIMARY KEY(scope,fingerprint));
    CREATE TABLE IF NOT EXISTS deliveries(dedup_key TEXT PRIMARY KEY,scope TEXT NOT NULL,receiver_id TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,next_attempt_at INTEGER NOT NULL,lease_until INTEGER NOT NULL DEFAULT 0,last_error TEXT,delivered_at INTEGER);
    CREATE TABLE IF NOT EXISTS scope_context(scope TEXT PRIMARY KEY,payload TEXT NOT NULL);`);await chmod(path,0o600);return db;}
  catch(error){db.close();throw error;}
}
/** Only the allowlisted envelope enters the outbox; reports/details/raw payloads never do. */
export function safeAlertEnvelope(alert){
  const id=value=>typeof value==='string'&&/^[a-zA-Z0-9:_-]{1,160}$/.test(value)?value:null;
  const text=value=>typeof value==='string'?value.replace(/[\u0000-\u001f\u007f]/g,'').slice(0,128):null;
  const references=(alert.references??[]).slice(0,10).map(ref=>({kind:id(ref.kind),business_id:id(ref.business_id),business_number:id(ref.business_number),request_id:id(ref.request_id)}));
  let action=null;
  if(typeof alert.action?.path==='string'){
    const url=new URL(alert.action.path,'https://wms.invalid');
    const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
    if(url.origin==='https://wms.invalid'&&url.pathname==='/dashboard/v2'&&!url.hash&&uuid.test(url.searchParams.get('warehouse_id')??'')&&
      [...url.searchParams].every(([key,value])=>key==='tab'?['queue','orders','receipts','returns','inventory','integration'].includes(value):['warehouse_id','object_id','event_id'].includes(key)&&uuid.test(value)))action=url.pathname+url.search;
  }
  if(!id(alert.code)||!id(alert.tenant?.id)||!Array.isArray(alert.warehouses)||!action||!alert.warehouses.some(w=>w.id===new URL(action,'https://wms.invalid').searchParams.get('warehouse_id')))throw failure('ALERT_ENVELOPE_INVALID');
  return {schema_version:'1.0',code:alert.code,severity:['critical','warning'].includes(alert.severity)?alert.severity:'warning',status:id(alert.status),
    tenant:{id:alert.tenant.id,name:text(alert.tenant.name)},warehouses:alert.warehouses.map(w=>({id:id(w.id),code:text(w.code),name:text(w.name)})),references,
    action:{path:action,authorization:'active manager membership and explicit warehouse access rechecked by server'},observed_at:new Date(alert.observed_at).toISOString()};
}
export function enqueueAlertReport(db,report,configuration,{now=Date.now(),resolveMissing=true}={}){
  const scope=digest([report.tenant_id,[...report.warehouse_ids].sort(),configuration.receiverId]);
  db.exec('BEGIN IMMEDIATE');let enqueued=0;
  try{
    const contexts=report.alerts.map(safeAlertEnvelope),warehouses=[...new Map(contexts.flatMap(alert=>alert.warehouses).map(w=>[w.id,w])).values()];
    if(contexts.length&&warehouses.length===report.warehouse_ids.length&&warehouses.every(w=>report.warehouse_ids.includes(w.id)))db.prepare('INSERT INTO scope_context VALUES(?,?) ON CONFLICT(scope) DO UPDATE SET payload=excluded.payload').run(scope,JSON.stringify({tenant:contexts[0].tenant,warehouses}));
    const previous=new Map(db.prepare('SELECT fingerprint,occurrence,active FROM incidents WHERE scope=?').all(scope).map(row=>[row.fingerprint,row]));
    if(resolveMissing)db.prepare('UPDATE incidents SET active=0 WHERE scope=?').run(scope);
    for(const alert of report.alerts){
      const envelope=safeAlertEnvelope(alert),{observed_at,...stable}=envelope,fingerprint=digest(stable),old=previous.get(fingerprint),occurrence=old?(old.active?old.occurrence:old.occurrence+1):1;
      db.prepare('INSERT INTO incidents VALUES(?,?,?,1) ON CONFLICT(scope,fingerprint) DO UPDATE SET occurrence=excluded.occurrence,active=1').run(scope,fingerprint,occurrence);
      const dedupKey=digest([scope,fingerprint,occurrence]);
      enqueued+=Number(db.prepare("INSERT OR IGNORE INTO deliveries(dedup_key,scope,receiver_id,payload,status,next_attempt_at) VALUES(?,?,?,?,'pending',?)").run(dedupKey,scope,configuration.receiverId,JSON.stringify({...envelope,dedup_key:dedupKey}),now).changes);
    }
    db.exec('COMMIT');return {enqueued};
  }catch(error){db.exec('ROLLBACK');throw error;}
}
/** During DB outage, reuse only a previously observed exact operator scope. */
export function cachedFailureReport(db,configuration,tenantId,warehouseIds,{now=Date.now()}={}){
  const scope=digest([tenantId,[...warehouseIds].sort(),configuration.receiverId]);
  const row=db.prepare('SELECT payload FROM scope_context WHERE scope=?').get(scope);if(!row)return null;
  const context=JSON.parse(row.payload),observed_at=new Date(now).toISOString();
  return {status:'critical',checked_at:observed_at,tenant_id:tenantId,warehouse_ids:warehouseIds,checks:[{name:'readiness',status:'critical',details:{reason:'MONITOR_DATABASE_UNAVAILABLE',scope_metadata:'last successful collection; current permissions are rechecked on action'}}],
    alerts:context.warehouses.map(warehouse=>({code:'MONITOR_DATABASE_UNAVAILABLE',severity:'critical',status:'critical',tenant:context.tenant,warehouses:[warehouse],references:[],observed_at,action:{path:'/dashboard/v2?'+new URLSearchParams({warehouse_id:warehouse.id,tab:'queue'}),authorization:'server rechecks current access'}})),
    notifications:{status:'pending',recipient_configured:true,delivery:'https_webhook',sent:false}};
}
/** Injection is for an in-process/local test receiver. The CLI always uses native fetch + HTTPS. */
export async function deliverAlerts(db,configuration,{now=Date.now(),fetchImpl=fetch,max=25,requeueFailed=false}={}){
  if(requeueFailed)db.prepare("UPDATE deliveries SET status='pending',attempts=0,next_attempt_at=?,lease_until=0 WHERE receiver_id=? AND status='failed'").run(now,configuration.receiverId);
  let sent=0,retried=0,failed=0;
  for(let i=0;i<Math.min(max,100);i++){
    db.exec('BEGIN IMMEDIATE');let row;
    try{row=db.prepare("SELECT * FROM deliveries WHERE receiver_id=? AND status IN ('pending','sending') AND next_attempt_at<=? AND lease_until<=? ORDER BY next_attempt_at,dedup_key LIMIT 1").get(configuration.receiverId,now,now);if(row)db.prepare("UPDATE deliveries SET status='sending',lease_until=? WHERE dedup_key=?").run(now+configuration.timeoutMs+30000,row.dedup_key);db.exec('COMMIT');}
    catch(error){db.exec('ROLLBACK');throw error;}
    if(!row)break;
    let errorCode;
    try{
      const response=await fetchImpl(configuration.url,{method:'POST',redirect:'error',headers:{'content-type':'application/json','idempotency-key':row.dedup_key,...(configuration.token?{authorization:`Bearer ${configuration.token}`}:{})},body:row.payload,signal:AbortSignal.timeout(configuration.timeoutMs)});
      await response.body?.cancel();if(!response.ok)errorCode=`HTTP_${response.status}`;
    }catch{errorCode='NETWORK_OR_TIMEOUT';}
    const attempts=row.attempts+1;
    if(!errorCode){db.prepare("UPDATE deliveries SET status='delivered',attempts=?,delivered_at=?,lease_until=0,last_error=NULL WHERE dedup_key=?").run(attempts,now,row.dedup_key);sent++;}
    else{const terminal=attempts>=8;db.prepare('UPDATE deliveries SET status=?,attempts=?,next_attempt_at=?,lease_until=0,last_error=? WHERE dedup_key=?').run(terminal?'failed':'pending',attempts,now+Math.min(3600000,30000*2**(attempts-1)),errorCode,row.dedup_key);terminal?failed++:retried++;}
  }
  const pending=Number(db.prepare("SELECT count(*) n FROM deliveries WHERE receiver_id=? AND status IN ('pending','sending')").get(configuration.receiverId).n);
  const dead=Number(db.prepare("SELECT count(*) n FROM deliveries WHERE receiver_id=? AND status='failed'").get(configuration.receiverId).n);
  return {delivery:'https_webhook',sent,retained_for_retry:pending,retried,failed:dead,failed_this_run:failed,receiver_confirmation:'http_acceptance_only; human recipient acknowledgement not verified'};
}
