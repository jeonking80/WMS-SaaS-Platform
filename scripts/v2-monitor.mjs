import pg from 'pg';
import { collectMonitor,readBackupEvidence } from './v2-monitor-lib.mjs';
import { webhookConfiguration,openAlertOutbox,enqueueAlertReport,deliverAlerts,cachedFailureReport } from './v2-alert-delivery.mjs';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
let client,outbox,webhook;
try {
  webhook=webhookConfiguration();
  if(webhook){outbox=await openAlertOutbox(process.env.WMS_ALERT_OUTBOX_FILE);}
  if(process.env.WMS_ALERT_DRAIN_ONLY==='true'){
    if(!webhook)throw Object.assign(new Error(),{code:'ALERT_WEBHOOK_REQUIRED'});
    const delivery=await deliverAlerts(outbox,webhook,{requeueFailed:process.env.WMS_ALERT_REQUEUE_FAILED==='true'});
    console.log(JSON.stringify({status:delivery.failed||delivery.retained_for_retry?'warning':'ok',notifications:delivery}));process.exitCode=delivery.failed||delivery.retained_for_retry?1:0;
  }else{
  const tenantId=process.env.WMS_MONITOR_TENANT_ID;
  const warehouseIds=[...new Set((process.env.WMS_MONITOR_WAREHOUSE_IDS??'').split(',').map(v=>v.trim()).filter(Boolean))];
  if(!tenantId||!uuid.test(tenantId)||!warehouseIds.length||warehouseIds.some(id=>!uuid.test(id)))throw Object.assign(new Error(),{code:'MONITOR_SCOPE_REQUIRED'});
  const url=new URL(process.env.DATABASE_URL??'');
  if(!['postgres:','postgresql:'].includes(url.protocol)||decodeURIComponent(url.username)!=='wms_app')throw Object.assign(new Error(),{code:'RESTRICTED_DATABASE_URL_REQUIRED'});
  client=new pg.Client({connectionString:url.toString(),connectionTimeoutMillis:5000,statement_timeout:15000});
  await client.connect();await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await client.query("SELECT set_config('app.tenant_id',$1,true)",[tenantId]);
  const backupEvidence=await readBackupEvidence(process.env.WMS_BACKUP_EVIDENCE_FILE,tenantId);
  const report=await collectMonitor(client,{tenantId,warehouseIds,backupEvidence,recipientConfigured:Boolean(webhook)});
  await client.query('COMMIT');
  if(webhook){const queued=enqueueAlertReport(outbox,report,webhook),delivery=await deliverAlerts(outbox,webhook);report.notifications={...report.notifications,...queued,...delivery,sent:delivery.sent>0,status:delivery.failed||delivery.retained_for_retry?'retry_or_operator_action_required':delivery.sent?'http_accepted':'no_new_alerts'};}
  console.log(JSON.stringify(report));process.exitCode=report.status==='critical'?2:report.status==='warning'||report.notifications.failed||report.notifications.retained_for_retry?1:0;
  }
} catch(error) {
  const code=['MONITOR_SCOPE_REQUIRED','RESTRICTED_DATABASE_URL_REQUIRED','ALERT_WEBHOOK_INVALID','ALERT_WEBHOOK_HTTPS_REQUIRED','ALERT_WEBHOOK_TOKEN_INVALID','ALERT_OUTBOX_REQUIRED','ALERT_OUTBOX_PRIVATE_FILE_REQUIRED','ALERT_WEBHOOK_REQUIRED','ALERT_ENVELOPE_INVALID'].includes(error.code)?error.code:'MONITOR_DATABASE_OR_OUTBOX_UNAVAILABLE';
  let cached=null;
  if(code==='MONITOR_DATABASE_OR_OUTBOX_UNAVAILABLE'&&outbox&&webhook){
    try{const tenantId=process.env.WMS_MONITOR_TENANT_ID,warehouses=[...new Set((process.env.WMS_MONITOR_WAREHOUSE_IDS??'').split(',').map(v=>v.trim()).filter(Boolean))];if(uuid.test(tenantId??'')&&warehouses.length&&warehouses.every(id=>uuid.test(id)))cached=cachedFailureReport(outbox,webhook,tenantId,warehouses);
      if(cached){const queued=enqueueAlertReport(outbox,cached,webhook,{resolveMissing:false}),delivery=await deliverAlerts(outbox,webhook);cached.notifications={...cached.notifications,...queued,...delivery,sent:delivery.sent>0};}}
    catch{cached=null;}
  }
  console.log(JSON.stringify(cached??{status:'critical',checked_at:new Date().toISOString(),checks:[{name:'readiness',status:'critical',details:{reason:code}}],alerts:[{code,severity:'critical'}],notifications:{status:outbox?'scope_not_previously_verified':'not_configured',delivery:'stdout_only',sent:false}}));process.exitCode=2;
} finally {outbox?.close();if(client)await client.end().catch(()=>{});}
