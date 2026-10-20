import { withRequestLog } from "@/server/request-log";
import { getPool } from "@/server/db/pool";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function handleGET() {
  try {
    await getPool().query("SELECT id FROM tenants LIMIT 1");
    // Resolve required columns and application SELECT privileges without exposing rows.
    await getPool().query(`SELECT t.idle_lock_minutes,s.last_protected_at,w.version,
      k.environment,l.token_hash,m.barcode,c.snapshot_hash,e.event_id,a.request_id,o.phase
      FROM tenants t,"session" s,v2_workflow_state w,v2_machine_keys k,
      v2_identity_links l,master_barcodes m,v2_cutovers c,
      v2_integration_events e,api_request_metrics a,v2_opening_imports o WHERE false`);
    return Response.json({ status: "ok", database: "ok" }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json(
      { status: "unavailable", database: "unavailable" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}

export const GET = withRequestLog("ready", handleGET);
