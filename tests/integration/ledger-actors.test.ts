import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { migrate } from "../../scripts/db-migrate.mjs";
const state = vi.hoisted(() => ({ pool: undefined as pg.Pool | undefined }));
vi.mock("../../src/server/db/pool", () => ({ getPool: () => state.pool }));
import { withTenant } from "../../src/server/db/tenant";
import { pagedLedger, parseQuery } from "../../src/server/queries";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl || !decodeURIComponent(new URL(databaseUrl).pathname).endsWith("_test")) throw new Error("Dedicated TEST_DATABASE_URL required.");
const schema = `ledger_actors_${randomUUID().replaceAll("-", "")}`;
const role = `app_${randomUUID().replaceAll("-", "")}`;
const password = randomBytes(32).toString("hex");
const owner = new pg.Pool({ connectionString: databaseUrl });
const tenants = [randomUUID(), randomUUID()];
const documents = tenants.map(() => ({ original: randomUUID(), reversal: randomUUID(), unaudited: randomUUID() }));
let roleCreated = false;
beforeAll(async () => {
  await owner.query(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD ${pg.escapeLiteral(password)}`);
  roleCreated = true;
  await migrate(databaseUrl, { schema, migrationsSchema: schema, createSchema: true, createMigrationsSchema: true, log: () => {} });
  await owner.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${role}"`);
  await owner.query(`GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA "${schema}" TO "${role}"`);
  await owner.query(`INSERT INTO "${schema}".tenants(id,name) VALUES ($1,'A'),($2,'B')`, tenants);
  for (const name of ["Old", "Lower tie", "Poster", "Reverser", "Unrelated", "Foreign"]) {
    await owner.query(`INSERT INTO "${schema}"."user"(id,name,email) VALUES ($1,$1,$2)`, [name, `${name.replaceAll(" ", "")}@example.test`]);
  }
  const appUrl = new URL(databaseUrl); appUrl.username = role; appUrl.password = password;
  state.pool = new pg.Pool({ connectionString: appUrl.toString(), options: `-c search_path=${schema}` });
  for (const [index, tenant] of tenants.entries()) await withTenant(tenant, async client => {
    const warehouse = randomUUID(), location = randomUUID(), item = randomUUID();
    const { original, reversal, unaudited } = documents[index];
    await client.query("INSERT INTO warehouses(id,tenant_id,code,name) VALUES ($1,$2,'W','W')", [warehouse,tenant]);
    await client.query("INSERT INTO locations(id,tenant_id,warehouse_id,code,name) VALUES ($1,$2,$3,'L','L')", [location,tenant,warehouse]);
    await client.query("INSERT INTO items(id,tenant_id,code,name) VALUES ($1,$2,'I','Item')", [item,tenant]);
    await client.query("INSERT INTO inventory_documents(id,tenant_id,kind,status,warehouse_id,destination_location_id) VALUES ($1,$2,'INBOUND','REVERSED',$3,$4),($5,$2,'INBOUND','POSTED',$3,$4)", [original,tenant,warehouse,location,unaudited]);
    await client.query("INSERT INTO inventory_documents(id,tenant_id,kind,status,warehouse_id,source_location_id,reversal_of_id) VALUES ($1,$2,'OUTBOUND','POSTED',$3,$4,$5)", [reversal,tenant,warehouse,location,original]);
    for (const [document, quantity] of [[original, 3], [reversal, -3], [unaudited, 1]] as const) {
      await client.query("INSERT INTO stock_ledger(tenant_id,document_id,warehouse_id,location_id,item_id,quantity_delta) VALUES ($1,$2,$3,$4,$5,$6)", [tenant,document,warehouse,location,item,quantity]);
    }
    // The newest timestamp wins before UUID order; equal timestamps use greatest UUID.
    const audits = index ? [[randomUUID(), "Foreign", "POST_INBOUND", "2026-10-21"]] : [
      ["ffffffff-ffff-4fff-8fff-ffffffffffff", "Old", "POST_INBOUND", "2026-10-18"],
      ["11111111-1111-4111-8111-111111111111", "Lower tie", "POST_INBOUND", "2026-10-19"],
      ["22222222-2222-4222-8222-222222222222", "Poster", "POST_INBOUND", "2026-10-19"],
      [randomUUID(), "Reverser", "REVERSE_DOCUMENT", "2026-10-20"],
      [randomUUID(), "Unrelated", "POST_OUTBOUND", "2026-10-21"],
    ];
    for (const [id, actor, action, at] of audits) await client.query("INSERT INTO audit_logs(id,tenant_id,document_id,actor_id,action,created_at) VALUES ($1,$2,$3,$4,$5,$6)", [id,tenant,original,actor,action,at]);
    // An audit attached to the compensation itself must not replace original reversal actor.
    await client.query("INSERT INTO audit_logs(tenant_id,document_id,actor_id,action) VALUES ($1,$2,'Unrelated','REVERSE_DOCUMENT')", [tenant,reversal]);
  });
});
afterAll(async () => {
  await state.pool?.end();
  try { await owner.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
  finally { try { if (roleCreated) await owner.query(`DROP ROLE "${role}"`); } finally { await owner.end(); } }
});
it("selects the latest actor per tenant, document and action with deterministic timestamp ties", async () => {
  const first = await pagedLedger(tenants[0], parseQuery(new URLSearchParams()));
  const entries = first.entries as { document_id: string; actor_name: string | null; human_kind: string }[];
  expect(entries).toHaveLength(3);
  expect(entries.find(row => row.document_id === documents[0].original)).toMatchObject({ actor_name: "Poster", human_kind: "INBOUND" });
  expect(entries.find(row => row.document_id === documents[0].reversal)).toMatchObject({ actor_name: "Reverser", human_kind: "REVERSAL" });
  expect(entries.find(row => row.document_id === documents[0].unaudited)).toMatchObject({ actor_name: null });
  const second = await pagedLedger(tenants[1], parseQuery(new URLSearchParams()));
  expect(second.entries).toHaveLength(3);
  expect((second.entries as typeof entries).find(row => row.document_id === documents[1].original)?.actor_name).toBe("Foreign");
  expect((second.entries as typeof entries).every(row => !entries.some(firstRow => firstRow.document_id === row.document_id))).toBe(true);
});
