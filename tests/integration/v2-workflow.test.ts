import {randomUUID,randomBytes} from 'node:crypto';
import pg from 'pg';
import {beforeAll,afterAll,it,expect,vi} from 'vitest';
import {migrate} from '../../scripts/db-migrate.mjs';
import type {Identity} from '../../src/server/auth/access';
const state=vi.hoisted(()=>({pool:undefined as pg.Pool|undefined}));
vi.mock('../../src/server/db/pool',()=>({getPool:()=>state.pool}));
import {withTenant} from '../../src/server/db/tenant';
import {createDocument} from '../../src/server/documents';
import {postDocument} from '../../src/server/posting';
import {previewCutover,activateCutover} from '../../src/server/v2/operations/cutover';
import {inspectWorkflowCorrectionSource} from '../../src/server/v2/workflow/correction-source';
import {DomainError,apiError} from '../../src/server/api';
import {requireV2Access} from '../../src/server/v2/access';
import {recordRequestIdentity,recordRequestCommand,withRequestLog} from '../../src/server/request-log';
import {executeWorkflow,getWorkflowSnapshot,getWorkflowRequest,listWorkflowLedger} from '../../src/server/v2/workflow';
const url=process.env.TEST_DATABASE_URL;
if(!url||!decodeURIComponent(new URL(url).pathname).endsWith('_test'))throw Error('Dedicated _test database required');
const schema='v2_wf_'+randomUUID().replaceAll('-',''),role='app_'+randomUUID().replaceAll('-',''),password=randomBytes(24).toString('hex');
const owner=new pg.Pool({connectionString:url});const tenant=randomUUID(),user=randomUUID(),warehouse=randomUUID(),secondWarehouse=randomUUID(),receiving=randomUUID(),storage=randomUUID(),hold=randomUUID(),staging=randomUUID(),item=randomUUID(),admin=randomUUID(),reviewer=randomUUID(),other=randomUUID(),partner=randomUUID(),destination=randomUUID();
const identity:Identity={tenant:{id:tenant,name:'Workflow'},user:{id:user,name:'Worker',email:user+'@example.test'},role:'worker'};
const manager:Identity={...identity,user:{id:admin,name:'Manager',email:admin+'@example.test'},role:'admin'};
const independent:Identity={...manager,user:{id:reviewer,name:'Independent',email:reviewer+'@example.test'}};
let roleCreated=false;
beforeAll(async()=>{
 await owner.query(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD ${pg.escapeLiteral(password)}`);roleCreated=true;
 await migrate(url,{schema,migrationsSchema:schema,createSchema:true,createMigrationsSchema:true,log:()=>{}});
 await owner.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${role}"`);await owner.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA "${schema}" TO "${role}"`);
 await owner.query(`INSERT INTO "${schema}".tenants(id,name) VALUES($1,'Workflow')`,[tenant]);await owner.query(`INSERT INTO "${schema}"."user"(id,name,email) VALUES($1,'Worker',$2)`,[user,identity.user.email]);await owner.query(`INSERT INTO "${schema}".memberships(tenant_id,user_id,role) VALUES($1,$2,'worker')`,[tenant,user]);
 for(const [id,name,roleName] of [[admin,'Manager','admin'],[reviewer,'Independent','admin'],[other,'Other','worker']]){await owner.query(`INSERT INTO "${schema}"."user"(id,name,email) VALUES($1,$2,$3)`,[id,name,id+'@example.test']);await owner.query(`INSERT INTO "${schema}".memberships(tenant_id,user_id,role) VALUES($1,$2,$3)`,[tenant,id,roleName]);}
 const app=new URL(url!);app.username=role;app.password=password;state.pool=new pg.Pool({connectionString:app.toString(),options:`-c search_path=${schema}`});
 await withTenant(tenant,async c=>{for(const w of [warehouse,secondWarehouse]){await c.query("INSERT INTO warehouses(id,tenant_id,code,name) VALUES($1::uuid,$2,$1::text,'Warehouse')",[w,tenant]);for(const actor of [user,admin,reviewer,other])await c.query('INSERT INTO v2_warehouse_grants(tenant_id,user_id,warehouse_id) VALUES($1,$2,$3)',[tenant,actor,w]);}for(const [id,kind]of [[receiving,'RECEIVING'],[storage,'STORAGE'],[hold,'HOLD'],[staging,'STAGING']])await c.query('INSERT INTO locations(id,tenant_id,warehouse_id,code,name,kind) VALUES($1::uuid,$2,$3,$1::text,$4::text,$4::text)',[id,tenant,warehouse,kind]);await c.query("INSERT INTO business_partners(id,tenant_id,code,name,supplier,customer) VALUES($1,$2,'PARTNER','Test partner',true,true)",[partner,tenant]);await c.query("INSERT INTO delivery_destinations(id,tenant_id,partner_id,recipient_name,name,address_line1) VALUES($1,$2,$3,'Recipient','Main','Test address')",[destination,tenant,partner]);await c.query("INSERT INTO items(id,tenant_id,code,name) VALUES($1,$2,'SKU','SKU')",[item,tenant]);await c.query("INSERT INTO master_barcodes(tenant_id,barcode,item_id,unit,quantity) VALUES($1,'BOX12',$2,'BOX',12),($1,'BOX10',$2,'BOX',10)",[tenant,item]);});
},30000);
afterAll(async()=>{await state.pool?.end();try{await owner.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);}finally{try{if(roleCreated)await owner.query(`DROP ROLE "${role}"`);}finally{await owner.end();}}});
const physical=['receipt.receive','receipt.inspect','receipt.putaway','order.pick','order.return_picked','order.damage','package.create','return.receive','return.inspect','return.putaway','stock.move','stock.hold','stock.inspect','stock.putaway','hold.release'];
const run=(command:string,payload:Record<string,unknown>,request_id=randomUUID(),w=warehouse)=>{const p=structuredClone(payload);if(command==='receipt.create'){p.supplier_id??=partner;p.expected_at??='2026-10-20T10:00:00.000Z';}if(command==='order.create'){p.delivery??={partner_id:partner,delivery_destination_id:destination};p.due_at??='2026-10-21T10:00:00.000Z';}if(physical.includes(command)){p.manual_entry_reason??='실제 시험명세의 실물과 위치 수동 대조';if(Array.isArray(p.lines))p.lines=p.lines.map(line=>({input_mode:'search',...(line as object)}));else p.input_mode??='search';}return executeWorkflow(identity,{warehouse_id:w,command,payload:p,request_id});};
it('persists immutable BOX conversion evidence and rejects client quantity tampering',async()=>{
 const r=await run('receipt.create',{lines:[{item_id:item,quantity:100}]});const receipt=r.snapshot.receipts.find(x=>x.id===r.result.id)!;const key=randomUUID();const payload={receipt_id:receipt.id,receiving_id:randomUUID(),lines:[{line_id:receipt.lines[0].id,location_id:receiving,quantity:24,scanned_location_id:receiving,input_mode:'barcode',scans:[{barcode:'BOX12',count:2}]}]};
 await run('receipt.receive',payload,key);await withTenant(tenant,async c=>{const p=await c.query('SELECT evidence FROM v2_workflow_performances WHERE request_id=$1',[key]);expect(p.rows[0].evidence.lines[0].conversion).toEqual([{barcode:'BOX12',input_unit:'BOX',conversion_quantity:12,input_quantity:2,base_quantity:24,item_id:item}]);const stored=await c.query('SELECT state FROM v2_workflow_state WHERE warehouse_id=$1',[warehouse]);expect(stored.rows[0].state.ledger).toEqual([]);const saved=await c.query('SELECT response FROM v2_workflow_requests WHERE request_id=$1',[key]);expect(saved.rows[0].response).not.toHaveProperty('snapshot');await expect(c.query('UPDATE v2_workflow_performances SET evidence=\'{}\' WHERE request_id=$1',[key])).rejects.toMatchObject({code:'23514'});});
 const wrong={...payload,receiving_id:randomUUID(),lines:[{...payload.lines[0],quantity:25}]};await expect(run('receipt.receive',wrong)).rejects.toMatchObject({code:'SCAN_QUANTITY_MISMATCH'});
 const replay=await getWorkflowRequest(identity,warehouse,key);expect(replay.result).toEqual({id:receipt.id,lot_ids:expect.any(Array)});expect(replay.replayed).toBe(true);
});
it('preserves tenant-wide external object uniqueness across warehouses',async()=>{const external_id='EXT-'+randomUUID();await run('receipt.create',{external_id,lines:[{item_id:item,quantity:1}]});await expect(run('receipt.create',{external_id,lines:[{item_id:item,quantity:1}]},randomUUID(),secondWarehouse)).rejects.toMatchObject({code:'23505'});});
it('reconciles against the actual persisted ledger independently of aggregate baseline',async()=>{const before=await getWorkflowSnapshot(identity,warehouse);expect(before.reconciliation.ok).toBe(true);await owner.query(`UPDATE "${schema}".v2_workflow_stock SET q=q+1 WHERE warehouse_id=$1 AND item_id=$2 AND location_id=$3`,[warehouse,item,receiving]);const corrupted=await getWorkflowSnapshot(identity,warehouse);expect(corrupted.reconciliation).toMatchObject({ok:false,issues:expect.arrayContaining(['PERSISTED_LEDGER_MISMATCH'])});await owner.query(`UPDATE "${schema}".v2_workflow_stock SET q=q-1 WHERE warehouse_id=$1 AND item_id=$2 AND location_id=$3`,[warehouse,item,receiving]);});

it('paginates a fixed ledger boundary without including work committed between pages',async()=>{
 const created=await run('receipt.create',{lines:[{item_id:item,quantity:3}]});const receipt=created.snapshot.receipts.find(x=>x.id===created.result.id)!;
 await run('receipt.receive',{receipt_id:receipt.id,receiving_id:randomUUID(),reason:'One additional physical piece held',lines:[{line_id:receipt.lines[0].id,quantity:4,location_id:receiving}]});
 const snap=await getWorkflowSnapshot(identity,warehouse);let page=await listWorkflowLedger(identity,{warehouse_id:warehouse,boundary:snap.version,limit:1});expect(page.has_more).toBe(true);const firstCursor=page.cursor!;const rows=[...page.rows];
 const later=await run('receipt.create',{lines:[{item_id:item,quantity:1}]});const laterReceipt=later.snapshot.receipts.find(x=>x.id===later.result.id)!;await run('receipt.receive',{receipt_id:laterReceipt.id,receiving_id:randomUUID(),lines:[{line_id:laterReceipt.lines[0].id,quantity:1,location_id:receiving}]});
 while(page.has_more){page=await listWorkflowLedger(identity,{warehouse_id:warehouse,cursor:page.cursor!,limit:1});rows.push(...page.rows);}expect(new Set(rows.map(x=>x.id)).size).toBe(rows.length);expect(rows.every(x=>x.version<=snap.version)).toBe(true);
 const count=await withTenant(tenant,c=>c.query(`SELECT count(*)::int n FROM v2_workflow_ledger l JOIN v2_workflow_requests r ON r.tenant_id=l.tenant_id AND r.request_id=l.request_id WHERE l.warehouse_id=$1 AND (r.response->>'version')::integer<=$2`,[warehouse,snap.version]));expect(rows.length).toBe(count.rows[0].n);
 const filtered=await listWorkflowLedger(identity,{warehouse_id:warehouse,item_id:item,location_id:receiving,limit:500});expect(filtered.rows.length).toBeGreaterThan(0);expect(filtered.rows.every(x=>x.item_id===item&&x.location_id===receiving)).toBe(true);
 await expect(listWorkflowLedger(identity,{warehouse_id:warehouse,location_id:receiving,cursor:firstCursor})).rejects.toMatchObject({code:'INVALID_CURSOR'});
 await expect(listWorkflowLedger(identity,{warehouse_id:warehouse,item_id:item,cursor:firstCursor})).rejects.toMatchObject({code:'INVALID_CURSOR'});
});
it('requires human scan evidence and prevents task takeover, indirect shipping and partial-receipt approval bypass',async()=>{
 const current=await getWorkflowSnapshot(identity,warehouse);const receipt=current.receipts[0];
 await expect(executeWorkflow(identity,{warehouse_id:warehouse,request_id:randomUUID(),command:'receipt.receive',payload:{receipt_id:receipt.id,lines:[{line_id:receipt.lines[0].id,quantity:1,location_id:receiving}]}})).rejects.toMatchObject({code:'INVALID_SCAN_MODE'});
 await expect(run('receipt.cancel',{receipt_id:receipt.id,reason:'Bypass'})).rejects.toMatchObject({code:'CLOSE_APPROVAL_REQUIRED'});
 const lot=receipt.lots[0];await run('receipt.inspect',{receipt_id:receipt.id,lines:[{lot_id:lot.id,quantity:24,outcome:'normal'}]});await run('receipt.putaway',{receipt_id:receipt.id,lines:[{lot_id:lot.id,quantity:24,location_id:storage}]});
 const created=await run('order.create',{lines:[{item_id:item,quantity:2}]});const orderId=created.result.id;const reserved=await run('order.reserve',{order_id:orderId,partial:false});const order=reserved.snapshot.orders.find(x=>x.id===orderId)!;const picked=await run('order.pick',{order_id:orderId,lines:[{reservation_id:order.reservations[0].id,quantity:2,location_id:staging}]});const pick=picked.snapshot.orders.find(x=>x.id===orderId)!.picks[0];const pack=await run('package.create',{order_id:orderId,lines:[{pick_id:pick.id,quantity:2}]});
 await executeWorkflow(manager,{warehouse_id:warehouse,request_id:randomUUID(),command:'task.assign',payload:{object_type:'order',object_id:orderId,assignee_id:other,reason:'Assigned other worker'}});
 await expect(run('task.assign',{object_type:'order',object_id:orderId,assignee_id:user,reason:'Take over'})).rejects.toMatchObject({code:'ASSIGNMENT_FORBIDDEN'});
 await expect(run('package.unpack',{package_id:pack.result.id,reason:'Indirect bypass'})).rejects.toMatchObject({code:'TASK_ASSIGNEE_MISMATCH'});
 await expect(run('shipment.create',{package_ids:[pack.result.id],handover_by:'Driver',carrier:'Test'})).rejects.toMatchObject({code:'TASK_ASSIGNEE_MISMATCH'});
});

it('persists rollback rejections outside the transaction, scopes metrics, and tolerates telemetry storage failure',async()=>{
 const output=vi.spyOn(console,'info').mockImplementation(()=>{});
 try{
 const before=await withTenant(tenant,c=>c.query('SELECT version FROM v2_workflow_state WHERE warehouse_id=$1',[warehouse]));
 const handler=withRequestLog('v2.workflow.command',async()=>{recordRequestIdentity(identity);await requireV2Access(identity,warehouse,'write');recordRequestCommand('order.pick');try{await withTenant(tenant,async c=>{await c.query('UPDATE v2_workflow_state SET version=version+1 WHERE warehouse_id=$1',[warehouse]);throw new DomainError(409,'WRONG_ITEM_SCAN');});return Response.json({});}catch(error){return apiError(error);}});
 const response=await handler();expect(response.status).toBe(409);const requestId=response.headers.get('x-request-id');
 const metrics=await withTenant(tenant,c=>c.query('SELECT * FROM api_request_metrics WHERE request_id=$1',[requestId]));expect(metrics.rows[0]).toMatchObject({tenant_id:tenant,warehouse_id:warehouse,actor_id:user,command:'order.pick',status:409,error_code:'WRONG_ITEM_SCAN'});expect(metrics.rows[0].duration_ms).toBeGreaterThanOrEqual(0);
 expect((await withTenant(tenant,c=>c.query('SELECT version FROM v2_workflow_state WHERE warehouse_id=$1',[warehouse]))).rows).toEqual(before.rows);
 const denied=await withRequestLog('v2.workflow.command',async()=>{recordRequestIdentity(identity);try{await requireV2Access(identity,randomUUID(),'write');return Response.json({});}catch(error){return apiError(error);}})();
 expect(denied.status).toBe(403);expect((await withTenant(tenant,c=>c.query('SELECT 1 FROM api_request_metrics WHERE request_id=$1',[denied.headers.get('x-request-id')]))).rowCount).toBe(0);
 const fn='metric_failure_'+randomUUID().replaceAll('-','');await owner.query(`CREATE FUNCTION "${schema}"."${fn}"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected metric failure'; END $$`);await owner.query(`CREATE TRIGGER "${fn}" BEFORE INSERT ON "${schema}".api_request_metrics FOR EACH ROW EXECUTE FUNCTION "${schema}"."${fn}"()`);
 try{expect((await handler()).status).toBe(409);}finally{await owner.query(`DROP TRIGGER "${fn}" ON "${schema}".api_request_metrics`);await owner.query(`DROP FUNCTION "${schema}"."${fn}"()`);}
 }finally{output.mockRestore();}
});

