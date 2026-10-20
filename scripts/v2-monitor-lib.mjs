import { readFile } from 'node:fs/promises';
import {transactionApplicationName} from './v2-lock-scope.mjs';

/** Snapshot of currently waiting, explicitly attributed application transactions only. */
export async function collectDatabaseLocks(client,tenantId,warehouseIds){
  const tags=warehouseIds.map(id=>transactionApplicationName(tenantId,id));
  const result=(await client.query(`WITH scoped AS (
    SELECT a.pid,min(l.waitstart) wait_started_at FROM pg_stat_activity a JOIN pg_locks l ON l.pid=a.pid
    WHERE a.usename=current_user AND a.datname=current_database() AND a.pid<>pg_backend_pid()
      AND a.application_name=ANY($1::text[]) AND NOT l.granted GROUP BY a.pid
  ) SELECT count(*)::int waiting_requests,count(*) FILTER(WHERE wait_started_at IS NULL)::int unknown_start,
    COALESCE(max(EXTRACT(epoch FROM clock_timestamp()-wait_started_at)*1000),0)::float8 max_wait_ms,
    COALESCE(avg(EXTRACT(epoch FROM clock_timestamp()-wait_started_at)*1000),0)::float8 mean_wait_ms,
    clock_timestamp() measured_at FROM scoped`,[tags])).rows[0];
  return {waiting_requests:result.waiting_requests,unknown_start:result.unknown_start,max_wait_ms:Math.round(result.max_wait_ms),mean_wait_ms:Math.round(result.mean_wait_ms),measured_at:new Date(result.measured_at).toISOString(),
    scope:'current lock waits of this database role, tenant and selected warehouses; server-attributed transactions only',
    tenant_only_transactions:'excluded: warehouse attribution unavailable',history:'not measured; completed waits are outside this snapshot'};
}

export async function readBackupEvidence(file, tenantId) {
  if (!file) return { status: 'unknown', reason: 'BACKUP_EVIDENCE_NOT_CONFIGURED' };
  try {
    const evidence = JSON.parse(await readFile(file, 'utf8'));
    const record = evidence.tenants?.[tenantId] ?? evidence;
    if (record.tenant_id !== tenantId || typeof record.completed_at !== 'string' || !Number.isFinite(Date.parse(record.completed_at)) || !/^[a-f0-9]{64}$/i.test(record.archive_sha256 ?? '')) {
      return { status: 'unknown', reason: 'BACKUP_EVIDENCE_INVALID' };
    }
    return { status: 'recorded', completed_at: record.completed_at, restore_verified_at: record.restore_verified_at ?? null,
      provider_restore_verified_at: record.provider_restore_verified_at ?? null, verification: 'recorded_evidence' };
  } catch {
    return { status: 'unknown', reason: 'BACKUP_EVIDENCE_UNAVAILABLE' };
  }
}

