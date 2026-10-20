import type {PoolClient} from 'pg';
import {getPool} from '../../db/pool';
export type ApiMetric={tenantId:string;warehouseId:string;requestId:string;actorId:string;operation:string;command?:string;method:string;status:number;errorCode:string;durationMs:number};
/** Runs after the business transaction completes. A telemetry outage never changes its response. */
export async function persistApiMetric(metric:ApiMetric):Promise<void> {
 let client:PoolClient|undefined;let discard=false;
 try{
 client=await getPool().connect();await client.query('BEGIN');
 await client.query("SET LOCAL statement_timeout='500ms'");
 await client.query("SELECT set_config('app.tenant_id',$1,true),set_config('app.user_id',$2,true),set_config('app.environment',$3,true)",[metric.tenantId,metric.actorId,process.env.WMS_ENVIRONMENT==='test'?'test':'production']);
 await client.query(`INSERT INTO api_request_metrics(tenant_id,warehouse_id,request_id,actor_id,operation,command,method,status,error_code,duration_ms) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(tenant_id,request_id) DO NOTHING`,[metric.tenantId,metric.warehouseId,metric.requestId,metric.actorId,metric.operation,metric.command??null,metric.method,metric.status,metric.errorCode,metric.durationMs]);
 await client.query('COMMIT');
 }catch{if(client){try{await client.query('ROLLBACK');}catch{discard=true;}}}
 finally{client?.release(discard);}
}