it('requires a real source, preserves following work and caps cumulative source compensation',async()=>{
 const created=await run('receipt.create',{lines:[{item_id:item,quantity:10}]});const receipt=created.snapshot.receipts.find(x=>x.id===created.result.id)!;
 const received=await run('receipt.receive',{receipt_id:receipt.id,receiving_id:randomUUID(),lines:[{line_id:receipt.lines[0].id,quantity:10,location_id:receiving}]});const source=received.snapshot.ledger.filter(l=>l.command==='receipt.receive'&&l.delta===10).at(-1)!;
 const payload={original_id:source.id,lines:[{item_id:item,location_id:receiving,bucket:'Q',quantity:-2}],reason:'Recorded two excess pieces in error'};
 await expect(run('correction.request',{...payload,original_id:undefined})).rejects.toMatchObject({code:'INVALID_INPUT'});await expect(run('correction.request',{...payload,original_id:randomUUID()})).rejects.toMatchObject({code:'CORRECTION_SOURCE_NOT_FOUND'});
 await expect(run('correction.request',{...payload,lines:[{item_id:item,location_id:storage,bucket:'Q',quantity:-2}]})).rejects.toMatchObject({code:'CORRECTION_SOURCE_MISMATCH'});
 const request=await run('correction.request',payload);await executeWorkflow(manager,{warehouse_id:warehouse,request_id:randomUUID(),command:'approval.decide',payload:{approval_id:request.result.id,approve:true,reason:'Independent review'}});
 await expect(run('correction.request',{...payload,lines:[{item_id:item,location_id:receiving,bucket:'Q',quantity:-9}]})).rejects.toMatchObject({code:'CORRECTION_LIMIT_EXCEEDED'});
 await run('receipt.inspect',{receipt_id:receipt.id,lines:[{lot_id:receipt.lots[0]?.id??received.snapshot.receipts.find(x=>x.id===receipt.id)!.lots[0].id,quantity:1,outcome:'normal'}]});
 const current=await getWorkflowSnapshot(identity,warehouse);const lot=current.receipts.find(x=>x.id===receipt.id)!.lots[0];await run('receipt.putaway',{receipt_id:receipt.id,lines:[{lot_id:lot.id,quantity:1,location_id:storage}]});
 await expect(run('correction.request',payload)).rejects.toMatchObject({code:'CORRECTION_FOLLOWUP_WORK_EXISTS'});
});

