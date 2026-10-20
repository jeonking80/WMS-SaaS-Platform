import type { Identity } from '../../auth/access';
import { DomainError,apiError,json } from '../../api';
import { requireIdentity } from '../../auth/access';
import { getPool } from '../../db/pool';
import { requireV2Access,uuid } from '../access';
import { collectMonitor,readBackupEvidence } from '../../../../scripts/v2-monitor-lib.mjs';

export async function monitorOperations(identity:Identity,warehouseId:string) {
 if(!uuid.test(warehouseId))throw new DomainError(400,'WAREHOUSE_REQUIRED');
 // Approval permission re-reads live role and restricts this operations view to managers.
 await requireV2Access(identity,warehouseId,'approve');
 const backupEvidence=await readBackupEvidence(process.env.WMS_BACKUP_EVIDENCE_FILE,identity.tenant.id);
 const client=await getPool().connect();let discard=false;
 try{
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await client.query("SELECT set_config('app.tenant_id',$1,true),set_config('app.user_id',$2,true),set_config('app.environment',$3,true)",[identity.tenant.id,identity.user.id,process.env.WMS_ENVIRONMENT==='test'?'test':'production']);
  const report=await collectMonitor(client,{tenantId:identity.tenant.id,warehouseIds:[warehouseId],backupEvidence,recipientConfigured:Boolean(process.env.WMS_ALERT_WEBHOOK_URL&&process.env.WMS_ALERT_OUTBOX_FILE)});
  await client.query('COMMIT');return report;
 }catch(error){try{await client.query('ROLLBACK');}catch{discard=true;}throw error;}finally{client.release(discard);}
}
export async function monitorHttp(request:Request) {
 try{
  const identity=await requireIdentity(request.headers);
  const warehouse=new URL(request.url).searchParams.get('warehouse_id');if(!warehouse)throw new DomainError(400,'WAREHOUSE_REQUIRED');
  return json(await monitorOperations(identity,warehouse));
 }catch(error){return apiError(error);}
}
