import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { migrate } from '../../scripts/db-migrate.mjs';
import type { Identity } from '../../src/server/auth/access';
import { assertPersistedInvariants } from '../helpers/v2-invariants';
const state = vi.hoisted(() => ({ pool: undefined as pg.Pool | undefined }));
vi.mock('../../src/server/db/pool', () => ({ getPool: () => state.pool }));
import { withTenant } from '../../src/server/db/tenant';
import { createDocument } from '../../src/server/documents';
import { postDocument } from '../../src/server/posting';
import { reverseDocument } from '../../src/server/reverse';
import { activateCutover, previewCutover } from '../../src/server/v2/operations/cutover';
import { openingImport, listOpeningImports } from '../../src/server/v2/operations/opening-import';
import { executeWorkflow, getWorkflowSnapshot } from '../../src/server/v2/workflow';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl || !decodeURIComponent(new URL(databaseUrl).pathname).endsWith('_test')) throw new Error('A dedicated TEST_DATABASE_URL ending in _test is required.');
const schema = `v2_cutover_${randomUUID().replaceAll('-', '')}`;
const role = `app_${randomUUID().replaceAll('-', '')}`;
const password = randomBytes(32).toString('hex');
const owner = new pg.Pool({ connectionString: databaseUrl });
const appUrl = new URL(databaseUrl); appUrl.username = role; appUrl.password = password;
let roleCreated = false;
const tenant = randomUUID(); const userId = randomUUID();
const identity: Identity = { user: { id: userId, name: 'Migration operator', email: `${userId}@example.test` }, tenant: { id: tenant, name: 'Migration company' }, role: 'admin' };

