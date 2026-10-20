import { DomainError,apiError,json,readBody,requireMutationOrigin } from '../../api';
import { requireIdentity } from '../../auth/access';
import { withTenant } from '../../db/tenant';
import { requireV2Access,authenticateV2Machine } from '../access';
import { parseKind,validateInput,uuid,csvColumns } from './input';
import { insertMaster,updateMaster,listMasters,listMasterPage } from './service';
import { previewCsv,applyCsv,requestKey,type PreviewRow } from './imports';
import { makeCsv } from './csv';
import { previewBusinessCsv,applyBusinessCsv,businessColumns,type BusinessKind } from './business-imports';
type Context={params:Promise<{kind:string;id?:string;operation?:string}>};
export async function masterHttp(request:Request,context:Context,mode:'collection'|'detail'|'preview'|'apply'|'export'|'errors') {
 try {
  const params=new URL(request.url).searchParams;
  const warehouse=params.get('warehouse_id');if(!warehouse||!uuid.test(warehouse))throw new DomainError(400,'WAREHOUSE_REQUIRED');
  const mutation=['POST','PATCH'].includes(request.method);
  const route=await context.params;const business=['receipts','orders'].includes(route.kind);
  const permission=mutation?(business?'write':'master.write'):'read';
  const identity=request.headers.has('authorization')?await authenticateV2Machine(request.headers,permission,warehouse):await requireIdentity(request.headers);
  await requireV2Access(identity,warehouse,permission);
  if(mutation && !('keyId' in identity))requireMutationOrigin(request);
  const kind=business?null:parseKind(route.kind);
  if(business&&!['preview','apply','errors'].includes(mode))throw new DomainError(404,'NOT_FOUND');
  const body=mutation?await readBody(request):{};
  if(mode==='detail' && (!route.id||!uuid.test(route.id)))throw new DomainError(404,'NOT_FOUND');
  const result=await withTenant(identity.tenant.id,async client=>{
   if(business){
    const businessKind=route.kind as BusinessKind;
    if(mode==='preview'){if(typeof body.csv!=='string')throw new DomainError(400,'CSV_REQUIRED');return previewBusinessCsv(client,identity.tenant.id,warehouse,businessKind,body.csv,requestKey(body.request_key));}
    if(mode==='apply'){if(typeof body.preview_id!=='string'||!uuid.test(body.preview_id))throw new DomainError(400,'INVALID_PREVIEW');return applyBusinessCsv(client,identity,warehouse,businessKind,body.preview_id,body.row_numbers,requestKey(body.request_key));}
    const id=params.get('preview_id');if(!id||!uuid.test(id))throw new DomainError(400,'INVALID_PREVIEW');
    const preview=(await client.query('SELECT rows FROM master_csv_previews WHERE id=$1 AND kind=$2 AND warehouse_id=$3',[id,businessKind,warehouse])).rows[0];if(!preview)throw new DomainError(404,'PREVIEW_NOT_FOUND');
    return makeCsv(['row_number','errors',...businessColumns],(preview.rows as PreviewRow[]).filter(r=>r.errors.length).map(r=>({...r.data.source as Record<string,unknown>,row_number:r.row_number,errors:r.errors.join('|')})));
   }
   if(!kind)throw new DomainError(404,'NOT_FOUND');
   if(mode==='collection') {
    if(mutation)return {row:await insertMaster(client,identity.tenant.id,warehouse,kind,validateInput(kind,body))};
    return listMasterPage(client,identity.tenant.id,kind,warehouse,params);
   }
   if(mode==='detail')return {row:await updateMaster(client,warehouse,kind,route.id!,validateInput(kind,body,true))};
   if(mode==='preview') {
    if(typeof body.csv!=='string')throw new DomainError(400,'CSV_REQUIRED');
    return previewCsv(client,identity.tenant.id,warehouse,kind,body.csv,requestKey(body.request_key));
   }
   if(mode==='apply') {
    if(typeof body.preview_id!=='string'||!uuid.test(body.preview_id))throw new DomainError(400,'INVALID_PREVIEW');
    return applyCsv(client,identity.tenant.id,warehouse,kind,body.preview_id,body.row_numbers,requestKey(body.request_key));
   }
   if(mode==='errors') {
    const id=params.get('preview_id');if(!id||!uuid.test(id))throw new DomainError(400,'INVALID_PREVIEW');
    const preview=(await client.query('SELECT rows FROM master_csv_previews WHERE id=$1 AND kind=$2 AND warehouse_id=$3',[id,kind,warehouse])).rows[0];
    if(!preview)throw new DomainError(404,'PREVIEW_NOT_FOUND');
    return makeCsv(['row_number','errors',...csvColumns(kind)],(preview.rows as PreviewRow[]).filter(r=>r.errors.length).map(r=>({...r.data,row_number:r.row_number,errors:r.errors.join('|')})));
   }
   const captured=(await client.query('SELECT transaction_timestamp() AS time')).rows[0].time.toISOString();
   const rows=await listMasters(client,kind,warehouse,params,true);
   const metadata={record_type:'data',row_count:rows.length,tenant_id:identity.tenant.id,warehouse_id:warehouse,exported_at:rows[0]?.export_captured_at?.toISOString()??captured,filter_q:params.get('q')??'',filter_active:params.get('active')??'',quantity_unit:'EA'};
   const exportRows=rows.length?rows.map(row=>({...metadata,...row,created_at:row.created_at?.toISOString()})):[{...metadata,record_type:'metadata'}];
   return makeCsv([...Object.keys(metadata),'id',...csvColumns(kind),'created_at'],exportRows);
  });
  if(mode==='export'||mode==='errors')return new Response(result as string,{headers:{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':`attachment; filename="${route.kind}-${mode}.csv"`,'Cache-Control':'no-store'}});
  return json(result,mode==='collection'&&mutation?201:200);
 }catch(e){return apiError(e);}
}
