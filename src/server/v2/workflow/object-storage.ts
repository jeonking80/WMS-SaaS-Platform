import type {PoolClient} from 'pg';
import type {WorkflowState} from './types';
import {ownDetachedWorkflowState,wasWorkflowStateOwned} from './owned-state';
import {observeTimingBytes,timeAsync,timeSync,timingDiagnosticsActive} from '../../timing-diagnostics';

/** All arrays remain present and ordered. No business object is omitted or archived. */
export function splitWorkflowState(state:WorkflowState){
 const metadata:Record<string,unknown>={...state};
 const rows:{kind:string;object_key:string;object_id:string|null;position:number;body:unknown}[]=[];
 for(const [kind,value] of Object.entries(state))if(Array.isArray(value)){
  metadata[kind]=[];
  value.forEach((body:unknown,position:number)=>{
   const id=body!==null&&typeof body==='object'&&!Array.isArray(body)?(body as Record<string,unknown>).id:undefined;
   const object_id=typeof id==='string'?id:null;
   // Position disambiguates even legacy duplicated IDs without losing their bodies.
   rows.push({kind,object_key:(object_id??'')+':'+position,object_id,position,body});
  });
 }
 return {metadata,rows};
}

const persistedBaselines=new WeakMap<WorkflowState,ReturnType<typeof bodyBaseline>>();
function bodyBaseline(state:WorkflowState){const rows=splitWorkflowState(state).rows;return {rows,serialized:new Map(rows.map(r=>[JSON.stringify([r.kind,r.object_key]),JSON.stringify(r.body)]))};}

/** Caller holds the warehouse header lock until the surrounding transaction ends. */
export async function readWorkflowState(client:PoolClient,tenant:string,warehouse:string,lock:'UPDATE'|'SHARE'):Promise<WorkflowState|undefined>{
 const header=await timeAsync('workflow.state_lock_read',()=>client.query<{state:WorkflowState}>('SELECT state FROM v2_workflow_state_header WHERE tenant_id=$1 AND warehouse_id=$2 FOR '+lock,[tenant,warehouse]));
 if(!header.rowCount)return undefined;
 const state=header.rows[0].state;
 const rows=await timeAsync('workflow.state_lock_read',()=>client.query<{kind:string;body:unknown}>('SELECT kind,body FROM v2_workflow_object_state WHERE tenant_id=$1 AND warehouse_id=$2 ORDER BY kind,position',[tenant,warehouse]));
 for(const row of rows.rows)(state as unknown as Record<string,unknown[]>)[row.kind].push(row.body);
 // Legacy hydration and approval separation mutate the loaded before-state.
 // Compare against its immutable persisted baseline, never those repaired bodies.
 if(lock==='UPDATE')persistedBaselines.set(state,timeSync('workflow.state_compare_baseline',()=>bodyBaseline(state)));
 return state;
}

/** Only a fresh locked read with its immutable pre-hydration baseline may be consumed. */
export function claimLoadedWorkflowState(state:WorkflowState) {
 if(!persistedBaselines.has(state))throw new Error('Owned workflow requires captured UPDATE-read baseline');
 return ownDetachedWorkflowState(state);
}

/** Write only changed bodies, keeping stock/history/request writes in the caller's transaction. */
export async function writeWorkflowState(client:PoolClient,tenant:string,warehouse:string,before:WorkflowState,after:WorkflowState){
 const captured=persistedBaselines.get(before);
 if(wasWorkflowStateOwned(before)&&!captured)throw new Error('Owned workflow lost persisted baseline');
 const previous=captured??bodyBaseline(before),next=splitWorkflowState(after);
 const key=(r:{kind:string;object_key:string})=>JSON.stringify([r.kind,r.object_key]);
 const old=previous.serialized;
 const live=new Set(next.rows.map(key));
 const changed=timeSync('workflow.persist_json',()=>next.rows.filter(r=>old.get(key(r))!==JSON.stringify(r.body)));
 const removed=previous.rows.filter(r=>!live.has(key(r))).map(r=>({kind:r.kind,object_key:r.object_key}));
 const bodyJson=timeSync('workflow.persist_json',()=>JSON.stringify(changed));
 const metadataJson=timeSync('workflow.persist_json',()=>JSON.stringify(next.metadata));
 if(timingDiagnosticsActive())observeTimingBytes('workflow.state_json',Buffer.byteLength(bodyJson)+Buffer.byteLength(metadataJson));
 if(removed.length)await timeAsync('workflow.persist_sql',()=>client.query(`DELETE FROM v2_workflow_object_state o USING jsonb_to_recordset($3::jsonb) d(kind text,object_key text) WHERE o.tenant_id=$1 AND o.warehouse_id=$2 AND o.kind=d.kind AND o.object_key=d.object_key`,[tenant,warehouse,JSON.stringify(removed)]));
 if(changed.length)await timeAsync('workflow.persist_sql',()=>client.query(`INSERT INTO v2_workflow_object_state(tenant_id,warehouse_id,kind,object_key,object_id,position,body,changed_version)
 SELECT $1,$2,kind,object_key,object_id,position,COALESCE(body,'null'::jsonb),$4 FROM jsonb_to_recordset($3::jsonb) x(kind text,object_key text,object_id text,position integer,body jsonb)
 ON CONFLICT(tenant_id,warehouse_id,kind,object_key) DO UPDATE SET object_id=EXCLUDED.object_id,position=EXCLUDED.position,body=EXCLUDED.body,changed_version=EXCLUDED.changed_version`,[tenant,warehouse,bodyJson,after.version]));
 await timeAsync('workflow.persist_sql',()=>client.query('UPDATE v2_workflow_state_header SET version=$3,state=$4::jsonb,updated_at=CURRENT_TIMESTAMP WHERE tenant_id=$1 AND warehouse_id=$2',[tenant,warehouse,after.version,metadataJson]));
}
