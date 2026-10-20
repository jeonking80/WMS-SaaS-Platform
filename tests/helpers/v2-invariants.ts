import { expect } from 'vitest';
import type { PoolClient } from 'pg';
import type { Stock, Count } from '../../src/server/v2/workflow/types';

export type Quantities = { S: number; R: number; P: number; Q: number; B: number; H: number; A: number };

/** Expected quantities in tests come from physical actions, never the WMS response. */
export function quantities(snapshot: { stock: Stock[]; counts: Pick<Count, 'location_id' | 'status'>[] }, itemId: string): Quantities {
  const totals = { S: 0, R: 0, P: 0, Q: 0, B: 0, H: 0, A: 0 };
  for (const stock of snapshot.stock.filter(row => row.item_id === itemId)) {
    const locked = snapshot.counts.some(count => count.location_id === stock.location_id && ['counting', 'submitted'].includes(count.status));
    for (const bucket of ['S', 'R', 'P', 'Q', 'B'] as const) totals[bucket] += stock[bucket];
    totals.H += stock.S + stock.P + stock.Q + stock.B;
    totals.A += locked ? 0 : stock.S - stock.R;
  }
  return totals;
}

/** Read the persisted rows independently of snapshot/reconciliation implementation. */
export async function assertPersistedInvariants(client: PoolClient, warehouseId: string) {
  const invalid = await client.query('SELECT * FROM v2_workflow_stock WHERE warehouse_id=$1 AND (s<0 OR r<0 OR r>s OR p<0 OR q<0 OR b<0)', [warehouseId]);
  expect(invalid.rows).toEqual([]);
  const differences = await client.query(`
    WITH sums AS (
      SELECT tenant_id,warehouse_id,item_id,location_id,
       COALESCE(sum(delta) FILTER (WHERE bucket='S'),0) AS s,
       COALESCE(sum(delta) FILTER (WHERE bucket='R'),0) AS r,
       COALESCE(sum(delta) FILTER (WHERE bucket='P'),0) AS p,
       COALESCE(sum(delta) FILTER (WHERE bucket='Q'),0) AS q,
       COALESCE(sum(delta) FILTER (WHERE bucket='B'),0) AS b
      FROM v2_workflow_ledger WHERE warehouse_id=$1 GROUP BY tenant_id,warehouse_id,item_id,location_id
    ) SELECT s.* FROM v2_workflow_stock s FULL JOIN sums l USING(tenant_id,warehouse_id,item_id,location_id)
      WHERE COALESCE(s.warehouse_id,l.warehouse_id)=$1
      AND (COALESCE(s.s,0)<>COALESCE(l.s,0) OR COALESCE(s.r,0)<>COALESCE(l.r,0)
        OR COALESCE(s.p,0)<>COALESCE(l.p,0) OR COALESCE(s.q,0)<>COALESCE(l.q,0) OR COALESCE(s.b,0)<>COALESCE(l.b,0))`, [warehouseId]);
  expect(differences.rows).toEqual([]);
  const claims = await client.query(`
    WITH claims AS (
      SELECT a.item_id,a.location_id,sum(a.r) AS r,sum(a.p) AS p FROM (
        SELECT (r->>'item_id')::uuid item_id,(r->>'location_id')::uuid location_id,(r->>'quantity')::bigint r,0::bigint p
        FROM v2_workflow_state w CROSS JOIN LATERAL jsonb_array_elements(w.state->'orders') o
        CROSS JOIN LATERAL jsonb_array_elements(o->'reservations') r WHERE w.warehouse_id=$1
        UNION ALL
        SELECT (p->>'item_id')::uuid,(p->>'location_id')::uuid,0::bigint,(p->>'active')::bigint
        FROM v2_workflow_state w CROSS JOIN LATERAL jsonb_array_elements(w.state->'orders') o
        CROSS JOIN LATERAL jsonb_array_elements(o->'picks') p WHERE w.warehouse_id=$1
      ) a GROUP BY a.item_id,a.location_id
    ) SELECT s.item_id FROM (SELECT * FROM v2_workflow_stock WHERE warehouse_id=$1) s
      FULL JOIN claims c USING(item_id,location_id)
      WHERE COALESCE(s.r,0)<>COALESCE(c.r,0) OR COALESCE(s.p,0)<>COALESCE(c.p,0)`, [warehouseId]);
  expect(claims.rows).toEqual([]);

}