beforeAll(async () => {
  await owner.query(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD ${pg.escapeLiteral(password)}`); roleCreated = true;
  await migrate(databaseUrl, { schema, migrationsSchema: schema, createSchema: true, createMigrationsSchema: true, log: () => {} });
  await owner.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${role}"`);
  await owner.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA "${schema}" TO "${role}"`);
  await owner.query(`INSERT INTO "${schema}".tenants(id,name) VALUES($1,'Migration company')`, [tenant]);
  await owner.query(`INSERT INTO "${schema}"."user"(id,name,email) VALUES($1,'Migration operator',$2)`, [userId, identity.user.email]);
  await owner.query(`INSERT INTO "${schema}".memberships(tenant_id,user_id,role) VALUES($1,$2,'admin')`, [tenant, userId]);
  state.pool = new pg.Pool({ connectionString: appUrl.toString(), max: 5, options: `-c search_path=${schema}` });
}, 30_000);
afterAll(async () => {
  await state.pool?.end();
  try { await owner.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
  finally { try { if (roleCreated) await owner.query(`DROP ROLE "${role}"`); } finally { await owner.end(); } }
});

async function legacyWarehouse(empty = false) {
  const warehouse = randomUUID(); const storage = randomUUID(); const hold = randomUUID(); const item = randomUUID(); const partner = randomUUID(); const destination = randomUUID();
  await withTenant(tenant, async client => {
    await client.query("INSERT INTO warehouses(id,tenant_id,code,name) VALUES($1::uuid,$2,$1::text,'Legacy warehouse')", [warehouse, tenant]);
    await client.query('INSERT INTO v2_warehouse_grants(tenant_id,user_id,warehouse_id) VALUES($1,$2,$3)', [tenant, userId, warehouse]);
    await client.query("INSERT INTO locations(id,tenant_id,warehouse_id,code,name,kind) VALUES($1::uuid,$2,$3,$1::text,'Storage','STORAGE'),($4::uuid,$2,$3,$4::text,'Hold','HOLD')", [storage, tenant, warehouse, hold]);
    await client.query("INSERT INTO items(id,tenant_id,code,name) VALUES($1::uuid,$2,$1::text,'Legacy item')", [item, tenant]);
    await client.query("INSERT INTO business_partners(id,tenant_id,code,name,supplier,customer) VALUES($1::uuid,$2,$1::text,'Migration partner',true,true)", [partner,tenant]);
    await client.query("INSERT INTO delivery_destinations(id,tenant_id,partner_id,recipient_name,name,address_line1) VALUES($1::uuid,$2,$3,'Migration recipient',$1::text,'Synthetic migration address')", [destination,tenant,partner]);
  });
  async function draft(quantity = 20) {
    return createDocument(tenant, { kind: 'INBOUND', warehouse_id: warehouse, source_location_id: null, destination_location_id: storage, note: 'Original legacy inbound', lines: [{ item_id: item, quantity }] });
  }
  const original = empty ? {id:'',version:0} : await draft();
  const posted = empty ? null : await postDocument(identity, original.id as string, original.version as number, randomUUID());
  const rows = [{ item_id: item, source_location_id: storage, location_id: storage, bucket: 'S', quantity: 10 }, { item_id: item, source_location_id: storage, location_id: hold, bucket: 'B', quantity: 10 }];
  const body = async () => ({ warehouse_id: warehouse, request_id: randomUUID(), snapshot_hash: (await previewCutover(identity, warehouse)).snapshot_hash, confirmed: true, rows });
  async function effects() {
    return withTenant(tenant, async client => {
      const result: Record<string, unknown[]> = {};
      for (const table of ['inventory_documents', 'stock_balances', 'stock_ledger', 'v2_cutovers', 'v2_workflow_state', 'v2_workflow_stock', 'v2_workflow_requests', 'v2_workflow_ledger']) result[table] = (await client.query(`SELECT to_jsonb(t) AS row FROM ${table} t WHERE warehouse_id=$1 ORDER BY to_jsonb(t)::text`, [warehouse])).rows;
      result.lines = (await client.query('SELECT to_jsonb(l) AS row FROM inventory_document_lines l JOIN inventory_documents d ON d.tenant_id=l.tenant_id AND d.id=l.document_id WHERE d.warehouse_id=$1 ORDER BY l.id', [warehouse])).rows;
      result.audit = (await client.query('SELECT to_jsonb(a) AS row FROM audit_logs a JOIN inventory_documents d ON d.tenant_id=a.tenant_id AND d.id=a.document_id WHERE d.warehouse_id=$1 ORDER BY a.id', [warehouse])).rows;
      return result;
    });
  }
  return { warehouse, storage, hold, item, original, posted, rows, body, draft, effects, delivery: { partner_id: partner, delivery_destination_id: destination } };
}

describe('AC-17 legacy cutover rehearsal on real PostgreSQL', () => {
  it('preserves legacy identifiers, history and twenty physical units while mapping ten S and ten B exactly once', async () => {
    const w = await legacyWarehouse(); const before = await w.effects(); const body = await w.body();
    const converted = await activateCutover(identity, body); expect(converted.replayed).toBe(false);
    const after = await w.effects();
    for (const key of ['inventory_documents', 'stock_balances', 'stock_ledger', 'lines', 'audit']) expect(after[key]).toEqual(before[key]);
    const snapshot = await getWorkflowSnapshot(identity, w.warehouse);
    expect(snapshot.receipts).toEqual([]); // No invented historical receipt/inspection steps.
    expect(snapshot.stock.reduce((sum, row) => sum + row.H, 0)).toBe(20);
    expect(snapshot.stock.find(row => row.location_id === w.storage)).toMatchObject({ S: 10, A: 10 });
    expect(snapshot.stock.find(row => row.location_id === w.hold)).toMatchObject({ B: 10, A: 0 });
    expect(snapshot.ledger).toHaveLength(2);
    for (const row of snapshot.ledger) expect(row).toMatchObject({ command: 'MIGRATION_OPENING', actor_id: userId, request_id: body.request_id });
    const replay = await activateCutover(identity, body); expect(replay.replayed).toBe(true);
    expect(await w.effects()).toEqual(after);
    await expect(activateCutover(identity, { ...body, request_id: randomUUID() })).rejects.toMatchObject({ code: 'ALREADY_CONVERTED' });
    const order = await executeWorkflow(identity, { warehouse_id: w.warehouse, request_id: randomUUID(), command: 'order.create', payload: { delivery: w.delivery, due_at: '2026-10-21T09:00:00.000Z', lines: [{ item_id: w.item, quantity: 10 }] } });
    await executeWorkflow(identity, { warehouse_id: w.warehouse, request_id: randomUUID(), command: 'order.reserve', payload: { order_id: order.result.id, partial: false } });
    const worked = await getWorkflowSnapshot(identity, w.warehouse);
    expect(worked.stock.reduce((sum, row) => sum + row.H, 0)).toBe(20);
    expect(worked.stock.reduce((sum, row) => sum + row.R, 0)).toBe(10);
    await withTenant(tenant, client => assertPersistedInvariants(client, w.warehouse));
  });

  it('blocks legacy post/reverse and direct ledger/balance/document writes after activation, leaving other warehouses usable', async () => {
    const w = await legacyWarehouse(); const unaffected = await legacyWarehouse(); await activateCutover(identity, await w.body());
    const before = await w.effects();
    await expect(reverseDocument(identity, w.original.id as string, w.posted!.document.version, randomUUID())).rejects.toBeDefined();
    await withTenant(tenant, async client => {
      await expect(client.query('UPDATE stock_balances SET quantity=21 WHERE warehouse_id=$1', [w.warehouse])).rejects.toMatchObject({ code: '23514' });
    });
    await withTenant(tenant, async client => {
      await expect(client.query("INSERT INTO stock_ledger(tenant_id,document_id,warehouse_id,location_id,item_id,quantity_delta) VALUES($1,$2,$3,$4,$5,1)", [tenant, w.original.id, w.warehouse, w.storage, w.item])).rejects.toMatchObject({ code: '23514' });
    });
    await withTenant(tenant, async client => {
      await expect(client.query("UPDATE inventory_documents SET note='Changed historical document' WHERE id=$1", [w.original.id])).rejects.toMatchObject({ code: '23514' });
    });
    expect(await w.effects()).toEqual(before);
    await expect(w.draft(1)).rejects.toBeDefined();
    expect(await w.effects()).toEqual(before);
    const other = await unaffected.draft(2);
    await postDocument(identity, other.id as string, other.version as number, randomUUID());
    await reverseDocument(identity, unaffected.original.id as string, unaffected.posted!.document.version, randomUUID());
    expect((await previewCutover(identity, unaffected.warehouse)).consistent).toBe(true);
  });

  it('rejects ledger disagreement, unfinished drafts, excessive mapping and incompatible target location types without any partial cutover', async () => {
    const mismatch = await legacyWarehouse();
    await withTenant(tenant, client => client.query('UPDATE stock_balances SET quantity=21 WHERE warehouse_id=$1', [mismatch.warehouse]));
    const mismatchBody = await mismatch.body(); const mismatchBefore = await mismatch.effects();
    await expect(activateCutover(identity, mismatchBody)).rejects.toMatchObject({ code: 'LEDGER_MISMATCH' });
    expect(await mismatch.effects()).toEqual(mismatchBefore);
    const drafts = await legacyWarehouse(); await drafts.draft(1); const draftBefore = await drafts.effects();
    await expect(activateCutover(identity, await drafts.body())).rejects.toMatchObject({ code: 'DRAFTS_REMAIN' });
    expect(await drafts.effects()).toEqual(draftBefore);
    const mapping = await legacyWarehouse(); const body = await mapping.body(); const mappingBefore = await mapping.effects();
    await expect(activateCutover(identity, { ...body, rows: [{ ...mapping.rows[0], quantity: 11 }, mapping.rows[1]] })).rejects.toMatchObject({ code: 'OPENING_MAPPING_MISMATCH' });
    await expect(activateCutover(identity, { ...body, rows: [{ ...mapping.rows[0], location_id: mapping.hold }, mapping.rows[1]] })).rejects.toMatchObject({ code: 'LOCATION_TYPE_MISMATCH' });
    expect(await mapping.effects()).toEqual(mappingBefore);
  });

  it('rejects stale preview after new legacy work and keeps existing history available', async () => {
    const w = await legacyWarehouse(); const body = await w.body(); const newDraft = await w.draft(2);
    await postDocument(identity, newDraft.id as string, newDraft.version as number, randomUUID());
    const before = await w.effects();
    await expect(activateCutover(identity, body)).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    expect(await w.effects()).toEqual(before);
    const preview = await previewCutover(identity, w.warehouse); expect(preview.consistent).toBe(true); expect(preview.rows[0].quantity).toBe('22');
  });

  it('rolls back opening stock, migration ledger and durable response if activation persistence crashes', async () => {
    const w = await legacyWarehouse(); const body = await w.body(); const before = await w.effects();
    const fn = `fail_${randomUUID().replaceAll('-', '')}`;
    await owner.query(`CREATE FUNCTION "${schema}"."${fn}"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.warehouse_id='${w.warehouse}'::uuid THEN RAISE EXCEPTION 'injected activation persistence failure'; END IF; RETURN NEW; END $$`);
    await owner.query(`CREATE TRIGGER "${fn}" BEFORE INSERT ON "${schema}".v2_cutovers FOR EACH ROW EXECUTE FUNCTION "${schema}"."${fn}"()`);
    try { await expect(activateCutover(identity, body)).rejects.toBeDefined(); }
    finally { await owner.query(`DROP TRIGGER "${fn}" ON "${schema}".v2_cutovers`); await owner.query(`DROP FUNCTION "${schema}"."${fn}"()`); }
    expect(await w.effects()).toEqual(before);
    await activateCutover(identity, body);
    expect((await getWorkflowSnapshot(identity, w.warehouse)).stock.reduce((sum, row) => sum + row.H, 0)).toBe(20);
    await withTenant(tenant, client => assertPersistedInvariants(client, w.warehouse));
  });
});


describe('External opening inventory with preserved source and independent approval', () => {
 async function approver(warehouse:string){
  const id=randomUUID();
  await owner.query(`INSERT INTO "${schema}"."user"(id,name,email) VALUES($1,'Other approver',$2)`,[id,id+'@example.test']);
  await owner.query(`INSERT INTO "${schema}".memberships(tenant_id,user_id,role) VALUES($1,$2,'admin')`,[tenant,id]);
  await owner.query(`INSERT INTO "${schema}".v2_warehouse_grants(tenant_id,user_id,warehouse_id) VALUES($1,$2,$3)`,[tenant,id,warehouse]);
  return {...identity,user:{id,name:'Other approver',email:id+'@example.test'}};
 }
 function input(w:Awaited<ReturnType<typeof legacyWarehouse>>){return {action:'submit',warehouse_id:w.warehouse,request_id:randomUUID(),source_system:'External workbook',extracted_at:'2026-01-01T00:00:00Z',reason:'Approved initial physical count',csv:`item_code,location_code,bucket,quantity\n${w.item},${w.storage},S,12\n${w.item},${w.hold},B,3`};}
 it('retains source and row errors, requires another approver and commits exactly one opening',async()=>{
  const w=await legacyWarehouse(true),other=await approver(w.warehouse),body=input(w);
  const preview=await openingImport(identity,{...body,action:'preview'});expect('errors' in preview && preview.errors).toEqual([]);
  const result=await openingImport(identity,body);if(!('import' in result))throw Error('missing import');
  expect(result.import.payload.csv).toBe(body.csv);
  const decision={action:'approve',warehouse_id:w.warehouse,request_id:randomUUID(),import_id:result.import.id,reason:'Physical quantities independently verified',confirmed:true};
  await expect(openingImport(identity,decision)).rejects.toMatchObject({code:'SEPARATE_APPROVER_REQUIRED'});
  const outcomes=await Promise.all([openingImport(other,decision),openingImport(other,decision)]);
  expect(outcomes.map(done=>'replayed' in done&&done.replayed).sort()).toEqual([false,true]);
  const snapshot=await getWorkflowSnapshot(identity,w.warehouse);expect(snapshot.stock.reduce((n,r)=>n+r.H,0)).toBe(15);
  expect(snapshot.ledger).toHaveLength(2);expect(snapshot.ledger.every(r=>r.command==='EXTERNAL_OPENING')).toBe(true);
  expect((await listOpeningImports(identity,w.warehouse)).imports).toHaveLength(2);
  await expect(withTenant(tenant,c=>c.query("UPDATE v2_opening_imports SET payload='{}'::jsonb WHERE id=$1",[result.import.id]))).rejects.toBeDefined();
  const worker=await approver(w.warehouse);
  await owner.query(`UPDATE "${schema}".memberships SET role='worker' WHERE tenant_id=$1 AND user_id=$2`,[tenant,worker.user.id]);
  await expect(listOpeningImports(worker,w.warehouse)).rejects.toMatchObject({code:'ROLE_FORBIDDEN'});
  await expect(w.draft()).rejects.toBeDefined();
  await withTenant(tenant,c=>assertPersistedInvariants(c,w.warehouse));
 });
 it('keeps invalid source history without stock effect and permits rejection only',async()=>{
  const w=await legacyWarehouse(true),other=await approver(w.warehouse),body=input(w);
  body.csv+='\nunknown,wrong,S,1';const result=await openingImport(identity,body);if(!('import' in result))throw Error('missing import');
  expect(result.import.payload.errors).toHaveLength(1);
  const decision={action:'approve',warehouse_id:w.warehouse,request_id:randomUUID(),import_id:result.import.id,reason:'Invalid references',confirmed:true};
  await expect(openingImport(other,decision)).rejects.toMatchObject({code:'IMPORT_HAS_ERRORS'});
  await openingImport(other,{...decision,action:'reject'});
  expect((await getWorkflowSnapshot(identity,w.warehouse)).stock).toEqual([]);
  await expect(openingImport(other,{...decision,request_id:randomUUID()})).rejects.toMatchObject({code:'ALREADY_DECIDED'});
 });
 it('cannot add external opening to existing MVP stock or reuse a request with different content',async()=>{
  const w=await legacyWarehouse(),other=await approver(w.warehouse),body=input(w);
  const result=await openingImport(identity,body);if(!('import' in result))throw Error('missing import');
  await expect(openingImport(identity,{...body,reason:'Changed'})).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
  await expect(openingImport(other,{action:'approve',warehouse_id:w.warehouse,request_id:randomUUID(),import_id:result.import.id,reason:'Check duplication',confirmed:true})).rejects.toMatchObject({code:'EXTERNAL_OPENING_REQUIRES_EMPTY_WAREHOUSE'});
  const totals=await withTenant(tenant,c=>c.query('SELECT sum(quantity)::int total FROM stock_balances WHERE warehouse_id=$1',[w.warehouse]));expect(totals.rows[0].total).toBe(20);
 });
 it('serializes the same tenant request key across warehouses into one result and a domain conflict',async()=>{
  const first=await legacyWarehouse(true),second=await legacyWarehouse(true),key=randomUUID();
  const outcomes=await Promise.allSettled([openingImport(identity,{...input(first),request_id:key}),openingImport(identity,{...input(second),request_id:key})]);
  expect(outcomes.filter(result=>result.status==='fulfilled')).toHaveLength(1);
  expect(outcomes.filter(result=>result.status==='rejected')).toEqual([expect.objectContaining({reason:expect.objectContaining({code:'IDEMPOTENCY_CONFLICT',status:409})})]);
  expect((await listOpeningImports(identity,first.warehouse)).imports.length+(await listOpeningImports(identity,second.warehouse)).imports.length).toBe(1);
 });
 it('checks current approval authority after an actual warehouse lock wait',async()=>{
  const w=await legacyWarehouse(true),other=await approver(w.warehouse),submitted=await openingImport(identity,input(w));if(!('import' in submitted))throw Error('missing import');
  const blocker=await owner.connect();let outcome:Promise<PromiseSettledResult<unknown>>|undefined;
  try{
   await blocker.query('BEGIN');await blocker.query(`SELECT id FROM "${schema}".warehouses WHERE id=$1 FOR UPDATE`,[w.warehouse]);
   outcome=Promise.allSettled([openingImport(other,{action:'approve',warehouse_id:w.warehouse,request_id:randomUUID(),import_id:submitted.import.id,reason:'Recheck approval access after waiting',confirmed:true})]).then(results=>results[0]);
   let waiting=0;
   for(let attempt=0;attempt<100&&!waiting;attempt++){
    waiting=(await owner.query("SELECT count(*)::int count FROM pg_stat_activity WHERE usename=$1 AND datname=current_database() AND wait_event_type='Lock'",[role])).rows[0].count;
    if(!waiting)await new Promise(resolve=>setTimeout(resolve,20));
   }
   expect(waiting).toBeGreaterThan(0);
   await owner.query(`UPDATE "${schema}".memberships SET role='worker' WHERE tenant_id=$1 AND user_id=$2`,[tenant,other.user.id]);
   await blocker.query('COMMIT');
   expect(await outcome).toMatchObject({status:'rejected',reason:{code:'ROLE_FORBIDDEN',status:403}});
  }finally{await blocker.query('ROLLBACK');blocker.release();await outcome;}
  expect((await listOpeningImports(identity,w.warehouse)).imports).toHaveLength(1);
  expect((await getWorkflowSnapshot(identity,w.warehouse)).stock).toEqual([]);
 });
 it('refuses durable v2 business history even if a damaged aggregate claims to be empty',async()=>{
  const w=await legacyWarehouse(true),other=await approver(w.warehouse);
  const order=await executeWorkflow(identity,{warehouse_id:w.warehouse,request_id:randomUUID(),command:'order.create',payload:{delivery:w.delivery,due_at:'2026-10-21T09:00:00Z',lines:[{item_id:w.item,quantity:1}]}});
  const submitted=await openingImport(identity,input(w));if(!('import' in submitted))throw Error('missing import');
  await owner.query(`UPDATE "${schema}".v2_workflow_state SET version=0,state=jsonb_set(jsonb_set(state,'{version}','0'),'{orders}','[]') WHERE warehouse_id=$1`,[w.warehouse]);
  await expect(openingImport(other,{action:'approve',warehouse_id:w.warehouse,request_id:randomUUID(),import_id:submitted.import.id,reason:'Durable records must prevent a second opening',confirmed:true})).rejects.toMatchObject({code:'EXTERNAL_OPENING_REQUIRES_EMPTY_WAREHOUSE'});
  const objects=await withTenant(tenant,c=>c.query('SELECT id FROM v2_workflow_objects WHERE warehouse_id=$1',[w.warehouse]));expect(objects.rows.map(row=>row.id)).toContain(order.result.id);
  expect((await listOpeningImports(identity,w.warehouse)).imports).toHaveLength(1);
 });
});
