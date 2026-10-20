import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { DomainError } from '../../api';
import { tables, uuid, type MasterKind } from './input';
export async function assertMasterUnused(client:PoolClient,kind:MasterKind,id:string) {
 if((await client.query("SELECT master_workflow_in_use(NULLIF(current_setting('app.tenant_id',true),'')::uuid,$1,$2) AS used",[kind,id])).rows[0].used)throw new DomainError(409,'MASTER_IN_USE');
 if(kind==='barcodes'){const target=(await client.query('SELECT item_id,location_id FROM master_barcodes WHERE id=$1',[id])).rows[0];if(target)await assertMasterUnused(client,target.item_id?'items':'locations',target.item_id??target.location_id);}
 if(kind==='items'||kind==='locations') {
  const column=kind==='items'?'item_id':'location_id';
  if((await client.query(`SELECT 1 FROM stock_balances WHERE ${column}=$1 AND quantity>0 LIMIT 1`,[id])).rowCount)throw new DomainError(409,'MASTER_IN_USE');
  if((await client.query("SELECT to_regclass('v2_workflow_stock') AS table_name")).rows[0].table_name && (await client.query(`SELECT 1 FROM v2_workflow_stock WHERE ${column}=$1 AND (s>0 OR r>0 OR p>0 OR q>0 OR b>0) LIMIT 1`,[id])).rowCount)throw new DomainError(409,'MASTER_IN_USE');
  const sql=kind==='items'?`SELECT 1 FROM inventory_document_lines l JOIN inventory_documents d ON l.tenant_id=d.tenant_id AND l.document_id=d.id WHERE d.status='DRAFT' AND l.item_id=$1 LIMIT 1`:`SELECT 1 FROM inventory_documents WHERE status='DRAFT' AND (source_location_id=$1 OR destination_location_id=$1) LIMIT 1`;
  if((await client.query(sql,[id])).rowCount)throw new DomainError(409,'MASTER_IN_USE');
 }
 if(kind==='partners' && (await client.query('SELECT 1 FROM delivery_destinations WHERE partner_id=$1 AND active LIMIT 1',[id])).rowCount)throw new DomainError(409,'MASTER_IN_USE');
 if(kind==='destinations' && (await client.query("SELECT 1 FROM inventory_documents WHERE delivery_destination_id=$1 AND status='DRAFT' LIMIT 1",[id])).rowCount)throw new DomainError(409,'MASTER_IN_USE');
}
async function lockActive(client:PoolClient,table:string,id:unknown) {
 const row=(await client.query(`SELECT * FROM ${table} WHERE id=$1 FOR SHARE`,[id])).rows[0];
 if(!row)throw new DomainError(404,'REFERENCE_NOT_FOUND');
 if(!row.active)throw new DomainError(409,'INACTIVE_REFERENCE');
 return row;
}
export async function validateReferences(client:PoolClient,kind:MasterKind,input:Record<string,unknown>,warehouseId:string) {
 await lockActive(client,'warehouses',warehouseId);
 if(kind==='destinations' && input.partner_id) {const partner=await lockActive(client,'business_partners',input.partner_id);if(!partner.customer)throw new DomainError(400,'CUSTOMER_REQUIRED');}
 if(kind==='barcodes') {
  if(input.item_id)await lockActive(client,'items',input.item_id);
  if(input.location_id){const location=await lockActive(client,'locations',input.location_id);if(location.warehouse_id!==warehouseId)throw new DomainError(404,'REFERENCE_NOT_FOUND');}
 }
}
export async function insertMaster(client:PoolClient,tenantId:string,warehouseId:string,kind:MasterKind,input:Record<string,unknown>) {
 await validateReferences(client,kind,input,warehouseId);
 const data={tenant_id:tenantId,...(kind==='locations'?{warehouse_id:warehouseId}:{}),...input};
 const keys=Object.keys(data);
 return (await client.query(`INSERT INTO ${tables[kind]} (${keys.join(',')}) VALUES (${keys.map((_,i)=>`$${i+1}`).join(',')}) RETURNING *`,Object.values(data))).rows[0];
}
export async function updateMaster(client:PoolClient,warehouseId:string,kind:MasterKind,id:string,input:Record<string,unknown>) {
 // Parent warehouse is locked first, matching workflow's reference lock order.
 await lockActive(client,'warehouses',warehouseId);
 const current=(await client.query(`SELECT * FROM ${tables[kind]} WHERE id=$1 FOR UPDATE`,[id])).rows[0];
 if(!current || (kind==='locations'&&current.warehouse_id!==warehouseId))throw new DomainError(404,'NOT_FOUND');
 if(kind==='barcodes' && current.location_id) {
  const target=(await client.query('SELECT warehouse_id FROM locations WHERE id=$1',[current.location_id])).rows[0];
  if(target?.warehouse_id!==warehouseId)throw new DomainError(404,'NOT_FOUND');
 }
 if(input.active===false || (kind==='partners'&&((current.supplier&&input.supplier===false)||(current.customer&&input.customer===false))) || (kind==='locations'&&input.kind!==undefined&&input.kind!==current.kind))await assertMasterUnused(client,kind,id);
 if(kind==='partners' && !(input.supplier??current.supplier) && !(input.customer??current.customer))throw new DomainError(400,'PARTNER_ROLE_REQUIRED');
 await validateReferences(client,kind,{...current,...input},warehouseId);
 const keys=Object.keys(input);
 return (await client.query(`UPDATE ${tables[kind]} SET ${keys.map((k,i)=>`${k}=$${i+2}`).join(',')}${kind==='destinations'?',updated_at=clock_timestamp()':''} WHERE id=$1 RETURNING *`,[id,...Object.values(input)])).rows[0];
}
function masterListing(kind:MasterKind,warehouseId:string,params:URLSearchParams) {
 const values:unknown[]=[];const filters:string[]=[];
 if(kind==='locations'){values.push(warehouseId);filters.push(`m.warehouse_id=$${values.length}`);}
 if(kind==='barcodes'){values.push(warehouseId);filters.push(`(m.location_id IS NULL OR EXISTS(SELECT 1 FROM locations l WHERE l.id=m.location_id AND l.warehouse_id=$${values.length}))`);}
 const q=params.get('q');if(q){if(q.length>128)throw new DomainError(400,'INVALID_FILTER');values.push('%'+q.replace(/[\\%_]/g,'\\$&')+'%');const columns=kind==='barcodes'?['barcode']:kind==='destinations'?['name','recipient_name','external_code']:kind==='items'?['code','name','search_terms']:kind==='partners'?['code','name','external_code']:['code','name'];filters.push('('+columns.map(k=>`m.${k} ILIKE $${values.length}`).join(' OR ')+')');}
 const active=params.get('active');if(active!==null){if(!['true','false'].includes(active))throw new DomainError(400,'INVALID_FILTER');values.push(active==='true');filters.push(`m.active=$${values.length}`);}
 return {values,filters};
}
export async function listMasters(client:PoolClient,kind:MasterKind,warehouseId:string,params:URLSearchParams,unlimited=false) {
 const {values,filters}=masterListing(kind,warehouseId,params);
 return (await client.query(`SELECT m.*${unlimited?", statement_timestamp() AS export_captured_at":""} FROM ${tables[kind]} m ${filters.length?'WHERE '+filters.join(' AND '):''} ORDER BY m.id ${unlimited?'':'LIMIT 1000'}`,values)).rows;
}
export async function listMasterPage(client:PoolClient,tenantId:string,kind:MasterKind,warehouseId:string,params:URLSearchParams) {
 const {values,filters}=masterListing(kind,warehouseId,params),raw=params.get('limit');
 if(raw!==null&&!/^[1-9]\d{0,3}$/.test(raw))throw new DomainError(400,'INVALID_LIMIT');
 const limit=raw===null?1000:Number(raw);if(limit>1000)throw new DomainError(400,'INVALID_LIMIT');
 const scope=createHash('sha256').update(JSON.stringify({tenantId,warehouseId,kind,q:params.get('q')??'',active:params.get('active'),limit})).digest('hex');
 const cursor=params.get('cursor');
 if(cursor!==null){
  try{if(!/^[A-Za-z0-9_-]{1,1024}$/.test(cursor))throw Error();const value=JSON.parse(Buffer.from(cursor,'base64url').toString('utf8'));if(value.v!==1||typeof value.after!=='string'||!uuid.test(value.after)||value.scope!==scope)throw Error();values.push(value.after);filters.push(`m.id>$${values.length}::uuid`);}catch{throw new DomainError(400,'INVALID_CURSOR');}
 }
 values.push(limit+1);const found=(await client.query(`SELECT m.* FROM ${tables[kind]} m ${filters.length?'WHERE '+filters.join(' AND '):''} ORDER BY m.id LIMIT $${values.length}`,values)).rows;
 const has_more=found.length>limit,rows=found.slice(0,limit),next_cursor=has_more?Buffer.from(JSON.stringify({v:1,after:rows.at(-1)!.id,scope})).toString('base64url'):null;
 return {rows,has_more,next_cursor};
}
export async function resolveBarcode(client:PoolClient,barcode:string) {
 const row=(await client.query('SELECT * FROM master_barcodes WHERE barcode=$1 AND active FOR SHARE',[barcode])).rows[0];
 if(!row)throw new DomainError(404,'BARCODE_NOT_FOUND');
 const target=await lockActive(client,row.item_id?'items':'locations',row.item_id??row.location_id);
 return {...row,...(row.location_id?{warehouse_id:target.warehouse_id}:{})};
}
