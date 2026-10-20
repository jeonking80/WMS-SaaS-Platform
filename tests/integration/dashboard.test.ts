import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { migrate } from '../../scripts/db-migrate.mjs';
const state = vi.hoisted(() => ({ pool: undefined as pg.Pool | undefined }));
vi.mock('../../src/server/db/pool', () => ({ getPool: () => state.pool }));
import { getDashboard } from '../../src/server/dashboard';
import { withTenant } from '../../src/server/db/tenant';
import { searchMaster } from '../../src/server/master-search';
import { pagedDocuments, pagedLedger, pagedAuditLogs, parseQuery } from '../../src/server/queries';
import { getDocument } from '../../src/server/documents';
import { validateMasterInput } from '../../src/server/master-data';
const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl || !decodeURIComponent(new URL(databaseUrl).pathname).endsWith('_test')) throw new Error('Dedicated TEST_DATABASE_URL required.');
const schema = `dashboard_${randomUUID().replaceAll('-', '')}`;
const role = `app_${randomUUID().replaceAll('-', '')}`;
const password = randomBytes(32).toString('hex');
const owner = new pg.Pool({ connectionString: databaseUrl });
const tenants = [randomUUID(), randomUUID()];
let roleCreated = false;
let missingItem = '';
beforeAll(async () => {
  await owner.query(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD ${pg.escapeLiteral(password)}`);
  roleCreated = true;
  await migrate(databaseUrl, { schema, migrationsSchema: schema, createSchema: true, createMigrationsSchema: true, log: () => {} });
  await owner.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${role}"`);
  await owner.query(`GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA "${schema}" TO "${role}"`);
  await owner.query(`INSERT INTO "${schema}".tenants(id,name) VALUES ($1,'A'),($2,'B')`, tenants);
  const appUrl = new URL(databaseUrl); appUrl.username = role; appUrl.password = password;
  state.pool = new pg.Pool({ connectionString: appUrl.toString(), options: `-c search_path=${schema}` });
  for (const [index, tenant] of tenants.entries()) await withTenant(tenant, async client => {
    const warehouse = randomUUID(), location = randomUUID(), item = randomUUID();
    await client.query("INSERT INTO warehouses(id,tenant_id,code,name) VALUES ($1,$2,'W','W')", [warehouse,tenant]);
    await client.query("INSERT INTO locations(id,tenant_id,warehouse_id,code,name) VALUES ($1,$2,$3,'L','L')", [location,tenant,warehouse]);
    await client.query("INSERT INTO items(id,tenant_id,code,name,min_stock) VALUES ($1,$2,'STOCK','Stock',5)", [item,tenant]);
    await client.query('INSERT INTO stock_balances(tenant_id,warehouse_id,location_id,item_id,quantity) VALUES ($1,$2,$3,$4,3)', [tenant,warehouse,location,item]);
    if (index) return;
    missingItem = randomUUID();
    await client.query("INSERT INTO items(id,tenant_id,code,name,min_stock) VALUES ($1,$2,'MISSING','Missing',2)", [missingItem,tenant]);
    await client.query("INSERT INTO items(tenant_id,code,name,min_stock,active) VALUES ($1,'INACTIVE','Inactive',9,false)", [tenant]);
    const original = randomUUID();
    // Seoul midnight is 15:00 UTC: original yesterday, reversal today.
    await client.query(`INSERT INTO inventory_documents(id,tenant_id,kind,status,warehouse_id,destination_location_id,posted_at,reversed_at)
      VALUES ($1,$2,'INBOUND','REVERSED',$3,$4,'2026-10-19T14:59:59Z','2026-10-19T15:00:00Z')`, [original,tenant,warehouse,location]);
    await client.query(`INSERT INTO inventory_documents(tenant_id,kind,status,warehouse_id,source_location_id,posted_at,reversal_of_id)
      VALUES ($1,'OUTBOUND','POSTED',$2,$3,'2026-10-19T15:00:00Z',$4)`, [tenant,warehouse,location,original]);
    await client.query(`INSERT INTO inventory_documents(tenant_id,kind,status,warehouse_id,destination_location_id,posted_at)
      VALUES ($1,'INBOUND','POSTED',$2,$3,'2026-10-19T15:00:00Z')`, [tenant,warehouse,location]);
    await client.query(`INSERT INTO inventory_documents(tenant_id,kind,status,warehouse_id,source_location_id)
      VALUES ($1,'OUTBOUND','DRAFT',$2,$3),($1,'OUTBOUND','CANCELLED',$2,$3)`, [tenant,warehouse,location]);
  });
}, 30_000);
afterAll(async () => {
  await state.pool?.end();
  try { await owner.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
  finally { try { if (roleCreated) await owner.query(`DROP ROLE "${role}"`); } finally { await owner.end(); } }
});
it('counts Seoul days, preserves reversed throughput, excludes reversal throughput and draft history, and isolates tenants', async () => {
  const result = await getDashboard(tenants[0], new Date('2026-10-20T03:00:00Z'));
  expect(result.timezone).toBe('Asia/Seoul');
  expect(result.as_of).toBe('2026-10-20T03:00:00.000Z');
  expect(result.metrics).toEqual({ stocked_items:1,today_inbound:1,today_outbound:0,today_reversals:1,pending_outbound:1,low_stock_items:2 });
  expect(result.daily).toHaveLength(7);
  expect(result.daily[5]).toEqual({ date:'2026-10-19',inbound:1,outbound:0,reversals:0 });
  expect(result.daily[6]).toEqual({ date:'2026-10-20',inbound:1,outbound:0,reversals:1 });
  expect(result.low_stock.find(i => i.id === missingItem)).toMatchObject({ min_stock:'2',quantity:'0' });
  expect(result.recent).toHaveLength(3);
  expect(result.recent.every(d => ['POSTED','REVERSED'].includes(d.status))).toBe(true);
  const foreign = await getDashboard(tenants[1],new Date('2026-10-20T03:00:00Z'));
  expect(foreign.metrics).toEqual({ stocked_items:1,today_inbound:0,today_outbound:0,today_reversals:0,pending_outbound:0,low_stock_items:1 });
  expect(foreign.recent).toEqual([]);
  expect(foreign.low_stock.some(i => i.id === missingItem)).toBe(false);
});
it('validates minimum stock input and database bounds', async () => {
  expect(validateMasterInput({min_stock:0},'items',true)).toEqual({min_stock:0});
  expect(validateMasterInput({min_stock:1_000_000_000},'items',true)).toEqual({min_stock:1_000_000_000});
  for (const min_stock of [-1,1.5,1_000_000_001,'2',null]) expect(() => validateMasterInput({min_stock},'items',true)).toThrow();
  expect(() => validateMasterInput({min_stock:2},'warehouses',true)).toThrow();
  await expect(withTenant(tenants[0], client => client.query('UPDATE items SET min_stock=-1 WHERE id=$1',[missingItem]))).rejects.toMatchObject({code:'23514'});
});

it('numbers drafts and reversals uniquely, preserves numbers through updates, and protects draft dashboard rows', async () => {
  const visible = await getDashboard(tenants[0], new Date('2026-10-20T03:00:00Z'), true);
  expect(visible.setup).toEqual({items:2,warehouses:1,locations:1,destinations:0});
  expect(visible.pending).toHaveLength(1);
  expect(visible.pending[0].document_number).toMatch(/^WMS-\d{6,}$/);
  expect((await getDashboard(tenants[0])).pending).toEqual([]);
  const docs = await pagedDocuments(tenants[0], parseQuery(new URLSearchParams()));
  const rows = docs.documents as { id:string; document_number:string; reversal_of_id:string|null }[];
  expect(new Set(rows.map(d => d.document_number)).size).toBe(rows.length);
  const reversal = rows.find(d => d.reversal_of_id)!;
  const detail = await getDocument(tenants[0], reversal.id);
  expect(detail.original_document_number).toBe(rows.find(d => d.id === reversal.reversal_of_id)!.document_number);
  const draft = visible.pending[0];
  await withTenant(tenants[0], client => client.query("UPDATE inventory_documents SET note='changed' WHERE id=$1",[draft.id]));
  expect((await getDocument(tenants[0], draft.id)).document_number).toBe(draft.document_number);
  await expect(withTenant(tenants[0], client => client.query('UPDATE inventory_documents SET document_no=DEFAULT WHERE id=$1',[draft.id]))).rejects.toMatchObject({code:'23514'});
  const found = await pagedDocuments(tenants[0], parseQuery(new URLSearchParams({q:draft.document_number})));
  expect(found.documents).toHaveLength(1);
});
it('paginates tenant item options and treats SQL wildcard characters literally', async () => {
  await withTenant(tenants[0], client => client.query("INSERT INTO items(tenant_id,code,name) VALUES ($1,'PERCENT%_','literal')",[tenants[0]]));
  const result = await searchMaster(tenants[0], 'items', new URLSearchParams({q:'%_'}), true);
  expect(result.items).toHaveLength(1);
  expect(result.pagination.total).toBe(1);
  expect((await searchMaster(tenants[1], 'items', new URLSearchParams({q:'%_'}), true)).items).toEqual([]);
  const page = await searchMaster(tenants[0], 'items', new URLSearchParams({page:'2',page_size:'1'}), true);
  expect(page.items).toHaveLength(1);
  expect(page.pagination).toMatchObject({page:2,page_size:1,total:4,total_pages:4});
  expect((await searchMaster(tenants[0], 'items', new URLSearchParams({active_only:'true'}), true)).pagination.total).toBe(3);
});

it('links posted ledger actor and reversal ledger actor to their actual audit operations', async () => {
  await owner.query(`INSERT INTO "${schema}"."user"(id,name,email) VALUES ('poster','Poster','poster@example.test'),('reverser','Reverser','reverser@example.test')`);
  const rows = await withTenant(tenants[0], async client => {
    const reversal = (await client.query('SELECT * FROM inventory_documents WHERE reversal_of_id IS NOT NULL')).rows[0];
    const item = (await client.query("SELECT id FROM items WHERE code='STOCK'")).rows[0];
    await client.query("INSERT INTO audit_logs(tenant_id,document_id,actor_id,action) VALUES ($1,$2,'poster','POST_INBOUND'),($1,$2,'reverser','REVERSE_DOCUMENT')",[tenants[0],reversal.reversal_of_id]);
    await client.query('INSERT INTO stock_ledger(tenant_id,document_id,warehouse_id,location_id,item_id,quantity_delta) VALUES ($1,$2,$3,$4,$5,3),($1,$6,$3,$4,$5,-3)',[tenants[0],reversal.reversal_of_id,reversal.warehouse_id,reversal.source_location_id,item.id,reversal.id]);
    return reversal;
  });
  const result = await pagedLedger(tenants[0],parseQuery(new URLSearchParams()));
  const entries = result.entries as {document_id:string;actor_name:string;human_kind:string;document_number:string}[];
  expect(entries.find(e => e.document_id===rows.reversal_of_id)).toMatchObject({actor_name:'Poster',human_kind:'INBOUND'});
  expect(entries.find(e => e.document_id===rows.id)).toMatchObject({actor_name:'Reverser',human_kind:'REVERSAL'});
  const audit = await pagedAuditLogs(tenants[0],parseQuery(new URLSearchParams()));
  expect((audit.entries as {document_number:string}[]).every(a => /^WMS-\d{6,}$/.test(a.document_number))).toBe(true);
});

it('matches dashboard history drilldowns by excluding compensation documents while retaining reversed originals', async () => {
  const all = await pagedDocuments(tenants[0],parseQuery(new URLSearchParams()),true);
  const originals = await pagedDocuments(tenants[0],parseQuery(new URLSearchParams({originals_only:'true'})),true);
  const unrestricted = await pagedDocuments(tenants[0],parseQuery(new URLSearchParams({originals_only:'false'})),true);
  const rows = originals.documents as {status:string;reversal_of_id:string|null}[];
  expect(rows.every(d => d.reversal_of_id === null)).toBe(true);
  expect(rows.some(d => d.status === 'REVERSED')).toBe(true);
  expect(originals.pagination.total).toBe(all.pagination.total - 1);
  expect(unrestricted.pagination.total).toBe(all.pagination.total);
  const dashboard = await getDashboard(tenants[0],new Date('2026-10-20T03:00:00Z'));
  for (const kind of ['INBOUND','OUTBOUND']) {
    const history = await pagedDocuments(tenants[0],parseQuery(new URLSearchParams({originals_only:'true',kind,date_field:'posted_at',date_from:'2026-10-20',date_to:'2026-10-20'})),true);
    expect(history.pagination.total).toBe(kind === 'INBOUND' ? dashboard.metrics.today_inbound : dashboard.metrics.today_outbound);
  }
});