it('links a legacy document through confirmed opening quality mapping and preserves its original ledger',async()=>{
 const w=randomUUID(),s=randomUUID(),b=randomUUID();await withTenant(tenant,async c=>{await c.query("INSERT INTO warehouses(id,tenant_id,code,name) VALUES($1::uuid,$2,$1::text,'Legacy correction')",[w,tenant]);for(const actor of[user,admin,reviewer])await c.query('INSERT INTO v2_warehouse_grants(tenant_id,user_id,warehouse_id) VALUES($1,$2,$3)',[tenant,actor,w]);for(const[id,kind]of[[s,'STORAGE'],[b,'HOLD']])await c.query('INSERT INTO locations(id,tenant_id,warehouse_id,code,name,kind) VALUES($1::uuid,$2,$3,$1::text,$4::text,$4::text)',[id,tenant,w,kind]);});
 const doc=await createDocument(tenant,{kind:'INBOUND',warehouse_id:w,source_location_id:null,destination_location_id:s,note:'Preserved legacy source',lines:[{item_id:item,quantity:10}]});await postDocument(manager,doc.id as string,doc.version as number,randomUUID());
 const before=await withTenant(tenant,c=>c.query('SELECT id,document_id,item_id,location_id,quantity_delta FROM stock_ledger WHERE warehouse_id=$1',[w]));
 await activateCutover(manager,{warehouse_id:w,request_id:randomUUID(),confirmed:true,snapshot_hash:(await previewCutover(manager,w)).snapshot_hash,rows:[{item_id:item,source_location_id:s,location_id:s,bucket:'S',quantity:5},{item_id:item,source_location_id:s,location_id:b,bucket:'B',quantity:5}]});
 const source=await inspectWorkflowCorrectionSource(identity,w,doc.id as string);expect(source).toMatchObject({source:{id:doc.id,kind:'legacy'},blocked_reason:null});
 const payload={original_id:doc.id,lines:[{item_id:item,location_id:s,bucket:'S',quantity:-2}],reason:'Original recorded quantity was two high'};const request=await run('correction.request',payload,randomUUID(),w);
 await expect(executeWorkflow(manager,{warehouse_id:w,request_id:randomUUID(),command:'approval.decide',payload:{approval_id:request.result.id,approve:true,reason:'Original actor attempts review'}})).rejects.toMatchObject({code:'SELF_APPROVAL_FORBIDDEN'});
 await executeWorkflow(independent,{warehouse_id:w,request_id:randomUUID(),command:'approval.decide',payload:{approval_id:request.result.id,approve:true,reason:'Independent legacy evidence checked'}});
 const after=await getWorkflowSnapshot(identity,w);expect(after.stock.reduce((n,x)=>n+x.H,0)).toBe(8);expect(after.ledger.some(l=>l.original_id===doc.id&&l.delta===-2)).toBe(true);
 expect((await withTenant(tenant,c=>c.query('SELECT id,document_id,item_id,location_id,quantity_delta FROM stock_ledger WHERE warehouse_id=$1',[w]))).rows).toEqual(before.rows);
 const order=await run('order.create',{lines:[{item_id:item,quantity:1}]},randomUUID(),w);await run('order.reserve',{order_id:order.result.id,partial:false},randomUUID(),w);
 await expect(run('correction.request',payload,randomUUID(),w)).rejects.toMatchObject({code:'CORRECTION_FOLLOWUP_WORK_EXISTS'});
});

