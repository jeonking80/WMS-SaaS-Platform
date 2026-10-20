import {createHash} from 'node:crypto';
/** Fits PostgreSQL's 63-byte application_name; includes no actor, SQL or credential. */
export function transactionApplicationName(tenantId,warehouseId=null){
  return 'wms:'+createHash('sha256').update(JSON.stringify([tenantId,warehouseId])).digest('hex').slice(0,56);
}
