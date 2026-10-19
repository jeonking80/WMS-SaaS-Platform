import type { PoolClient } from "pg";
import { DomainError } from "./api";

export type StockEffect = { location_id: string; item_id: string; delta: number };

/** One lock order shared by posting and reversal, including credit row creation. */
export async function lockStock(client: PoolClient, tenantId: string, warehouseId: string, effects: StockEffect[], active: boolean) {
  const missing = () => { throw new DomainError(404, "REFERENCE_NOT_FOUND"); };
  const activeClause = active ? " AND active=true" : "";
  if (!(await client.query(`SELECT id FROM warehouses WHERE id=$1${activeClause} FOR SHARE`, [warehouseId])).rowCount) missing();
  for (const id of [...new Set(effects.map((effect) => effect.location_id))].sort()) {
    if (!(await client.query(`SELECT id FROM locations WHERE id=$1 AND warehouse_id=$2${activeClause} FOR SHARE`, [id, warehouseId])).rowCount) missing();
  }
  for (const id of [...new Set(effects.map((effect) => effect.item_id))].sort()) {
    if (!(await client.query(`SELECT id FROM items WHERE id=$1${activeClause} FOR SHARE`, [id])).rowCount) missing();
  }
  effects.sort((a, b) => a.location_id.localeCompare(b.location_id) || a.item_id.localeCompare(b.item_id));
  const balances: Array<string | number | undefined> = [];
  for (const effect of effects) {
    if (effect.delta > 0) await client.query("INSERT INTO stock_balances (tenant_id,warehouse_id,location_id,item_id,quantity) VALUES ($1,$2,$3,$4,0) ON CONFLICT (tenant_id,location_id,item_id) DO NOTHING", [tenantId, warehouseId, effect.location_id, effect.item_id]);
    const balance = await client.query("SELECT quantity FROM stock_balances WHERE tenant_id=$1 AND location_id=$2 AND item_id=$3 FOR UPDATE", [tenantId, effect.location_id, effect.item_id]);
    balances.push(balance.rows[0]?.quantity);
  }
  for (const [index, effect] of effects.entries()) {
    const quantity = balances[index];
    if (quantity === undefined || BigInt(quantity) + BigInt(effect.delta) < 0n) throw new DomainError(409, "INSUFFICIENT_STOCK");
    if (BigInt(quantity) + BigInt(effect.delta) > BigInt(Number.MAX_SAFE_INTEGER)) throw new DomainError(409, "STOCK_OVERFLOW");
  }
}

export async function applyStock(client: PoolClient, tenantId: string, documentId: string, warehouseId: string, effects: StockEffect[]) {
  for (const effect of effects) {
    await client.query("UPDATE stock_balances SET quantity=quantity+$4, updated_at=clock_timestamp() WHERE tenant_id=$1 AND location_id=$2 AND item_id=$3", [tenantId, effect.location_id, effect.item_id, effect.delta]);
    await client.query("INSERT INTO stock_ledger (tenant_id,document_id,warehouse_id,location_id,item_id,quantity_delta) VALUES ($1,$2,$3,$4,$5,$6)", [tenantId, documentId, warehouseId, effect.location_id, effect.item_id, effect.delta]);
  }
}