it('finds and selects legacy correction originals beyond fifty posted documents using scoped search and keyset pages',async()=>{
 const w=randomUUID(),s=randomUUID();
 await withTenant(tenant,async c=>{await c.query("INSERT INTO warehouses(id,tenant_id,code,name) VALUES($1::uuid,$2,$1::text,'Legacy paging')",[w,tenant]);for(const actor of[user,admin,reviewer])await c.query('INSERT INTO v2_warehouse_grants VALUES($1,$2,$3)',[tenant,actor,w]);await c.query("INSERT INTO locations(id,tenant_id,warehouse_id,code,name,kind) VALUES($1::uuid,$2,$3,$1::text,'Legacy paging storage','STORAGE')",[s,tenant,w]);});
 const documents=[];
 for(let index=0;index<55;index++){const document=await createDocument(tenant,{kind:'INBOUND',warehouse_id:w,source_location_id:null,destination_location_id:s,note:index===0?'Exact historical needle':'Recent legacy original',lines:[{item_id:item,quantity:1}]});await postDocument(manager,document.id as string,document.version as number,randomUUID());documents.push(document);}
 const earliest=documents[0];
 await activateCutover(manager,{warehouse_id:w,request_id:randomUUID(),confirmed:true,snapshot_hash:(await previewCutover(manager,w)).snapshot_hash,rows:[{item_id:item,source_location_id:s,location_id:s,bucket:'S',quantity:55}]});
 const first=await inspectWorkflowCorrectionSource(identity,w);if(!('sources' in first))throw Error('Missing source page');
 expect(first.sources).toHaveLength(50);expect(first.has_more).toBe(true);expect(first.sources.some(row=>row.id===earliest.id)).toBe(false);
 const second=await inspectWorkflowCorrectionSource(identity,w,undefined,{cursor:first.next_cursor!});if(!('sources' in second))throw Error('Missing second source page');
 expect(second.sources).toHaveLength(5);expect(second.has_more).toBe(false);expect(second.next_cursor).toBeNull();expect(new Set([...first.sources,...second.sources].map(row=>row.id)).size).toBe(55);
 const selected=second.sources.find(row=>row.id===earliest.id)!;expect(selected.document_number).toBe(earliest.document_number);
 for(const q of [String(earliest.document_number),'historical needle']){const found=await inspectWorkflowCorrectionSource(identity,w,undefined,{q,item_id:item});if(!('sources' in found))throw Error('Missing searched source page');expect(found.sources.map(row=>row.id)).toEqual([earliest.id]);}
 const literalWildcard=await inspectWorkflowCorrectionSource(identity,w,undefined,{q:'%'});expect(literalWildcard).toMatchObject({sources:[],has_more:false});
 await expect(inspectWorkflowCorrectionSource(identity,w,undefined,{q:'changed',cursor:first.next_cursor!})).rejects.toMatchObject({code:'INVALID_CURSOR'});
 await expect(inspectWorkflowCorrectionSource(identity,w,undefined,{item_id:item,cursor:first.next_cursor!})).rejects.toMatchObject({code:'INVALID_CURSOR'});
 await expect(inspectWorkflowCorrectionSource(identity,w,undefined,{cursor:'malformed'})).rejects.toMatchObject({code:'INVALID_CURSOR'});
 const original=await inspectWorkflowCorrectionSource(identity,w,selected.id);expect(original).toMatchObject({source:{id:earliest.id,kind:'legacy'},lines:[{item_id:item,location_id:s,bucket:'S',quantity:-1}],blocked_reason:null});
 const request=await run('correction.request',{original_id:selected.id,lines:[{item_id:item,location_id:s,bucket:'S',quantity:-1}],reason:'Selected oldest original through the second page'},randomUUID(),w);
 await executeWorkflow(independent,{warehouse_id:w,request_id:randomUUID(),command:'approval.decide',payload:{approval_id:request.result.id,approve:true,reason:'Independently checked historical original'}});
 expect((await getWorkflowSnapshot(identity,w)).stock.reduce((sum,row)=>sum+row.H,0)).toBe(54);
 expect(await inspectWorkflowCorrectionSource(identity,w,selected.id)).toMatchObject({blocked_reason:'CORRECTION_LIMIT_EXCEEDED'});
 const foreignTenant=randomUUID(),foreignActor=randomUUID(),foreignWarehouse=randomUUID();
 await owner.query(`INSERT INTO "${schema}".tenants(id,name) VALUES($1,'Foreign paging company')`,[foreignTenant]);await owner.query(`INSERT INTO "${schema}"."user"(id,name,email) VALUES($1,'Foreign paging user',$2)`,[foreignActor,foreignActor+'@example.invalid']);await owner.query(`INSERT INTO "${schema}".memberships(user_id,tenant_id,role) VALUES($1,$2,'admin')`,[foreignActor,foreignTenant]);await owner.query(`INSERT INTO "${schema}".warehouses(id,tenant_id,code,name) VALUES($1,$2,'FOREIGN','Foreign paging warehouse')`,[foreignWarehouse,foreignTenant]);await owner.query(`INSERT INTO "${schema}".v2_warehouse_grants VALUES($1,$2,$3)`,[foreignTenant,foreignActor,foreignWarehouse]);
 const foreignIdentity:Identity={tenant:{id:foreignTenant,name:'Foreign'},user:{id:foreignActor,name:'Foreign',email:foreignActor+'@example.invalid'},role:'admin'};
 expect(await inspectWorkflowCorrectionSource(foreignIdentity,foreignWarehouse,undefined,{q:String(earliest.document_number)})).toMatchObject({sources:[],has_more:false});
 await expect(inspectWorkflowCorrectionSource(foreignIdentity,w)).rejects.toMatchObject({code:'WAREHOUSE_FORBIDDEN'});
 await expect(inspectWorkflowCorrectionSource(foreignIdentity,foreignWarehouse,selected.id)).rejects.toMatchObject({code:'CORRECTION_SOURCE_NOT_FOUND'});
 await expect(inspectWorkflowCorrectionSource(foreignIdentity,foreignWarehouse,undefined,{cursor:first.next_cursor!})).rejects.toMatchObject({code:'INVALID_CURSOR'});
});

