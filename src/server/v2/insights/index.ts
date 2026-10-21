import type { Identity } from "../../auth/access";
import { withTenant } from "../../db/tenant";
import { requireV2Access } from "../access";
import { uuid } from "../workflow/engine";
import { nameHistoricalActors } from "../workflow/actor-names";
import type { ActorActivity, DailyOutbound, HourlyFlow, WarehouseInsights } from "./analytics";

export * from "./analytics";
const WINDOW_DAYS = 28;
// Physical flow per ledger effect: received into Q/B, put away into S, picked into P, shipped out of P.
const FLOW_SQL = `CASE WHEN command IN ('receipt.receive','return.receive') AND bucket IN ('Q','B') AND delta>0 THEN 'receive'
 WHEN command IN ('receipt.putaway','return.putaway','stock.putaway') AND bucket='S' AND delta>0 THEN 'putaway'
 WHEN command='order.pick' AND bucket='P' AND delta>0 THEN 'pick'
 WHEN command='shipment.create' AND bucket='P' AND delta<0 THEN 'ship' END`;

/** Read-only ledger aggregates for one warehouse: shipments per Korea business day and today's flow. */
export async function getWarehouseInsights(identity: Identity, warehouseId: string): Promise<WarehouseInsights> {
  uuid(warehouseId);
  await requireV2Access(identity, warehouseId, "read");
  return withTenant(identity.tenant.id, async (client) => {
    const scope = [identity.tenant.id, warehouseId];
    const daily = await client.query<DailyOutbound>(
      `SELECT item_id::text, to_char(created_at AT TIME ZONE 'Asia/Seoul','YYYY-MM-DD') AS day, (-sum(delta))::float8 AS quantity
      FROM v2_workflow_ledger WHERE tenant_id=$1 AND warehouse_id=$2 AND command='shipment.create' AND bucket='P' AND delta<0
      AND created_at>=date_trunc('day', now() AT TIME ZONE 'Asia/Seoul') AT TIME ZONE 'Asia/Seoul' - make_interval(days=>$3::int-1)
      GROUP BY 1,2 ORDER BY 2,1`,
      [...scope, WINDOW_DAYS],
    );
    const today = `created_at>=date_trunc('day', now() AT TIME ZONE 'Asia/Seoul') AT TIME ZONE 'Asia/Seoul'`;
    const hourly = await client.query<HourlyFlow>(
      `SELECT extract(hour FROM created_at AT TIME ZONE 'Asia/Seoul')::int AS hour, ${FLOW_SQL} AS flow, sum(abs(delta))::float8 AS quantity
      FROM v2_workflow_ledger WHERE tenant_id=$1 AND warehouse_id=$2 AND ${today} AND ${FLOW_SQL} IS NOT NULL GROUP BY 1,2 ORDER BY 1,2`,
      scope,
    );
    const actors = await client.query<ActorActivity>(
      `SELECT actor_id, count(DISTINCT request_id)::int AS actions, coalesce(sum(abs(delta)) FILTER (WHERE ${FLOW_SQL} IS NOT NULL),0)::float8 AS quantity
      FROM v2_workflow_ledger WHERE tenant_id=$1 AND warehouse_id=$2 AND ${today} GROUP BY actor_id ORDER BY actions DESC, actor_id LIMIT 20`,
      scope,
    );
    await nameHistoricalActors(client, identity.tenant.id, actors.rows);
    return {
      generated_at: new Date().toISOString(),
      window_days: WINDOW_DAYS,
      daily_outbound: daily.rows,
      hourly: hourly.rows,
      actors: actors.rows,
    };
  });
}
