import type {PoolClient} from 'pg';
import {fail,integer,object,uuid} from './engine';
import type {WorkflowState} from './types';
const key=(x:{item_id?:unknown;location_id?:unknown;bucket?:unknown})=>`${x.item_id}:${x.location_id}:${x.bucket}`;
export async function legacyCorrectionSource(client:PoolClient,tenantId:string,warehouseId:string,original:string) {
 const document=(await client.query(`SELECT d.id,d.document_no,d.kind,d.status FROM inventory_documents d WHERE d.tenant_id=$1 AND d.warehouse_id=$2 AND (d.id=$3 OR EXISTS(SELECT 1 FROM stock_ledger l WHERE l.tenant_id=d.tenant_id AND l.document_id=d.id AND l.id=$3))`,[tenantId,warehouseId,original])).rows[0];
 if(!document)fail('CORRECTION_SOURCE_NOT_FOUND',404);if(document.status!=='POSTED')fail('CORRECTION_SOURCE_FORBIDDEN');
 const cutover=(await client.query(`SELECT c.opening,(r.response->>'version')::integer AS version FROM v2_cutovers c JOIN v2_workflow_requests r ON r.tenant_id=c.tenant_id AND r.request_id=c.request_id WHERE c.tenant_id=$1 AND c.warehouse_id=$2`,[tenantId,warehouseId])).rows[0];
 if(!cutover)fail('LEGACY_CUTOVER_REQUIRED');
 const rows=(await client.query('SELECT item_id,location_id,quantity_delta::float8 AS delta FROM stock_ledger WHERE tenant_id=$1 AND warehouse_id=$2 AND document_id=$3',[tenantId,warehouseId,document.id])).rows;
 const mapped=new Map<string,{item_id:string;location_id:string;bucket:string;quantity:number}>();
 const limits=new Map<string,number>();
 for(const row of rows){const side=row.delta>0?1:-1;const scope=row.item_id+':'+side;limits.set(scope,(limits.get(scope)??0)+Math.abs(row.delta));for(const raw of cutover.opening){const opening=object(raw);if(opening.item_id!==row.item_id||opening.source_location_id!==row.location_id)continue;const id=key(opening);const existing=mapped.get(id);const quantity=side*Math.min(Math.abs(row.delta),Number(opening.quantity));mapped.set(id,{item_id:row.item_id,location_id:String(opening.location_id),bucket:String(opening.bucket),quantity:(existing?.quantity??0)+quantity});}}
 const lines=[...mapped.values()].filter(x=>x.quantity!==0);if(!lines.length)fail('CORRECTION_OPENING_MAPPING_REQUIRED');
 return{document,lines,limits,version:Number(cutover.version),rows};
}
export async function validateLegacyCorrection(client:PoolClient,tenantId:string,warehouseId:string,state:WorkflowState,p:Record<string,unknown>,approvalId?:string) {
 const source=await legacyCorrectionSource(client,tenantId,warehouseId,uuid(p.original_id));p.original_id=source.document.id;p.original_kind='legacy';
 if(state.approvals.some(a=>a.type==='correction'&&a.target_id===source.document.id&&a.status==='pending'&&a.id!==approvalId))fail('CORRECTION_APPROVAL_PENDING');
 if(!Array.isArray(p.lines)||!p.lines.length||p.lines.length>20)fail('INVALID_INPUT',400);
 const desired=new Map<string,number>();for(const raw of p.lines){const x=object(raw);const q=integer(x.quantity,false,true);const original=source.lines.find(y=>key(y)===key(x));if(!q||!original||q*original.quantity>=0)fail('CORRECTION_SOURCE_MISMATCH');desired.set(key(x),(desired.get(key(x))??0)+q);}
 const compensated=(await client.query('SELECT item_id,location_id,bucket,sum(delta)::float8 AS quantity FROM v2_workflow_ledger WHERE tenant_id=$1 AND warehouse_id=$2 AND original_id=$3 GROUP BY item_id,location_id,bucket',[tenantId,warehouseId,source.document.id])).rows;
 for(const [k,q]of desired){const original=source.lines.find(x=>key(x)===k)!;const prior=compensated.filter(x=>key(x)===k).reduce((n,x)=>n+Number(x.quantity),0);if(Math.abs(prior+q)>Math.abs(original.quantity))fail('CORRECTION_LIMIT_EXCEEDED');}
 const used=new Map<string,number>();for(const previous of compensated){const direction=-Math.sign(Number(previous.quantity));const k=previous.item_id+':'+direction;used.set(k,(used.get(k)??0)+Math.abs(Number(previous.quantity)));}for(const[k,q]of desired){const original=source.lines.find(x=>key(x)===k)!;const scope=original.item_id+':'+Math.sign(original.quantity);used.set(scope,(used.get(scope)??0)+Math.abs(q));}
 if([...used].some(([scope,n])=>n>(source.limits.get(scope)??0)))fail('CORRECTION_LIMIT_EXCEEDED');
 if(source.document.kind==='TRANSFER'){for(const item of new Set(source.rows.map(x=>x.item_id))){let net=0;for(const[k,q]of desired)if(k.startsWith(item+':'))net+=q;if(net!==0)fail('CORRECTION_PAIRED_LINES_REQUIRED');}}
 const following=(await client.query(`SELECT 1 FROM v2_workflow_ledger l JOIN v2_workflow_requests r ON r.tenant_id=l.tenant_id AND r.request_id=l.request_id WHERE l.tenant_id=$1 AND l.warehouse_id=$2 AND l.item_id=ANY($3::uuid[]) AND (r.response->>'version')::integer>$4 AND l.original_id IS DISTINCT FROM $5 LIMIT 1`,[tenantId,warehouseId,[...new Set(source.rows.map(x=>x.item_id))],source.version,source.document.id])).rowCount;
 if(following)fail('CORRECTION_FOLLOWUP_WORK_EXISTS');
}