it('supports machine-to-human-to-machine ownership only for active scoped test automation keys',async()=>{
 const previousEnvironment=process.env.WMS_ENVIRONMENT;process.env.WMS_ENVIRONMENT='test';const key=randomUUID();
 try{
 await owner.query(`UPDATE "${schema}".tenants SET is_test=true WHERE id=$1`,[tenant]);
 await withTenant(tenant,async c=>{await c.query("INSERT INTO v2_machine_keys(id,tenant_id,name,source_system,environment,kind,role,scopes,token_hash,expires_at,created_by) VALUES($1,$2,'Test worker','handover','test','automation','worker',ARRAY['read','write'],$3,now()+interval '1 hour',$4)",[key,tenant,randomBytes(32).toString('hex'),admin]);await c.query('INSERT INTO v2_machine_warehouses(tenant_id,key_id,warehouse_id) VALUES($1,$2,$3)',[tenant,key,warehouse]);});
 const created=await run('order.create',{lines:[{item_id:item,quantity:1}]});const objectId=created.result.id;
 const assign=(assignee:string)=>executeWorkflow(manager,{warehouse_id:warehouse,request_id:randomUUID(),command:'task.assign',payload:{object_type:'order',object_id:objectId,assignee_id:assignee,reason:'Explicit paused handover',unconfirmed_request_ids:[]}});
 await assign('machine:'+key);
 const machine={...identity,user:{id:'machine:'+key,name:'Test worker',email:''},tenant:{...identity.tenant,isTest:true},keyId:key,kind:'automation' as const};
 await executeWorkflow(machine,{warehouse_id:warehouse,request_id:randomUUID(),command:'task.assign',payload:{object_type:'order',object_id:objectId,assignee_id:user,reason:'Automation paused and requests reconciled',unconfirmed_request_ids:[]}});
 await run('task.assign',{object_type:'order',object_id:objectId,assignee_id:'machine:'+key,reason:'Human explicitly releases to automation',unconfirmed_request_ids:[]});
 expect((await getWorkflowSnapshot(identity,warehouse)).tasks.at(-1)?.assignee_id).toBe('machine:'+key);
 await expect(executeWorkflow(machine,{warehouse_id:warehouse,request_id:randomUUID(),command:'task.assign',payload:{object_type:'order',object_id:objectId,assignee_id:user,reason:'Unresolved response',unconfirmed_request_ids:[randomUUID()]}})).rejects.toMatchObject({code:'UNCONFIRMED_RESULTS'});
 await owner.query(`UPDATE "${schema}".v2_machine_keys SET revoked_at=now() WHERE id=$1`,[key]);await expect(assign('machine:'+key)).rejects.toMatchObject({code:'ASSIGNEE_UNAVAILABLE'});
 await owner.query(`UPDATE "${schema}".v2_machine_keys SET revoked_at=NULL WHERE id=$1`,[key]);await owner.query(`UPDATE "${schema}".tenants SET is_test=false WHERE id=$1`,[tenant]);await expect(assign('machine:'+key)).rejects.toMatchObject({code:'ASSIGNEE_UNAVAILABLE'});
 await owner.query(`UPDATE "${schema}".tenants SET is_test=true WHERE id=$1`,[tenant]);process.env.WMS_ENVIRONMENT='production';await expect(assign('machine:'+key)).rejects.toMatchObject({code:'AUTOMATION_FORBIDDEN'});
 }finally{if(previousEnvironment===undefined)delete process.env.WMS_ENVIRONMENT;else process.env.WMS_ENVIRONMENT=previousEnvironment;await owner.query(`UPDATE "${schema}".tenants SET is_test=false WHERE id=$1`,[tenant]);}
});