/** Invoker-owned transaction and RLS context are required. All SQL also includes explicit scope. */
export async function collectMonitor(client, options) {
  const { tenantId, warehouseIds, now = new Date(), backupEvidence = { status: 'unknown', reason: 'BACKUP_EVIDENCE_NOT_CONFIGURED' },
    pendingMinutes = 15, reservationHours = 24, backupHours = 26, recipientConfigured = false } = options;
  const checks = [], alerts = [],stateByWarehouse=new Map();
  const add = (name, status, details, code = name.toUpperCase()) => {
    checks.push({ name, status, details });
    if (status !== 'ok') alerts.push({ code, severity: status === 'critical' ? 'critical' : 'warning', status });
  };
  const probeStarted=performance.now();await client.query('SELECT 1');
  add('database', 'ok', { connected: true, probe_latency_ms: Math.round((performance.now()-probeStarted)*100)/100, measurement:'one round-trip on authenticated pooled connection; connection setup latency not measured' });
  const scope = await client.query('SELECT id,code,name FROM warehouses WHERE tenant_id=$1 AND id=ANY($2::uuid[]) AND active ORDER BY id', [tenantId, warehouseIds]);
  if (scope.rows.length !== warehouseIds.length) {
    add('warehouse_scope', 'critical', { expected: warehouseIds.length, available: scope.rows.length }, 'WAREHOUSE_SCOPE_UNAVAILABLE');
    return report();
  }
  add('warehouse_scope', 'ok', { count: warehouseIds.length });
  const tables = await client.query(`SELECT to_regclass('v2_workflow_stock') AS stock,to_regclass('v2_workflow_ledger') AS ledger,
    to_regclass('v2_workflow_state') AS state,to_regclass('v2_integration_events') AS events`);
  const ready = tables.rows[0];
  add('readiness', ready.stock && ready.ledger && ready.state && ready.events ? 'ok' : 'unknown', { workflow_schema: Boolean(ready.stock && ready.ledger && ready.state), integration_schema: Boolean(ready.events) }, 'SCHEMA_READINESS_UNKNOWN');
  if (ready.stock && ready.ledger) {
    const differences = await client.query(`WITH balances AS (
      SELECT tenant_id,warehouse_id,item_id,location_id,s,r,p,q,b FROM v2_workflow_stock WHERE tenant_id=$1 AND warehouse_id=ANY($2::uuid[])
    ), ledger AS (
      SELECT tenant_id,warehouse_id,item_id,location_id,
       COALESCE(sum(delta) FILTER(WHERE bucket='S'),0) s,COALESCE(sum(delta) FILTER(WHERE bucket='R'),0) r,
       COALESCE(sum(delta) FILTER(WHERE bucket='P'),0) p,COALESCE(sum(delta) FILTER(WHERE bucket='Q'),0) q,
       COALESCE(sum(delta) FILTER(WHERE bucket='B'),0) b
      FROM v2_workflow_ledger WHERE tenant_id=$1 AND warehouse_id=ANY($2::uuid[]) GROUP BY tenant_id,warehouse_id,item_id,location_id
    ) SELECT count(*)::int AS mismatches FROM balances s FULL JOIN ledger l USING(tenant_id,warehouse_id,item_id,location_id)
      WHERE COALESCE(s.s,0)<>COALESCE(l.s,0) OR COALESCE(s.r,0)<>COALESCE(l.r,0)
       OR COALESCE(s.p,0)<>COALESCE(l.p,0) OR COALESCE(s.q,0)<>COALESCE(l.q,0) OR COALESCE(s.b,0)<>COALESCE(l.b,0)`, [tenantId, warehouseIds]);
    const mismatches = differences.rows[0].mismatches;
    add('inventory_reconciliation', mismatches ? 'critical' : 'ok', { mismatches }, 'STOCK_LEDGER_MISMATCH');
  } else add('inventory_reconciliation', 'unknown', { reason: 'WORKFLOW_SCHEMA_UNAVAILABLE' });
  if (ready.events) {
    const queue = await client.query(`SELECT count(*) FILTER(WHERE status IN ('accepted','dependency_wait','retry_wait'))::int AS pending,
      min(received_at) FILTER(WHERE status IN ('accepted','dependency_wait','retry_wait')) AS oldest_pending_at,
      count(*) FILTER(WHERE status='quarantined')::int AS quarantined,
      count(*) FILTER(WHERE status='business_rejected')::int AS rejected
      FROM v2_integration_events WHERE tenant_id=$1 AND warehouse_id=ANY($2::uuid[])`, [tenantId, warehouseIds]);
    const row = queue.rows[0];
    const oldest = row.oldest_pending_at ? new Date(row.oldest_pending_at).toISOString() : null;
    const age = oldest ? Math.max(0, (now.getTime() - Date.parse(oldest)) / 60000) : 0;
    add('integration_queue', age > pendingMinutes || row.quarantined ? 'warning' : 'ok',
      { pending: row.pending, oldest_pending_at: oldest, oldest_pending_minutes: Math.round(age), quarantined: row.quarantined, rejected: row.rejected, threshold_minutes: pendingMinutes },
      row.quarantined ? 'INTEGRATION_QUARANTINED' : 'INTEGRATION_QUEUE_DELAYED');
  } else add('integration_queue', 'unknown', { reason: 'INTEGRATION_SCHEMA_UNAVAILABLE' });
  if (ready.state) {
    const reservations = await client.query(`SELECT w.warehouse_id,o.value->>'created_at' AS order_created_at,
      r.value->>'reserved_at' AS reserved_at,r.value->>'quantity' AS quantity
      FROM v2_workflow_state w CROSS JOIN LATERAL jsonb_array_elements(COALESCE(w.state->'orders','[]')) o(value)
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(o.value->'reservations','[]')) r(value)
      WHERE w.tenant_id=$1 AND w.warehouse_id=ANY($2::uuid[]) AND COALESCE((r.value->>'quantity')::bigint,0)>0`, [tenantId, warehouseIds]);
    let longCount = 0, unknownAge = 0, approximateCount = 0;
    for (const row of reservations.rows) {
      const created = row.reserved_at ?? row.order_created_at;
      if (!created || !Number.isFinite(Date.parse(created))) { unknownAge++; continue; }
      const age = (now.getTime() - Date.parse(created)) / 3600000;
      if (age > reservationHours) { longCount++; if (!row.reserved_at) approximateCount++; }
    }
    add('long_reservations', longCount || unknownAge ? 'warning' : 'ok',
      { long_reservations: longCount, unknown_age: unknownAge, estimated_from_order_creation: approximateCount, threshold_hours: reservationHours }, 'LONG_RESERVATIONS');
  } else add('long_reservations', 'unknown', { reason: 'WORKFLOW_SCHEMA_UNAVAILABLE' });
  if (ready.state && ready.stock) {
    const states=(await client.query('SELECT warehouse_id,state FROM v2_workflow_state WHERE tenant_id=$1 AND warehouse_id=ANY($2::uuid[])',[tenantId,warehouseIds])).rows;
    const blocked=new Set();let openObjects=0,totalAge=0,maxAge=0,unknownAge=0,overdue=0,openOrders=0,datedOrders=0;
    let differenceRows=0,recordedRows=0,differenceAbsolute=0,differenceSigned=0;
    for(const row of states){
      const state=row.state;
      stateByWarehouse.set(row.warehouse_id,state);
      for(const count of state.counts??[]){
        if(['counting','submitted'].includes(count.status))blocked.add(row.warehouse_id+':'+count.location_id);
        for(const line of count.lines??[]){recordedRows++;const before=(count.baseline??[]).find(b=>b.item_id===line.item_id)?.[line.bucket]??0;const difference=line.quantity-before;if(difference){differenceRows++;differenceAbsolute+=Math.abs(difference);differenceSigned+=difference;}}
      }
      for(const block of state.location_blocks??[])blocked.add(row.warehouse_id+':'+block.location_id);
      const incoming=[...(state.receipts??[]),...(state.returns??[])].filter(r=>(!r.closed&&(r.lines??[]).some(l=>l.quantity>l.received+l.cancelled))||(r.lots??[]).some(l=>l.pending+l.normal+l.hold>0));
      const orders=(state.orders??[]).filter(o=>(o.lines??[]).some(l=>l.quantity>l.cancelled+l.shipped));
      openOrders+=orders.length;
      for(const order of orders){if(order.due_at&&Number.isFinite(Date.parse(order.due_at))){datedOrders++;if(Date.parse(order.due_at)<now.getTime())overdue++;}}
      for(const object of [...incoming,...orders]){openObjects++;const time=Date.parse(object.created_at);if(!Number.isFinite(time)){unknownAge++;continue;}const age=Math.max(0,(now.getTime()-time)/60000);totalAge+=age;maxAge=Math.max(maxAge,age);}
    }
    const inventory=(await client.query(`SELECT s.item_id,s.warehouse_id,s.location_id,s.s,s.r,l.active,l.kind,l.reservation_blocked FROM v2_workflow_stock s JOIN locations l ON l.tenant_id=s.tenant_id AND l.id=s.location_id WHERE s.tenant_id=$1 AND s.warehouse_id=ANY($2::uuid[])`,[tenantId,warehouseIds])).rows;
    const availability=new Map();for(const row of inventory){const key=row.warehouse_id+':'+row.location_id;if(row.active&&row.kind==='STORAGE'&&!row.reservation_blocked&&!blocked.has(key))availability.set(row.item_id,(availability.get(row.item_id)??0)+Number(row.s)-Number(row.r));}
    const items=(await client.query('SELECT id,code,min_stock FROM items WHERE tenant_id=$1 AND active AND min_stock>0 ORDER BY code,id',[tenantId])).rows;
    const below=items.map(i=>({item_id:i.id,item_code:i.code,available_ea:availability.get(i.id)??0,min_stock_ea:Number(i.min_stock)})).filter(i=>i.available_ea<i.min_stock_ea);
    add('low_available_stock',below.length?'warning':'ok',{below_minimum:below,denominator:items.length,as_of:now.toISOString(),scope:'active items with a positive minimum in selected warehouses; A excludes count, shortage and master blocks'},'AVAILABLE_BELOW_MINIMUM');
    const performanceTable=(await client.query("SELECT to_regclass('v2_workflow_performances') AS name")).rows[0].name;
    let commands=[],confirmed=0;
    if(performanceTable){commands=(await client.query(`SELECT p.command,count(DISTINCT p.request_id)::int AS commands,
      COALESCE(sum((line.value->>'quantity')::numeric),0)::text AS quantity_ea
      FROM v2_workflow_performances p LEFT JOIN LATERAL jsonb_array_elements(COALESCE(p.evidence->'lines','[]')) line(value) ON true
      WHERE p.tenant_id=$1 AND p.warehouse_id=ANY($2::uuid[]) AND p.created_at >= $3::timestamptz-interval '24 hours' AND p.created_at <= $3::timestamptz GROUP BY p.command ORDER BY p.command`,[tenantId,warehouseIds,now.toISOString()])).rows;confirmed=commands.reduce((n,c)=>n+c.commands,0);}
    const metricsTable=(await client.query("SELECT to_regclass('api_request_metrics') AS name")).rows[0].name;
    let telemetry=null;
    if(metricsTable)telemetry=(await client.query(`SELECT count(*)::int AS total_requests,
      count(*) FILTER(WHERE status>=500)::int AS technical_failures,
      count(*) FILTER(WHERE status>=400 AND status<500)::int AS business_rejections,
      count(*) FILTER(WHERE command='order.pick')::int AS pick_requests,
      count(*) FILTER(WHERE command='order.pick' AND error_code IN ('WRONG_ITEM_SCAN','WRONG_LOCATION_SCAN','ITEM_SCAN_REQUIRED','SCAN_QUANTITY_MISMATCH'))::int AS rejected_pick_scans,
      percentile_cont(0.95) WITHIN GROUP(ORDER BY duration_ms)::float8 AS request_p95_ms
      FROM api_request_metrics WHERE tenant_id=$1 AND warehouse_id=ANY($2::uuid[]) AND created_at >= $3::timestamptz-interval '24 hours' AND created_at <= $3::timestamptz`,[tenantId,warehouseIds,now.toISOString()])).rows[0];
    add('operational_kpis', telemetry&&performanceTable?(overdue>0||telemetry.rejected_pick_scans>0||(telemetry.technical_failures>0&&telemetry.technical_failures/telemetry.total_requests>0.001)?'warning':'ok'):'unknown', {as_of:now.toISOString(),technical_failure_warning_ratio:0.001,window_start:new Date(now.getTime()-86400000).toISOString(),window_end:now.toISOString(),
      throughput:{status:performanceTable?'measured':'not_measured',confirmed_commands:confirmed,quantity_ea_by_command:commands,denominator:'all committed workflow commands in last 24 hours; replayed requests excluded; quantities are grouped by command and never summed across stages'},
      waiting:{open_objects:openObjects,mean_age_minutes:openObjects-unknownAge?Math.round(totalAge/(openObjects-unknownAge)):0,max_age_minutes:Math.round(maxAge),unknown_age:unknownAge,denominator:'open receipt/return/order objects with known creation time at captured scope; age is since creation, not staff assignment duration'},
      overdue_orders:{numerator:overdue,denominator:datedOrders,open_orders:openOrders,definition:'open orders with valid due_at before captured time / open orders with valid due_at'},
      count_differences:{difference_rows:differenceRows,recorded_rows:recordedRows,difference_ea_absolute:differenceAbsolute,difference_ea_signed:differenceSigned,denominator:'all recorded item/bucket count rows in selected warehouse state; includes current and historical counts'},
      wrong_pick_rate:telemetry?{status:telemetry.pick_requests?'measured':'no_samples',numerator:telemetry.rejected_pick_scans,denominator:telemetry.pick_requests,definition:'server rejected scan validations / all order.pick API requests in the window; not a physical defect rate'}:{status:'not_measured',numerator:null,denominator:null,reason:'REJECTED_SCAN_TELEMETRY_PIPELINE_NOT_CONFIGURED'},
      request_failure_rate:telemetry?{status:telemetry.total_requests?'measured':'no_samples',numerator:telemetry.technical_failures,denominator:telemetry.total_requests,business_rejections:telemetry.business_rejections,request_p95_ms:telemetry.request_p95_ms,definition:'HTTP 5xx / all telemetry-recorded requests after successful tenant/warehouse authorization; HTTP 4xx reported separately; denied and global requests outside this scope are excluded'}:{status:'not_measured',numerator:null,denominator:null,reason:'STRUCTURED_REQUEST_LOG_AGGREGATION_NOT_CONFIGURED'}},'KPI_TELEMETRY_INCOMPLETE');
  }
  try{
    await client.query('SAVEPOINT monitor_lock_check');
    const locks=await collectDatabaseLocks(client,tenantId,warehouseIds);
    await client.query('RELEASE SAVEPOINT monitor_lock_check');
    add('database_lock_wait',locks.unknown_start?'unknown':locks.waiting_requests?'warning':'ok',locks,'DATABASE_LOCK_WAIT');
  }catch{await client.query('ROLLBACK TO SAVEPOINT monitor_lock_check');await client.query('RELEASE SAVEPOINT monitor_lock_check');add('database_lock_wait','unknown',{reason:'LOCK_STATISTICS_UNAVAILABLE'});}
  if (backupEvidence.status !== 'recorded') {
    add('backup', 'unknown', { reason: backupEvidence.reason }, 'BACKUP_STATUS_UNKNOWN');
  } else {
    const age = (now.getTime() - Date.parse(backupEvidence.completed_at)) / 3600000;
    add('backup', age < 0 || age > backupHours ? 'warning' : 'ok',
      { completed_at: backupEvidence.completed_at, age_hours: Math.round(age * 10) / 10, threshold_hours: backupHours, verification: backupEvidence.verification }, 'BACKUP_STALE');
  }
  const restore = backupEvidence.restore_verified_at;
  add('restore_rehearsal', restore && Number.isFinite(Date.parse(restore)) && Date.parse(restore) <= now.getTime() ? 'ok' : 'unknown',
    restore && Number.isFinite(Date.parse(restore)) && Date.parse(restore) <= now.getTime() ? { verified_at: restore, verification: 'recorded_evidence' } : { reason: 'RESTORE_EVIDENCE_UNAVAILABLE' }, 'RESTORE_STATUS_UNKNOWN');
  const provider = backupEvidence.provider_restore_verified_at;
  add('provider_recovery', provider && Number.isFinite(Date.parse(provider)) && Date.parse(provider) <= now.getTime() ? 'ok' : 'unknown',
    provider && Number.isFinite(Date.parse(provider)) && Date.parse(provider) <= now.getTime() ? { verified_at: provider, verification: 'recorded_evidence' } : { reason: 'PROVIDER_RECOVERY_NOT_VERIFIED' }, 'PROVIDER_RECOVERY_UNKNOWN');
  if (!recipientConfigured) add('alert_recipient', 'unknown', { configured: false, delivery: 'stdout_only' }, 'ALERT_RECIPIENT_NOT_CONFIGURED');
  else add('alert_recipient', 'ok', { configured: true, delivery: 'operator_cli_durable_webhook', actual_delivery: 'inspect CLI outbox result; API reads do not send' });
  return report();
  async function report() {
    const tenant=(await client.query('SELECT id,name FROM tenants WHERE id=$1',[tenantId])).rows[0]??{id:tenantId,name:null};
    const envelopes=[];
    for(const alert of alerts){
      for(const warehouse of scope.rows){
        let references=[],tab='queue';
        if(['INTEGRATION_QUARANTINED','INTEGRATION_QUEUE_DELAYED'].includes(alert.code)){
          const statuses=alert.code==='INTEGRATION_QUARANTINED'?['quarantined']:['accepted','dependency_wait','retry_wait'];
          const receivedBefore=alert.code==='INTEGRATION_QUEUE_DELAYED'?new Date(now.getTime()-pendingMinutes*60000).toISOString():null;
          tab='integration';references=(await client.query(`SELECT id,event_id,sequence::text,status FROM v2_integration_events WHERE tenant_id=$1 AND warehouse_id=$2 AND status=ANY($3::text[]) AND ($4::timestamptz IS NULL OR received_at<$4) ORDER BY received_at,sequence LIMIT 10`,[tenantId,warehouse.id,statuses,receivedBefore])).rows.map(row=>({kind:'integration_event',business_id:row.id,business_number:row.sequence,request_id:null}));
          // This alert may originate in another authorized warehouse of a CLI scope.
          // Do not attach it to a warehouse with no matching incident.
          if(!references.length)continue;
        }else if(alert.code==='LONG_RESERVATIONS'){
          tab='orders';references=(await client.query(`SELECT o.value->>'id' id FROM v2_workflow_state w CROSS JOIN LATERAL jsonb_array_elements(COALESCE(w.state->'orders','[]')) o(value) WHERE w.tenant_id=$1 AND w.warehouse_id=$2 AND o.value->>'id' IS NOT NULL AND EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(o.value->'reservations','[]')) r(value) WHERE COALESCE((r.value->>'quantity')::bigint,0)>0 AND COALESCE(r.value->>'reserved_at',o.value->>'created_at','')<$3) ORDER BY o.value->>'id' LIMIT 10`,[tenantId,warehouse.id,new Date(now.getTime()-reservationHours*3600000).toISOString()])).rows.map(row=>({kind:'order',business_id:row.id,business_number:row.id,request_id:null}));
          for(const reference of references){reference.request_id=(await client.query("SELECT request_id FROM v2_workflow_requests WHERE tenant_id=$1 AND warehouse_id=$2 AND response->'result'->>'id'=$3 ORDER BY created_at DESC LIMIT 1",[tenantId,warehouse.id,reference.business_id])).rows[0]?.request_id??null;}
        }else if(alert.code==='KPI_TELEMETRY_INCOMPLETE'){
          const overdue=(stateByWarehouse.get(warehouse.id)?.orders??[]).filter(order=>order.id&&Number.isFinite(Date.parse(order.due_at))&&Date.parse(order.due_at)<now.getTime()&&(order.lines??[]).some(line=>line.quantity>line.cancelled+line.shipped)).slice(0,5);
          references=overdue.map(order=>({kind:'order',business_id:order.id,business_number:order.id,request_id:null}));
          if(references.length)tab='orders';
          for(const reference of references)reference.request_id=(await client.query("SELECT request_id FROM v2_workflow_requests WHERE tenant_id=$1 AND warehouse_id=$2 AND response->'result'->>'id'=$3 ORDER BY created_at DESC LIMIT 1",[tenantId,warehouse.id,reference.business_id])).rows[0]?.request_id??null;
          if((await client.query("SELECT to_regclass('api_request_metrics') AS name")).rows[0].name)references.push(...(await client.query('SELECT request_id FROM api_request_metrics WHERE tenant_id=$1 AND warehouse_id=$2 AND status>=400 ORDER BY created_at DESC LIMIT $3',[tenantId,warehouse.id,10-references.length])).rows.map(row=>({kind:'request',business_id:null,business_number:null,request_id:row.request_id})));
        }else if(['STOCK_LEDGER_MISMATCH','AVAILABLE_BELOW_MINIMUM'].includes(alert.code))tab='inventory';
        const query=new URLSearchParams({warehouse_id:warehouse.id,tab});
        if(references[0]?.business_id&&['orders','integration'].includes(tab))query.set(tab==='integration'?'event_id':'object_id',references[0].business_id);
        envelopes.push({...alert,tenant,warehouses:[warehouse],references,observed_at:now.toISOString(),action:{path:'/dashboard/v2?'+query,authorization:'active manager membership and explicit warehouse access rechecked by server'}});
      }
      // A missing/unauthorized warehouse produces no actionable identifier or link.
    }
    return { status: checks.some(c => c.status === 'critical') ? 'critical' : checks.some(c => c.status !== 'ok') ? 'warning' : 'ok',
      checked_at: now.toISOString(), tenant_id: tenantId, warehouse_ids: warehouseIds, checks, alerts:envelopes,
      notifications: { status: recipientConfigured ? 'operator_cli_delivery_configured' : 'not_configured', recipient_configured: recipientConfigured, delivery: recipientConfigured?'operator_cli_durable_webhook':'stdout_only', sent: false } };
  }
}
