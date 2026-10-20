import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { DomainError } from '../../api';
import type { Identity } from '../../auth/access';
import { withTenant } from '../../db/tenant';
import { requireV2Access, uuid } from '../access';
import { importLegacyOpeningInTransaction } from '../workflow';

type Opening = { item_id: string; source_location_id: string; location_id: string; bucket: 'S'|'Q'|'B'; quantity: number };
function canonical(value: unknown): string {
 if(value===null||typeof value!=='object')return JSON.stringify(value);
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical((value as Record<string,unknown>)[key])).join(',')+'}';
}
const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
async function inspect(client: PoolClient, tenant: string, warehouse: string) {
 const rows = (await client.query(`SELECT b.item_id,b.location_id,b.quantity::text,i.code AS item_code,i.name AS item_name,l.code AS location_code,
 COALESCE(x.quantity,0)::text AS ledger_quantity FROM stock_balances b JOIN items i ON(i.tenant_id,i.id)=(b.tenant_id,b.item_id)
 JOIN locations l ON(l.tenant_id,l.id)=(b.tenant_id,b.location_id)
 LEFT JOIN(SELECT item_id,location_id,sum(quantity_delta) quantity FROM stock_ledger WHERE tenant_id=$1 AND warehouse_id=$2 GROUP BY item_id,location_id)x USING(item_id,location_id)
 WHERE b.tenant_id=$1 AND b.warehouse_id=$2 ORDER BY b.item_id,b.location_id`,[tenant,warehouse])).rows;
 const mismatches = (await client.query(`WITH l AS(SELECT item_id,location_id,sum(quantity_delta) quantity FROM stock_ledger WHERE tenant_id=$1 AND warehouse_id=$2 GROUP BY item_id,location_id), b AS(SELECT item_id,location_id,quantity FROM stock_balances WHERE tenant_id=$1 AND warehouse_id=$2)
 SELECT COALESCE(l.item_id,b.item_id) item_id,COALESCE(l.location_id,b.location_id) location_id FROM l FULL JOIN b USING(item_id,location_id) WHERE COALESCE(l.quantity,0)<>COALESCE(b.quantity,0)`,[tenant,warehouse])).rows;
 const summary=(await client.query(`SELECT count(*)::int AS documents,count(*) FILTER(WHERE status='DRAFT')::int AS drafts,max(document_no)::text AS last_document_no FROM inventory_documents WHERE tenant_id=$1 AND warehouse_id=$2`,[tenant,warehouse])).rows[0];
 const existing=(await client.query('SELECT snapshot_hash,opening,actor_id,request_id,activated_at FROM v2_cutovers WHERE tenant_id=$1 AND warehouse_id=$2',[tenant,warehouse])).rows[0]??null;
 return {rows,summary,mismatches,consistent:mismatches.length===0,snapshot_hash:hash({rows,summary}),cutover:existing};
}
export async function previewCutover(identity: Identity, warehouse: string) {
 if(!uuid.test(warehouse))throw new DomainError(400,'INVALID_INPUT');
 await requireV2Access(identity,warehouse,'identity.manage');
 return withTenant(identity.tenant.id,async c=>{
  await c.query('SELECT id FROM warehouses WHERE tenant_id=$1 AND id=$2 FOR SHARE',[identity.tenant.id,warehouse]);
  return inspect(c,identity.tenant.id,warehouse);
 });
}
export async function activateCutover(identity: Identity, body: Record<string,unknown>) {
 const warehouse=String(body.warehouse_id??''),requestId=String(body.request_id??'');
 if(!uuid.test(warehouse)||!uuid.test(requestId)||typeof body.snapshot_hash!=='string'||!Array.isArray(body.rows)||body.rows.length>10000||body.confirmed!==true)throw new DomainError(400,'INVALID_INPUT');
 await requireV2Access(identity,warehouse,'identity.manage');
 const rows:Opening[]=body.rows.map(raw=>{
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new DomainError(400,'INVALID_INPUT');
  const x=raw as Record<string,unknown>;
  if(!uuid.test(String(x.item_id))||!uuid.test(String(x.source_location_id))||!uuid.test(String(x.location_id))||!['S','Q','B'].includes(String(x.bucket))||!Number.isSafeInteger(x.quantity)||Number(x.quantity)<=0||Number(x.quantity)>1e9)throw new DomainError(400,'INVALID_INPUT');
  return {item_id:String(x.item_id),source_location_id:String(x.source_location_id),location_id:String(x.location_id),bucket:x.bucket as Opening['bucket'],quantity:Number(x.quantity)};
 });
 return withTenant(identity.tenant.id,async c=>{
  const wh=await c.query('SELECT id FROM warehouses WHERE tenant_id=$1 AND id=$2 AND active FOR UPDATE',[identity.tenant.id,warehouse]);
  if(!wh.rowCount)throw new DomainError(404,'NOT_FOUND');
  const current=await inspect(c,identity.tenant.id,warehouse);
  if(current.cutover){
   if(current.cutover.request_id===requestId&&current.cutover.snapshot_hash===body.snapshot_hash&&hash(current.cutover.opening)===hash(rows))return {cutover:current.cutover,replayed:true};
   throw new DomainError(409,'ALREADY_CONVERTED');
  }
  if(!current.consistent)throw new DomainError(409,'LEDGER_MISMATCH');
  if(current.summary.drafts)throw new DomainError(409,'DRAFTS_REMAIN');
  if(current.snapshot_hash!==body.snapshot_hash)throw new DomainError(409,'VERSION_CONFLICT');
  const expected=new Map(current.rows.filter(r=>Number(r.quantity)!==0).map(r=>[`${r.item_id}:${r.location_id}`,Number(r.quantity)]));
  const actual=new Map<string,number>();
  const locations=(await c.query('SELECT id,kind,active FROM locations WHERE tenant_id=$1 AND warehouse_id=$2 FOR SHARE',[identity.tenant.id,warehouse])).rows;
  for(const row of rows){
   const loc=locations.find(l=>l.id===row.location_id);
   if(!loc?.active||loc.kind!==({S:'STORAGE',Q:'RECEIVING',B:'HOLD'}[row.bucket]))throw new DomainError(409,'LOCATION_TYPE_MISMATCH');
   const key=`${row.item_id}:${row.source_location_id}`;actual.set(key,(actual.get(key)??0)+row.quantity);
  }
  if(actual.size!==expected.size||[...expected].some(([key,q])=>actual.get(key)!==q))throw new DomainError(409,'OPENING_MAPPING_MISMATCH');
  await importLegacyOpeningInTransaction(c,identity,warehouse,rows,requestId);
  const cutover=(await c.query(`INSERT INTO v2_cutovers(tenant_id,warehouse_id,snapshot_hash,opening,actor_id,request_id) VALUES($1,$2,$3,$4::jsonb,$5,$6) RETURNING snapshot_hash,opening,actor_id,request_id,activated_at`,[identity.tenant.id,warehouse,current.snapshot_hash,JSON.stringify(rows),identity.user.id,requestId])).rows[0];
  return {cutover,replayed:false};
 });
}