it('separates requesters, original receivers and every counter from independent approval',async()=>{
 const as=(actor:Identity,command:string,payload:Record<string,unknown>)=>executeWorkflow(actor,{warehouse_id:warehouse,command,payload,request_id:randomUUID()});
 const decide=(actor:Identity,id:unknown)=>as(actor,'approval.decide',{approval_id:id,approve:true,reason:'Independent evidence review'});
 const otherActor:Identity={...manager,user:{id:other,name:'Other counter',email:other+'@example.test'}};
 await owner.query(`UPDATE "${schema}".memberships SET role='supervisor' WHERE tenant_id=$1 AND user_id=ANY($2::text[])`,[tenant,[user,other]]);
 try{
 const created=await run('receipt.create',{lines:[{item_id:item,quantity:1}]});const receipt=created.snapshot.receipts.find(x=>x.id===created.result.id)!;
 const received=await run('receipt.receive',{receipt_id:receipt.id,receiving_id:randomUUID(),reason:'Actual two pieces received',lines:[{line_id:receipt.lines[0].id,quantity:2,location_id:receiving}]});const lot=received.snapshot.receipts.find(x=>x.id===receipt.id)!.lots.find(x=>x.overage)!;
 const request=await as(manager,'overage.request',{lot_id:lot.id,quantity:1,reason:'Accept documented excess'});const approval=request.snapshot.approvals.find(x=>x.id===request.result.id)!;
 expect(approval.requester_id).toBe(admin);expect(approval.origin_actor_ids).toContain(user);
 await expect(decide(manager,approval.id)).rejects.toMatchObject({code:'SELF_APPROVAL_FORBIDDEN'});await expect(decide(identity,approval.id)).rejects.toMatchObject({code:'SELF_APPROVAL_FORBIDDEN'});await decide(independent,approval.id);
 const loc=randomUUID();await withTenant(tenant,c=>c.query("INSERT INTO locations(id,tenant_id,warehouse_id,code,name,kind) VALUES($1::uuid,$2,$3,$1::text,'Isolated count','STORAGE')",[loc,tenant,warehouse]));
 const c=(await run('count.start',{location_id:loc})).result.id;
 await as(identity,'count.record',{count_id:c,lines:[{item_id:item,bucket:'S',quantity:0}],recount:true});await as(otherActor,'count.record',{count_id:c,lines:[{item_id:item,bucket:'S',quantity:0}],recount:true});
 const submitted=await as(manager,'count.submit',{count_id:c,reason:'Two counters reviewed empty location'});const a=submitted.snapshot.approvals.find(x=>x.id===submitted.result.id)!;
 expect(a.requester_id).toBe(admin);expect(a.origin_actor_ids).toEqual(expect.arrayContaining([user,other]));
 // Old aggregates kept only the last counter; immutable performances must restore every counter.
 await owner.query(`UPDATE "${schema}".v2_workflow_state SET state=jsonb_set(jsonb_set(state,'{approvals}',(SELECT jsonb_agg(CASE WHEN a->>'id'=$2 THEN a-'origin_actor_ids'-'request_id' ELSE a END) FROM jsonb_array_elements(state->'approvals') a)),'{counts}',(SELECT jsonb_agg(CASE WHEN c->>'id'=$3 THEN c-'counter_ids' ELSE c END) FROM jsonb_array_elements(state->'counts') c)) WHERE warehouse_id=$1`,[warehouse,a.id,c]);
 for(const actor of[identity,otherActor,manager])await expect(decide(actor,a.id)).rejects.toMatchObject({code:'SELF_APPROVAL_FORBIDDEN'});
 await decide(independent,a.id);
 }finally{await owner.query(`UPDATE "${schema}".memberships SET role='worker' WHERE tenant_id=$1 AND user_id=ANY($2::text[])`,[tenant,[user,other]]);}
});

