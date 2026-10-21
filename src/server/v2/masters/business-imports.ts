import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import type {Identity} from '../../auth/access';
import {DomainError} from '../../api';
import {executeWorkflowInTransaction} from '../workflow';
import {parseCsv} from './csv';
import {fingerprint,type PreviewRow} from './imports';
export type BusinessKind='receipts'|'orders';
export const businessColumns=['external_id','supplier_code','recipient','delivery','customer_code','destination_external_code','due_at','expected_at','item_code','quantity'];
function fail(code:string):never{throw new DomainError(400,code);}
async function activeCode(c:PoolClient,table:string,column:string,code:string){const r=(await c.query(`SELECT * FROM ${table} WHERE ${column}=$1 FOR SHARE`,[column==='code'?code.toUpperCase():code])).rows[0];if(!r||!r.active)fail('INACTIVE_OR_UNKNOWN_REFERENCE');return r;}
async function businessRow(c:PoolClient,kind:BusinessKind,raw:Record<string,string>){
 if(raw.__csv_column_count_error)fail('CSV_COLUMN_COUNT');
 if(Object.keys(raw).some(k=>!businessColumns.includes(k)))fail('UNKNOWN_COLUMN');
 for(const key of ['external_id','item_code','quantity',...(kind==='receipts'?['supplier_code','expected_at']:['customer_code','destination_external_code','due_at'])])if(!raw[key]?.trim())fail('REQUIRED_'+key.toUpperCase());
 for(const value of Object.values(raw))if(value.length>1000)fail('VALUE_TOO_LONG');
 if(raw.external_id.length>128)fail('EXTERNAL_ID_TOO_LONG');
 const quantity=Number(raw.quantity);if(!Number.isSafeInteger(quantity)||quantity<1||quantity>1e9)fail('INVALID_QUANTITY');
 const item=await activeCode(c,'items','code',raw.item_code.trim());
 const payload:Record<string,unknown>={external_id:raw.external_id.trim()};
 if(kind==='receipts'){
  const supplier=await activeCode(c,'business_partners','code',raw.supplier_code.trim());if(!supplier.supplier)fail('SUPPLIER_REQUIRED');
  payload.supplier_id=supplier.id;payload.supplier={id:supplier.id,code:supplier.code,name:supplier.name};
  if(raw.expected_at){if(!/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(raw.expected_at)||Number.isNaN(Date.parse(raw.expected_at)))fail('INVALID_EXPECTED_DATE');payload.expected_at=raw.expected_at;}
 }else{
  const delivery:Record<string,unknown>={recipient:raw.recipient?.trim()??'',address:raw.delivery?.trim()??''};
  if(raw.customer_code){const customer=await activeCode(c,'business_partners','code',raw.customer_code.trim());if(!customer.customer)fail('CUSTOMER_REQUIRED');delivery.partner_id=customer.id;delivery.partner_name=customer.name;}
  if(raw.destination_external_code){const d=await activeCode(c,'delivery_destinations','external_code',raw.destination_external_code.trim());if(delivery.partner_id!==d.partner_id)fail('DESTINATION_CUSTOMER_MISMATCH');Object.assign(delivery,{delivery_destination_id:d.id,recipient:d.recipient_name,address:[d.address_line1,d.address_line2].filter(Boolean).join(' '),postal_code:d.postal_code,contact_name:d.contact_name,phone:d.phone});}
  payload.delivery=delivery;
  if(raw.due_at){if(!/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(raw.due_at)||Number.isNaN(Date.parse(raw.due_at)))fail('INVALID_DUE_DATE');payload.due_at=raw.due_at;}
 }
 const exists=await c.query(`SELECT 1 FROM v2_workflow_state WHERE state->$1 @> $2::jsonb LIMIT 1`,[kind,JSON.stringify([{external_id:payload.external_id}])]);if(exists.rowCount)fail('EXTERNAL_ID_CONFLICT');
 return {external_id:payload.external_id,payload,line:{item_id:item.id,quantity},source:raw};
}
export async function previewBusinessCsv(c:PoolClient,tenant:string,warehouse:string,kind:BusinessKind,csv:string,key:string){
 const hash=fingerprint({warehouse,kind,csv});await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[tenant+':csv-preview:'+key]);
 const old=(await c.query('SELECT * FROM master_csv_previews WHERE request_key=$1',[key])).rows[0];if(old){if(old.fingerprint!==hash)throw new DomainError(409,'REQUEST_KEY_CONFLICT');return{preview_id:old.id,rows:old.rows};}
 const rows:PreviewRow[]=[];
 for(const [index,raw] of parseCsv(csv,true).entries()){
  let data:Record<string,unknown>={source:raw,external_id:raw.external_id};const errors:string[]=[];
  try{data=await businessRow(c,kind,raw);}catch(e){errors.push(e instanceof DomainError?e.code:'INVALID_ROW');}
  rows.push({row_number:index+2,request_key:fingerprint({tenant,warehouse,kind,key,row:index+2}),data,errors});
 }
 const groups=new Map<string,PreviewRow[]>();for(const row of rows){const key=String(row.data.external_id??'');groups.set(key,[...(groups.get(key)??[]),row]);}
 for(const group of groups.values()){
  const error=group.some(r=>r.errors.length)?'GROUP_HAS_INVALID_ROWS':group.length>100?'DOCUMENT_TOO_MANY_LINES':new Set(group.map(r=>JSON.stringify(r.data.payload))).size>1?'GROUP_HEADER_MISMATCH':new Set(group.map(r=>(r.data.line as {item_id:string}).item_id)).size!==group.length?'DUPLICATE_ITEM':null;
  if(error)for(const row of group)if(!row.errors.includes(error))row.errors.push(error);
 }
 const saved=(await c.query('INSERT INTO master_csv_previews(tenant_id,warehouse_id,kind,request_key,fingerprint,rows) VALUES($1,$2,$3,$4,$5,$6::jsonb) RETURNING id',[tenant,warehouse,kind,key,hash,JSON.stringify(rows)])).rows[0];return{preview_id:saved.id,rows};
}
export async function applyBusinessCsv(c:PoolClient,identity:Identity,warehouse:string,kind:BusinessKind,previewId:string,numbers:unknown,key:string){
 if(!Array.isArray(numbers)||!numbers.length||numbers.length>1000||numbers.some(n=>!Number.isInteger(n)||n<2)||new Set(numbers).size!==numbers.length)fail('INVALID_ROW_SELECTION');
 const selected=[...numbers].sort((a,b)=>a-b);const hash=fingerprint({warehouse,kind,previewId,selected});const tenant=identity.tenant.id;
 await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[tenant+':csv-apply:'+key]);
 const old=(await c.query('SELECT * FROM master_csv_applies WHERE request_key=$1',[key])).rows[0];if(old){if(old.fingerprint!==hash)throw new DomainError(409,'REQUEST_KEY_CONFLICT');return old.result;}
 const preview=(await c.query('SELECT rows FROM master_csv_previews WHERE id=$1 AND warehouse_id=$2 AND kind=$3 FOR UPDATE',[previewId,warehouse,kind])).rows[0];if(!preview)throw new DomainError(404,'PREVIEW_NOT_FOUND');
 const all=preview.rows as PreviewRow[];const chosen=selected.map(n=>{const row=all.find(r=>r.row_number===n);if(!row||row.errors.length)fail('INVALID_ROW_SELECTION');return row;});
 const ids=[...new Set(chosen.map(r=>String(r.data.external_id)))];const results:unknown[]=[];let applied=0;
 for(const id of ids){
  const group=chosen.filter(r=>r.data.external_id===id);if(all.filter(r=>r.data.external_id===id).length!==group.length)fail('GROUP_SELECTION_REQUIRED');
  const prior=(await c.query('SELECT result FROM master_csv_applied_rows WHERE preview_id=$1 AND row_number=$2',[previewId,group[0].row_number])).rows[0];if(prior){results.push(prior.result);continue;}
  // Refresh active codes and immutable snapshots immediately before the same-transaction create.
  const fresh=[];for(const row of group)fresh.push(await businessRow(c,kind,row.data.source as Record<string,string>));
  const payload={...fresh[0].payload,lines:fresh.map(r=>r.line)};
  const outcome=await executeWorkflowInTransaction(c,identity,{warehouse_id:warehouse,request_id:randomUUID(),command:kind==='receipts'?'receipt.create':'order.create',payload},{includeSnapshot:false});
  const result={external_id:id,row_numbers:group.map(r=>r.row_number),request_keys:group.map(r=>r.request_key),...outcome.result};results.push(result);applied++;
  for(const row of group)await c.query('INSERT INTO master_csv_applied_rows(tenant_id,preview_id,row_number,result) VALUES($1,$2,$3,$4::jsonb)',[tenant,previewId,row.row_number,JSON.stringify(result)]);
 }
 const result={rows:results,applied};await c.query('INSERT INTO master_csv_applies(tenant_id,preview_id,request_key,fingerprint,result) VALUES($1,$2,$3,$4,$5::jsonb)',[tenant,previewId,key,hash,JSON.stringify(result)]);return result;
}
