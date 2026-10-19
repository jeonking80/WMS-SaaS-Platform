import { withTenant } from "./db/tenant";

export function listStock(tenantId: string) {
  return withTenant(tenantId, async client => (await client.query(`
    SELECT b.warehouse_id, w.name AS warehouse_name, b.location_id, l.code AS location_code,
           b.item_id, i.code AS item_code, i.name AS item_name, b.quantity::text
      FROM stock_balances b
      JOIN warehouses w ON (w.tenant_id,w.id)=(b.tenant_id,b.warehouse_id)
      JOIN locations l ON (l.tenant_id,l.id)=(b.tenant_id,b.location_id)
      JOIN items i ON (i.tenant_id,i.id)=(b.tenant_id,b.item_id)
     ORDER BY w.code,l.code,i.code,b.item_id LIMIT 1000
  `)).rows);
}

export function listLedger(tenantId: string) {
  return withTenant(tenantId, async client => (await client.query(`
    SELECT s.id, s.document_id, w.name AS warehouse_name, l.code AS location_code,
           i.code AS item_code, i.name AS item_name, s.quantity_delta::text, s.created_at
      FROM stock_ledger s
      JOIN warehouses w ON (w.tenant_id,w.id)=(s.tenant_id,s.warehouse_id)
      JOIN locations l ON (l.tenant_id,l.id)=(s.tenant_id,s.location_id)
      JOIN items i ON (i.tenant_id,i.id)=(s.tenant_id,s.item_id)
     ORDER BY s.created_at DESC,s.id DESC LIMIT 1000
  `)).rows);
}

export function reconcileStock(tenantId: string) {
  return withTenant(tenantId, async client => {
    // One statement means one MVCC snapshot, including while another inbound commits.
    const result = await client.query(`
      WITH ledger AS (
        SELECT tenant_id,location_id,item_id,SUM(quantity_delta) AS quantity
          FROM stock_ledger GROUP BY tenant_id,location_id,item_id
      )
      SELECT COALESCE(b.location_id,l.location_id) AS location_id,
             COALESCE(b.item_id,l.item_id) AS item_id,
             COALESCE(b.quantity,0)::text AS balance_quantity,
             COALESCE(l.quantity,0)::text AS ledger_quantity
        FROM stock_balances b FULL JOIN ledger l
          ON (b.tenant_id,b.location_id,b.item_id)=(l.tenant_id,l.location_id,l.item_id)
       WHERE COALESCE(b.quantity,0) <> COALESCE(l.quantity,0)
       ORDER BY 1,2
    `);
    return { consistent: result.rows.length === 0, mismatches: result.rows };
  });
}