it('preserves packed address snapshots, optional gram weight and explicit delivery correction without stock effects',async()=>{
 const created=await run('order.create',{lines:[{item_id:item,quantity:3}]});const id=created.result.id;
 const reserved=await run('order.reserve',{order_id:id,partial:false});const order=reserved.snapshot.orders.find(x=>x.id===id)!;
 const picked=await run('order.pick',{order_id:id,lines:[{reservation_id:order.reservations[0].id,quantity:3,location_id:staging}]});const pick=picked.snapshot.orders.find(x=>x.id===id)!.picks[0];
 const payload={order_id:id,lines:[{pick_id:pick.id,quantity:1}]};
 await expect(run('order.update',{order_id:id,delivery:{}})).rejects.toMatchObject({code:'INVALID_INPUT'});await expect(run('package.create',{...payload,delivery:{}})).rejects.toMatchObject({code:'INVALID_INPUT'});
 for(const weight_grams of[0,1.5])await expect(run('package.create',{...payload,weight_grams})).rejects.toMatchObject({code:'INVALID_QUANTITY'});
 const packed=await run('package.create',{...payload,weight_grams:250});const pack=packed.snapshot.packages.find(x=>x.id===packed.result.id)!;expect(pack.weight_grams).toBe(250);
 const destination2=randomUUID();await withTenant(tenant,c=>c.query("INSERT INTO delivery_destinations(id,tenant_id,partner_id,recipient_name,name,address_line1) VALUES($1,$2,$3,'New recipient','Second','Changed address')",[destination2,tenant,partner]));
 const updated=await run('order.update',{order_id:id,delivery:{partner_id:partner,delivery_destination_id:destination2}});expect(updated.snapshot.packages.find(x=>x.id===pack.id)!.delivery).toEqual(pack.delivery);
 const next=await run('package.create',{...payload,lines:[{pick_id:pick.id,quantity:1}]});expect(next.snapshot.packages.find(x=>x.id===next.result.id)!.delivery).not.toEqual(pack.delivery);
 const shipped=await run('shipment.create',{package_ids:[pack.id],handover_by:'Driver',carrier:'Test'});const shipment=shipped.result.id;const before=await getWorkflowSnapshot(identity,warehouse);const ledger=await withTenant(tenant,c=>c.query('SELECT count(*)::int n FROM v2_workflow_ledger WHERE warehouse_id=$1',[warehouse]));
 await run('shipment.delivery',{shipment_id:shipment,revision:1,status:'delivered'});
 await expect(run('shipment.delivery',{shipment_id:shipment,revision:2,status:'lost'})).rejects.toMatchObject({code:'TERMINAL_DELIVERY'});
 const correction={shipment_id:shipment,previous_revision:1,revision:2,status:'lost',reason:'Carrier confirmed prior delivery record incorrect'};
 await expect(run('shipment.delivery.correct',correction)).rejects.toMatchObject({status:403});
 const correct=(payload:Record<string,unknown>,request_id=randomUUID())=>executeWorkflow(manager,{warehouse_id:warehouse,request_id,command:'shipment.delivery.correct',payload});
 await expect(correct({...correction,previous_revision:0})).rejects.toMatchObject({code:'VERSION_CONFLICT'});await expect(correct({...correction,reason:' '})).rejects.toMatchObject({code:'INVALID_INPUT'});
 const requestId=randomUUID();await correct(correction,requestId);const replay=await correct(correction,requestId);expect(replay.replayed).toBe(true);
 const after=await getWorkflowSnapshot(identity,warehouse);expect(after.stock).toEqual(before.stock);expect((await withTenant(tenant,c=>c.query('SELECT count(*)::int n FROM v2_workflow_ledger WHERE warehouse_id=$1',[warehouse]))).rows).toEqual(ledger.rows);
 expect(after.shipments.find(x=>x.id===shipment)!.events).toHaveLength(2);expect(after.shipments.find(x=>x.id===shipment)!.events[1]).toMatchObject({operation:'correction',previous_revision:1,revision:2,previous_status:'delivered',status:'lost',actor_id:admin,request_id:requestId});
});

