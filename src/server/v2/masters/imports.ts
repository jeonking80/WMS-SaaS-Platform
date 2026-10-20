import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { DomainError } from '../../api';
import { csvInput, type MasterKind } from './input';
import { parseCsv } from './csv';
import { insertMaster } from './service';
export type PreviewRow={row_number:number;request_key?:string;data:Record<string,unknown>;errors:string[]};
export function fingerprint(value:unknown){return createHash('sha256').update(JSON.stringify(value)).digest('hex');}
export function requestKey(key:unknown):string {if(typeof key!=='string'||!key.trim()||key.length>128)throw new DomainError(400,'REQUEST_KEY_REQUIRED');return key;}
function errorCode(e:unknown) {if(e instanceof DomainError)return e.code;const code=(e as {code?:string}).code;return code==='23505'?'DUPLICATE':code==='23503'?'REFERENCE_NOT_FOUND':code==='23514'?'INVALID_INPUT':'INVALID_ROW';}
/** CSV accepts business codes; tenant RLS and explicit warehouse scope resolve them server-side. */
export async function resolveCsvInput(client:PoolClient,kind:MasterKind,raw:Record<string,string>,warehouse:string) {
 const row={...raw};
 const resolve=async(alias:string,target:string,table:string,warehouseScoped=false,customer=false)=>{
  if(!(alias in row))return;
  const code=row[alias].trim();delete row[alias];if(!code)return;
  if(row[target]?.trim())throw new DomainError(400,'REFERENCE_INPUT_CONFLICT');
  const ref=(await client.query(`SELECT id,active${customer?',customer':''} FROM ${table} WHERE code=$1${warehouseScoped?' AND warehouse_id=$2':''} FOR SHARE`,warehouseScoped?[code.toUpperCase(),warehouse]:[code.toUpperCase()])).rows[0];
  if(!ref||!ref.active)throw new DomainError(400,'INACTIVE_OR_UNKNOWN_REFERENCE');
  if(customer&&!ref.customer)throw new DomainError(400,'CUSTOMER_REQUIRED');
  row[target]=ref.id;
 };
 if(kind==='barcodes'){await resolve('item_code','item_id','items');await resolve('location_code','location_id','locations',true);}
 if(kind==='destinations'){
  const customer=row.customer_code?.trim(),partner=row.partner_code?.trim();
  if(customer&&partner&&customer.toUpperCase()!==partner.toUpperCase())throw new DomainError(400,'REFERENCE_INPUT_CONFLICT');
  if(customer&&partner)delete row.partner_code;
  await resolve('customer_code','partner_id','business_partners',false,true);
  await resolve('partner_code','partner_id','business_partners',false,true);
 }
 return csvInput(kind,row);
}
export async function previewCsv(client:PoolClient,tenant:string,warehouse:string,kind:MasterKind,csv:string,key:string):Promise<{preview_id:string;rows:PreviewRow[]}> {
 const hash=fingerprint({warehouse,kind,csv});
 await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[tenant+':csv-preview:'+key]);
 const existing=(await client.query('SELECT * FROM master_csv_previews WHERE request_key=$1',[key])).rows[0];
 if(existing){if(existing.fingerprint!==hash)throw new DomainError(409,'REQUEST_KEY_CONFLICT');return {preview_id:existing.id,rows:existing.rows};}
 const rows:PreviewRow[]=[];const seen=new Set<string>();
 for(const [index,raw] of parseCsv(csv,true).entries()) {
  let data:Record<string,unknown>=raw;const errors:string[]=[];
  try {
   if(raw.__csv_column_count_error)throw new DomainError(400,'CSV_COLUMN_COUNT');
   data=await resolveCsvInput(client,kind,raw,warehouse);
   const unique=String(data.code??data.barcode??`${data.recipient_name}|${data.name}`);
   const external=data.external_code?`external:${data.external_code}`:null;
   if(seen.has(unique)||(external&&seen.has(external)))throw new DomainError(400,'DUPLICATE_IN_FILE');
   seen.add(unique);if(external)seen.add(external);
   await client.query('SAVEPOINT csv_preview_row');
   try{await insertMaster(client,tenant,warehouse,kind,data);}finally{await client.query('ROLLBACK TO SAVEPOINT csv_preview_row');await client.query('RELEASE SAVEPOINT csv_preview_row');}
  } catch(e){errors.push(errorCode(e));}
  rows.push({row_number:index+2,request_key:fingerprint({tenant,warehouse,kind,key,row:index+2}),data,errors});
 }
 const row=(await client.query('INSERT INTO master_csv_previews(tenant_id,warehouse_id,kind,request_key,fingerprint,rows) VALUES($1,$2,$3,$4,$5,$6::jsonb) RETURNING id',[tenant,warehouse,kind,key,hash,JSON.stringify(rows)])).rows[0];
 return {preview_id:row.id,rows};
}
export async function applyCsv(client:PoolClient,tenant:string,warehouse:string,kind:MasterKind,previewId:string,numbers:unknown,key:string) {
 if(!Array.isArray(numbers)||!numbers.length||numbers.length>1000||numbers.some(n=>!Number.isInteger(n)||n<2)||new Set(numbers).size!==numbers.length)throw new DomainError(400,'INVALID_ROW_SELECTION');
 const selected=[...numbers].sort((a,b)=>a-b) as number[];const hash=fingerprint({warehouse,kind,previewId,selected});
 await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[tenant+':csv-apply:'+key]);
 const existing=(await client.query('SELECT * FROM master_csv_applies WHERE request_key=$1',[key])).rows[0];
 if(existing){if(existing.fingerprint!==hash)throw new DomainError(409,'REQUEST_KEY_CONFLICT');return existing.result;}
 const preview=(await client.query('SELECT * FROM master_csv_previews WHERE id=$1 AND warehouse_id=$2 AND kind=$3 FOR UPDATE',[previewId,warehouse,kind])).rows[0];
 if(!preview)throw new DomainError(404,'PREVIEW_NOT_FOUND');
 const rows:unknown[]=[];let applied=0;
 for(const number of selected) {
  const source=(preview.rows as PreviewRow[]).find(r=>r.row_number===number);
  if(!source||source.errors.length)throw new DomainError(400,'INVALID_ROW_SELECTION');
  const prior=(await client.query('SELECT result FROM master_csv_applied_rows WHERE preview_id=$1 AND row_number=$2',[previewId,number])).rows[0];
  if(prior){rows.push(prior.result);continue;}
  const created=await insertMaster(client,tenant,warehouse,kind,source.data);const row={...created,row_number:number,request_key:source.request_key};rows.push(row);applied++;
  await client.query('INSERT INTO master_csv_applied_rows(tenant_id,preview_id,row_number,result) VALUES($1,$2,$3,$4::jsonb)',[tenant,previewId,number,JSON.stringify(row)]);
 }
 const result=JSON.parse(JSON.stringify({rows,applied}));
 await client.query('INSERT INTO master_csv_applies(tenant_id,preview_id,request_key,fingerprint,result) VALUES($1,$2,$3,$4,$5::jsonb)',[tenant,previewId,key,hash,JSON.stringify(result)]);
 return result;
}
