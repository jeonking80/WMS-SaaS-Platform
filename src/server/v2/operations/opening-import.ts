import {createHash,randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {DomainError} from '../../api';
import type {Identity} from '../../auth/access';
import {withTenant} from '../../db/tenant';
import {requireV2Access,uuid} from '../access';
import {parseCsv} from '../masters/csv';
import {importLegacyOpeningInTransaction} from '../workflow';

type Row={item_id:string;location_id:string;item_code:string;location_code:string;bucket:'S'|'Q'|'B';quantity:number};
const fail=(code:string,status=409):never=>{throw new DomainError(status,code);};
function canonical(value:unknown):string {if(value===null||typeof value!=='object')return JSON.stringify(value);if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical((value as Record<string,unknown>)[key])).join(',')+'}';}
const hash=(value:unknown)=>createHash('sha256').update(canonical(value)).digest('hex');
function text(value:unknown,max=200){if(typeof value!=='string'||!value.trim()||value.length>max)fail('INVALID_INPUT',400);return (value as string).trim();}
async function scope(identity:Identity,warehouse:unknown){
 if(typeof warehouse!=='string'||!uuid.test(warehouse))fail('INVALID_INPUT',400);
 await requireV2Access(identity,warehouse as string,'identity.manage');return warehouse as string;
}
async function requireAdministrator(c:PoolClient,identity:Identity,warehouse:string){
 const current=await c.query(`SELECT 1 FROM memberships m JOIN tenants t ON t.id=m.tenant_id JOIN v2_warehouse_grants g ON g.tenant_id=m.tenant_id AND g.user_id=m.user_id
  WHERE m.tenant_id=$1 AND m.user_id=$2 AND m.status='active' AND m.role='admin' AND t.active AND g.warehouse_id=$3 FOR SHARE OF m,t,g`,[identity.tenant.id,identity.user.id,warehouse]);
 if(!current.rowCount)fail('ROLE_FORBIDDEN',403);
}
async function preview(c:PoolClient,tenant:string,warehouse:string,body:Record<string,unknown>){
 const source_system=text(body.source_system),reason=text(body.reason,1000);
 text(body.csv,1_000_000);const csv=body.csv as string;
 const extracted_at=text(body.extracted_at,50);if(!Number.isFinite(Date.parse(extracted_at))||Date.parse(extracted_at)>Date.now())fail('INVALID_EXTRACTION_TIME',400);
 const records=parseCsv(csv,true);if(!records.length||records.length>1000)fail('INVALID_INPUT',400);
 const items=(await c.query('SELECT id,code,active FROM items WHERE tenant_id=$1 FOR SHARE',[tenant])).rows;
 const locations=(await c.query('SELECT id,code,kind,active FROM locations WHERE tenant_id=$1 AND warehouse_id=$2 FOR SHARE',[tenant,warehouse])).rows;
 const rows:Row[]=[],errors:{row:number;message:string}[]=[],seen=new Set<string>();
 for(const [index,r] of records.entries()){
  const item=items.find(i=>i.code===r.item_code&&i.active),location=locations.find(l=>l.code===r.location_code&&l.active);
  const quantity=Number(r.quantity),bucket=r.bucket as Row['bucket'],key=`${r.item_code}:${r.location_code}:${bucket}`;
  let message='';
  if(Object.keys(r).sort().join(',')!=='bucket,item_code,location_code,quantity')message='필수 열은 item_code,location_code,bucket,quantity입니다.';
  else if(!item||!location)message='현재 회사·창고의 활성 품목·위치 코드가 아닙니다.';
  else if(!['S','Q','B'].includes(bucket)||location.kind!==({S:'STORAGE',Q:'RECEIVING',B:'HOLD'}[bucket]))message='상태와 위치 유형이 일치하지 않습니다.';
  else if(!/^[1-9]\d*$/.test(r.quantity)||!Number.isSafeInteger(quantity)||quantity>1e9)message='수량은 1~1,000,000,000 정수 EA여야 합니다.';
  else if(seen.has(key))message='같은 품목·위치·상태가 중복되었습니다.';
  if(message)errors.push({row:index+2,message});
  else{seen.add(key);rows.push({item_id:item.id,location_id:location.id,item_code:r.item_code,location_code:r.location_code,bucket,quantity});}
 }
 return {source_system,extracted_at:new Date(extracted_at).toISOString(),reason,csv,source_hash:createHash('sha256').update(csv).digest('hex'),rows,errors};
}
export async function listOpeningImports(identity:Identity,warehouseInput:unknown){
 const warehouse=await scope(identity,warehouseInput);
 return withTenant(identity.tenant.id,async c=>{
  await requireAdministrator(c,identity,warehouse);
  return {imports:(await c.query('SELECT o.id,o.phase,o.parent_id,o.payload,o.actor_id,u.name AS actor_name,o.created_at FROM v2_opening_imports o LEFT JOIN "user" u ON u.id=o.actor_id WHERE o.tenant_id=$1 AND o.warehouse_id=$2 ORDER BY o.created_at DESC,o.id',[identity.tenant.id,warehouse])).rows};
 });
}
export async function openingImport(identity:Identity,body:Record<string,unknown>){
 const warehouse=await scope(identity,body.warehouse_id),tenant=identity.tenant.id;
 if(!['preview','submit','approve','reject'].includes(String(body.action)))fail('INVALID_INPUT',400);
 const requestId=body.action==='preview'?null:String(body.request_id??'');if(requestId!==null&&!uuid.test(requestId))fail('INVALID_INPUT',400);
 return withTenant(tenant,async c=>{
  // Use the same tenant/request lock order as workflow commands, including requests in different warehouses.
  if(requestId!==null)await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[tenant+':'+requestId]);
  const wh=await c.query('SELECT id FROM warehouses WHERE tenant_id=$1 AND id=$2 AND active FOR UPDATE',[tenant,warehouse]);if(!wh.rowCount)fail('NOT_FOUND',404);
  await requireAdministrator(c,identity,warehouse);
  if(body.action==='preview')return preview(c,tenant,warehouse,body);
  if(requestId===null)return fail('INVALID_INPUT',400);
  const fingerprint=hash(body),prior=(await c.query('SELECT * FROM v2_opening_imports WHERE tenant_id=$1 AND request_id=$2',[tenant,requestId])).rows[0];
  if(prior){if(prior.actor_id!==identity.user.id||prior.payload.fingerprint!==fingerprint)fail('IDEMPOTENCY_CONFLICT');return {import:prior,replayed:true};}
  let payload:Record<string,unknown>,phase:string,parent:string|null=null;
  if(body.action==='submit'){payload={...await preview(c,tenant,warehouse,body),fingerprint};phase='request';}
  else{
   parent=String(body.import_id??'');if(!uuid.test(parent)||body.confirmed!==true)fail('INVALID_INPUT',400);
   const original=(await c.query("SELECT * FROM v2_opening_imports WHERE tenant_id=$1 AND warehouse_id=$2 AND id=$3 AND phase='request'",[tenant,warehouse,parent])).rows[0];
   if(!original)fail('NOT_FOUND',404);if(original.actor_id===identity.user.id)fail('SEPARATE_APPROVER_REQUIRED',403);
   if((await c.query('SELECT 1 FROM v2_opening_imports WHERE tenant_id=$1 AND parent_id=$2',[tenant,parent])).rowCount)fail('ALREADY_DECIDED');
   payload={fingerprint,reason:text(body.reason,1000),source_hash:original.payload.source_hash};phase=String(body.action);
   if(phase==='approve'){
    if(original.payload.errors.length)fail('IMPORT_HAS_ERRORS');
    const refreshed=await preview(c,tenant,warehouse,original.payload);
    if(refreshed.errors.length||hash(refreshed.rows)!==hash(original.payload.rows))fail('REFERENCE_CONFLICT');
    const occupied=(await c.query(`SELECT
      EXISTS(SELECT 1 FROM inventory_documents WHERE tenant_id=$1 AND warehouse_id=$2) OR
      EXISTS(SELECT 1 FROM stock_ledger WHERE tenant_id=$1 AND warehouse_id=$2) OR
      EXISTS(SELECT 1 FROM stock_balances WHERE tenant_id=$1 AND warehouse_id=$2) OR
      EXISTS(SELECT 1 FROM v2_cutovers WHERE tenant_id=$1 AND warehouse_id=$2) OR
      EXISTS(SELECT 1 FROM v2_workflow_stock WHERE tenant_id=$1 AND warehouse_id=$2) OR
      EXISTS(SELECT 1 FROM v2_workflow_ledger WHERE tenant_id=$1 AND warehouse_id=$2) OR
      EXISTS(SELECT 1 FROM v2_workflow_requests WHERE tenant_id=$1 AND warehouse_id=$2) OR
      EXISTS(SELECT 1 FROM v2_workflow_objects WHERE tenant_id=$1 AND warehouse_id=$2) OR
      EXISTS(SELECT 1 FROM v2_workflow_performances WHERE tenant_id=$1 AND warehouse_id=$2) OR
      EXISTS(SELECT 1 FROM v2_workflow_receivings WHERE tenant_id=$1 AND warehouse_id=$2) AS occupied`,[tenant,warehouse])).rows[0].occupied;
    if(occupied)fail('EXTERNAL_OPENING_REQUIRES_EMPTY_WAREHOUSE');
    await importLegacyOpeningInTransaction(c,identity,warehouse,refreshed.rows,requestId,'EXTERNAL_OPENING');
    await c.query('INSERT INTO v2_cutovers(tenant_id,warehouse_id,snapshot_hash,opening,actor_id,request_id) VALUES($1,$2,$3,$4::jsonb,$5,$6)',[tenant,warehouse,hash({source_hash:refreshed.source_hash,import_id:parent}),JSON.stringify(refreshed.rows),identity.user.id,requestId]);
    payload={...payload,rows:refreshed.rows};
   }
  }
  const record=(await c.query('INSERT INTO v2_opening_imports(id,tenant_id,warehouse_id,request_id,phase,parent_id,payload,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8) RETURNING *',[randomUUID(),tenant,warehouse,requestId,phase,parent,JSON.stringify(payload),identity.user.id])).rows[0];
  return {import:record,replayed:false};
 });
}
