import { apiError, json } from "./api";
import { requireIdentity } from "./auth/access";
import { withTenant } from "./db/tenant";

export type Dashboard = {
  timezone: "Asia/Seoul";
  as_of: string;
  metrics: { stocked_items: number; today_inbound: number; today_outbound: number; today_reversals: number; pending_outbound: number; low_stock_items: number };
  daily: { date: string; inbound: number; outbound: number; reversals: number }[];
  low_stock: { id: string; code: string; name: string; min_stock: string; quantity: string }[];
  recent: { id: string; kind: string; status: string; posted_at: string | null; reversed_at: string | null; reversal_of_id: string | null }[];
};

/** A single statement gives every aggregate the same PostgreSQL snapshot. */
export async function getDashboard(tenantId: string, now = new Date()): Promise<Dashboard> {
  const asOf = now.toISOString();
  return withTenant(tenantId, async client => {
    const result = await client.query<{ dashboard: Dashboard }>(`
      WITH clock AS (SELECT ($1::timestamptz AT TIME ZONE 'Asia/Seoul')::date AS today),
      balances AS (SELECT item_id, sum(quantity) AS quantity FROM stock_balances GROUP BY item_id),
      shortages AS (
        SELECT i.id,i.code,i.name,i.min_stock::text,COALESCE(b.quantity,0)::text AS quantity
        FROM items i LEFT JOIN balances b ON b.item_id=i.id
        WHERE i.active AND COALESCE(b.quantity,0)<i.min_stock
      ),
      days AS (SELECT today - n AS day FROM clock CROSS JOIN generate_series(0,6) n),
      daily AS (
        SELECT day,
          (SELECT count(*)::int FROM inventory_documents WHERE reversal_of_id IS NULL AND status IN ('POSTED','REVERSED') AND kind='INBOUND'
            AND posted_at >= day::timestamp AT TIME ZONE 'Asia/Seoul' AND posted_at < (day+1)::timestamp AT TIME ZONE 'Asia/Seoul') AS inbound,
          (SELECT count(*)::int FROM inventory_documents WHERE reversal_of_id IS NULL AND status IN ('POSTED','REVERSED') AND kind='OUTBOUND'
            AND posted_at >= day::timestamp AT TIME ZONE 'Asia/Seoul' AND posted_at < (day+1)::timestamp AT TIME ZONE 'Asia/Seoul') AS outbound,
          (SELECT count(*)::int FROM inventory_documents WHERE reversal_of_id IS NULL AND status='REVERSED'
            AND reversed_at >= day::timestamp AT TIME ZONE 'Asia/Seoul' AND reversed_at < (day+1)::timestamp AT TIME ZONE 'Asia/Seoul') AS reversals
        FROM days
      )
      SELECT jsonb_build_object(
        'timezone','Asia/Seoul','as_of',$1::text,
        'metrics',jsonb_build_object(
          'stocked_items',(SELECT count(*)::int FROM balances WHERE quantity>0),
          'today_inbound',(SELECT inbound FROM daily,clock WHERE day=today),
          'today_outbound',(SELECT outbound FROM daily,clock WHERE day=today),
          'today_reversals',(SELECT reversals FROM daily,clock WHERE day=today),
          'pending_outbound',(SELECT count(*)::int FROM inventory_documents WHERE kind='OUTBOUND' AND status='DRAFT'),
          'low_stock_items',(SELECT count(*)::int FROM shortages)),
        'daily',(SELECT jsonb_agg(jsonb_build_object('date',to_char(day,'YYYY-MM-DD'),'inbound',inbound,'outbound',outbound,'reversals',reversals) ORDER BY day) FROM daily),
        'low_stock',COALESCE((SELECT jsonb_agg(to_jsonb(s) ORDER BY s.code,s.id) FROM (SELECT * FROM shortages ORDER BY code,id LIMIT 20) s),'[]'::jsonb),
        'recent',COALESCE((SELECT jsonb_agg(to_jsonb(r) ORDER BY COALESCE(r.reversed_at,r.posted_at) DESC,r.id DESC)
          FROM (SELECT id,kind,status,posted_at,reversed_at,reversal_of_id FROM inventory_documents WHERE status IN ('POSTED','REVERSED') ORDER BY COALESCE(reversed_at,posted_at) DESC NULLS LAST,id DESC LIMIT 10) r),'[]'::jsonb)
      ) AS dashboard`, [asOf]);
    return { ...result.rows[0].dashboard, as_of: asOf };
  });
}

export async function dashboardRequest(request: Request) {
  try {
    const identity = await requireIdentity(request.headers);
    return json(await getDashboard(identity.tenant.id));
  } catch (error) { return apiError(error); }
}
