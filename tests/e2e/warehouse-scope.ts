import type { Pool } from "pg";

const demoTenants = new Map([
  ["00000000-0000-4000-8000-000000000001", "a"],
  ["00000000-0000-4000-8000-000000000002", "b"],
]);

/** Test preparation only: legacy role tests intentionally share this newly created warehouse. */
export async function grantFixtureWarehouse(pool: Pool, tenantId: string, warehouseId: string): Promise<void> {
  const company = demoTenants.get(tenantId);
  if (!company || !/^[0-9a-f-]{36}$/i.test(warehouseId)) throw new Error("Expected an isolated demo-company warehouse fixture.");
  const emails = [`worker.${company}@example.test`, `viewer.${company}@example.test`];
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
    const members = await client.query(`SELECT m.user_id FROM memberships m JOIN "user" u ON u.id=m.user_id
      WHERE m.tenant_id=$1 AND u.email=ANY($2::text[]) AND m.status='active' AND m.role IN ('worker','viewer')`, [tenantId, emails]);
    if (members.rowCount !== emails.length) throw new Error("The expected active demo worker and viewer must exist.");
    const warehouse = await client.query("SELECT id FROM warehouses WHERE tenant_id=$1 AND id=$2", [tenantId, warehouseId]);
    if (!warehouse.rowCount) throw new Error("Fixture warehouse must belong to the selected company.");
    await client.query(`INSERT INTO v2_warehouse_grants(tenant_id,user_id,warehouse_id)
      SELECT $1,unnest($2::text[]),$3 ON CONFLICT DO NOTHING`, [tenantId, members.rows.map(row => row.user_id), warehouseId]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}
