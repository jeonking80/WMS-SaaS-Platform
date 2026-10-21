import type { PoolClient } from "pg";
import { fail, integer, object, uuid } from "./engine";
import { validateLegacyCorrection } from "./legacy-corrections";
import type { WorkflowState } from "./types";
type Source = {
  id: string;
  item_id: string;
  location_id: string;
  bucket: string;
  delta: string | number;
  request_id: string;
  version: number;
  command: string;
  original_id: string | null;
};
const key = (x: { item_id?: unknown; location_id?: unknown; bucket?: unknown }) =>
  `${x.item_id}:${x.location_id}:${x.bucket}`;
/** A correction compensates a real, unchanged source; inventory differences use location counts. */
export async function validateCorrection(
  client: PoolClient,
  tenantId: string,
  warehouseId: string,
  state: WorkflowState,
  p: Record<string, unknown>,
  approvalId?: string,
) {
  const original = uuid(p.original_id);
  const found = await client.query<Source>(
    `SELECT l.id,l.item_id,l.location_id,l.bucket,l.delta,l.request_id,l.command,l.original_id,(r.response->>'version')::integer AS version FROM v2_workflow_ledger l JOIN v2_workflow_requests r ON r.tenant_id=l.tenant_id AND r.request_id=l.request_id WHERE l.tenant_id=$1 AND l.warehouse_id=$2 AND l.id=$3`,
    [tenantId, warehouseId, original],
  );
  const source = found.rows[0];
  if (!source) {
    await validateLegacyCorrection(client, tenantId, warehouseId, state, p, approvalId);
    return;
  }
  if (source.original_id !== null || !["S", "Q", "B"].includes(source.bucket)) fail("CORRECTION_SOURCE_FORBIDDEN");
  if (
    state.approvals.some(
      (a) => a.type === "correction" && a.target_id === original && a.status === "pending" && a.id !== approvalId,
    )
  )
    fail("CORRECTION_APPROVAL_PENDING");
  const requestRows = (
    await client.query<Source>(
      "SELECT id,item_id,location_id,bucket,delta,request_id FROM v2_workflow_ledger WHERE tenant_id=$1 AND warehouse_id=$2 AND request_id=$3 AND item_id=$4",
      [tenantId, warehouseId, source.request_id, source.item_id],
    )
  ).rows;
  if (requestRows.some((r) => !["S", "Q", "B"].includes(r.bucket))) fail("CORRECTION_REQUIRES_WORKFLOW");
  const net = requestRows.reduce((n, r) => n + Number(r.delta), 0);
  const originals = net === 0 ? requestRows : [source];
  const sourceTotals = new Map<string, number>();
  for (const r of originals) sourceTotals.set(key(r), (sourceTotals.get(key(r)) ?? 0) + Number(r.delta));
  if (!Array.isArray(p.lines) || !p.lines.length || p.lines.length > 20) fail("INVALID_INPUT", 400);
  const desired = new Map<string, number>();
  for (const raw of p.lines) {
    const line = object(raw);
    const q = integer(line.quantity, false, true);
    if (q === 0) fail("INVALID_QUANTITY", 400);
    uuid(line.item_id);
    uuid(line.location_id);
    const k = key(line);
    const sourceQuantity = sourceTotals.get(k);
    if (!sourceQuantity || q * sourceQuantity >= 0) fail("CORRECTION_SOURCE_MISMATCH");
    desired.set(k, (desired.get(k) ?? 0) + q);
  }
  if (net === 0) {
    if (desired.size !== sourceTotals.size || [...sourceTotals.keys()].some((k) => !desired.has(k)))
      fail("CORRECTION_PAIRED_LINES_REQUIRED");
    const first = [...sourceTotals.keys()][0]!;
    const firstDesired = desired.get(first)!;
    const firstOriginal = sourceTotals.get(first)!;
    for (const k of sourceTotals.keys()) {
      const nextDesired = desired.get(k)!;
      const nextOriginal = sourceTotals.get(k)!;
      if (nextDesired * firstOriginal !== firstDesired * nextOriginal) fail("CORRECTION_PAIRED_LINES_REQUIRED");
    }
  }
  const compensated = (
    await client.query<{ item_id: string; location_id: string; bucket: string; delta: string }>(
      "SELECT item_id,location_id,bucket,sum(delta)::text AS delta FROM v2_workflow_ledger WHERE tenant_id=$1 AND warehouse_id=$2 AND original_id=$3 GROUP BY item_id,location_id,bucket",
      [tenantId, warehouseId, original],
    )
  ).rows;
  for (const [k, q] of desired) {
    const originalQuantity = sourceTotals.get(k)!;
    const prior = compensated.filter((r) => key(r) === k).reduce((n, r) => n + Number(r.delta), 0);
    if (Math.abs(prior + q) > Math.abs(originalQuantity)) fail("CORRECTION_LIMIT_EXCEEDED");
  }
  // Later physical/reservation effects require resolving those workflows, not erasing their source.
  const subsequent = await client.query(
    `SELECT l.item_id,l.location_id,l.bucket FROM v2_workflow_ledger l JOIN v2_workflow_requests r ON r.tenant_id=l.tenant_id AND r.request_id=l.request_id WHERE l.tenant_id=$1 AND l.warehouse_id=$2 AND l.item_id=$3 AND (r.response->>'version')::integer>$4 AND l.original_id IS DISTINCT FROM $5`,
    [tenantId, warehouseId, source.item_id, source.version, original],
  );
  const locations = new Set(originals.map((x) => x.location_id));
  if (subsequent.rows.some((x) => locations.has(x.location_id))) fail("CORRECTION_FOLLOWUP_WORK_EXISTS");
}