it('tracks damaged and cancelled picked holds through release, inspection and putaway',async()=>{
 const asManager=(command:string,payload:Record<string,unknown>)=>executeWorkflow(manager,{warehouse_id:warehouse,request_id:randomUUID(),command,payload:{...payload,manual_entry_reason:'Physical quantities and source location verified',...(Array.isArray(payload.lines)?{lines:payload.lines.map(x=>({input_mode:'search',...(x as object)}))}:{input_mode:'search'})}});
 for(const damaged of[true,false]){
 const created=await run('order.create',{lines:[{item_id:item,quantity:1}]});const id=created.result.id;const reserved=await run('order.reserve',{order_id:id,partial:false});const o=reserved.snapshot.orders.find(x=>x.id===id)!;const picked=await run('order.pick',{order_id:id,lines:[{reservation_id:o.reservations[0].id,quantity:1,location_id:staging}]});const pick=picked.snapshot.orders.find(x=>x.id===id)!.picks[0];
 if(!damaged)await run('order.cancel',{order_id:id,lines:[{line_id:o.lines[0].id,quantity:1}],reason:'Customer cancellation'});
 const held=await asManager(damaged?'order.damage':'order.return_picked',{order_id:id,reason:damaged?'Damaged physical item':'Returned item requires inspection',lines:[{pick_id:pick.id,quantity:1,location_id:hold,outcome:'hold'}]});const lotId=(held.result.lot_ids as string[])[0];expect(held.snapshot.holds.find(x=>x.id===lotId)).toMatchObject({hold:1,item_id:item,location_id:hold});
 await expect(run('hold.release',{lot_id:lotId,quantity:2,location_id:receiving,reason:'Too many'})).rejects.toMatchObject({code:'OVERAGE_APPROVAL_REQUIRED'});
 await run('hold.release',{lot_id:lotId,quantity:1,location_id:receiving,reason:'Inspection authorised'});await run('stock.inspect',{lines:[{lot_id:lotId,quantity:1,outcome:'normal'}]});const restored=await run('stock.putaway',{lines:[{lot_id:lotId,quantity:1,location_id:storage}]});expect(restored.snapshot.reconciliation.ok).toBe(true);expect(restored.snapshot.holds.find(x=>x.id===lotId)).toMatchObject({hold:0,pending:0,normal:0,putaway:1});
 }
});
