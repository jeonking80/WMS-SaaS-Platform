import {apiError,json} from '@/server/api';
import {requireV2Identity} from '@/server/v2/access';
import {listWorkflowLedger} from '@/server/v2/workflow';
import {withRequestLog} from '@/server/request-log';
export const runtime='nodejs';
export const dynamic='force-dynamic';
function csv(value:unknown) {if(typeof value==='number')return String(value);let text=value===null||value===undefined?'':String(value);if(/^[\s]*[=+@-]/.test(text))text="'"+text;return '"'+text.replaceAll('"','""')+'"';}
export const GET=withRequestLog('v2.workflow.ledger',async(request:Request)=>{try{
 const p=new URL(request.url).searchParams;const warehouse_id=p.get('warehouse_id')??'';const identity=await requireV2Identity(request.headers,'read',warehouse_id);
 const page=await listWorkflowLedger(identity,{warehouse_id,item_id:p.get('item_id')??undefined,location_id:p.get('location_id')??undefined,cursor:p.get('cursor')??undefined,boundary:p.has('boundary')?Number(p.get('boundary')):undefined,limit:p.has('limit')?Number(p.get('limit')):undefined,from:p.get('from')??undefined,to:p.get('to')??undefined});
 if(p.get('format')==='csv'){const columns=['id','request_id','version','created_at','actor_id','command','item_id','location_id','bucket','delta','reason','original_id'];const body=[columns.map(csv).join(','),...page.rows.map(row=>columns.map(c=>csv(row[c])).join(','))].join('\r\n');return new Response('\uFEFF'+body,{headers:{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="workflow-ledger.csv"','Cache-Control':'no-store','X-Ledger-Boundary':String(page.boundary),'X-Ledger-Has-More':String(page.has_more),'X-Ledger-Cursor':page.cursor??''}});}
 return json(page);
 }catch(e){return apiError(e);}});
