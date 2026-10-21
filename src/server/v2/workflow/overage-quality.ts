import type { PoolClient } from "pg";
import { fail } from "./engine";
import type { OverageRecovery, WorkflowState } from "./types";
type History = {
  request_id: string;
  command: string;
  evidence: {
    lot_id?: string;
    approval_id?: string;
    lines?: { lot_id?: string; quantity?: number; outcome?: string }[];
  };
  version: number;
};
/** Only immutable work can distinguish an accepted piece held again from unaccepted excess. */
export async function hydrateLegacyOverageQuality(
  client: PoolClient,
  tenant: string,
  warehouse: string,
  state: WorkflowState,
): Promise<OverageRecovery[]> {
  const candidates = [...state.receipts, ...state.returns]
    .flatMap((r) => r.lots)
    .concat(state.holds ?? [])
    .filter((l) => l.overage && l.quality_hold === undefined);
  if (!candidates.length) return [];
  const ids = candidates.map((l) => l.id),
    approvals = state.approvals.filter(
      (a) => a.type === "overage" && ids.includes(a.target_id) && a.status === "approved",
    );
  const history = (
    await client.query<History>(
      `SELECT p.request_id,p.command,p.evidence,(r.response->>'version')::integer AS version
 FROM v2_workflow_performances p JOIN v2_workflow_requests r ON r.tenant_id=p.tenant_id AND r.request_id=p.request_id
 WHERE p.tenant_id=$1 AND p.warehouse_id=$2 AND (
 (p.command='hold.release' AND p.evidence->>'lot_id'=ANY($3::text[])) OR
 (p.command IN ('receipt.inspect','return.inspect','stock.inspect') AND EXISTS(SELECT 1 FROM jsonb_array_elements(p.evidence->'lines') l WHERE l->>'lot_id'=ANY($3::text[]))) OR
 (p.command='approval.decide' AND p.evidence->>'approval_id'=ANY($4::text[])))
 ORDER BY (r.response->>'version')::integer,p.request_id`,
      [tenant, warehouse, ids, approvals.map((a) => a.id)],
    )
  ).rows;
  const repaired: OverageRecovery[] = [];
  for (const lot of candidates) {
    const inspection = history.find(
      (h) => h.command.endsWith(".inspect") && h.evidence.lines?.some((l) => l.lot_id === lot.id),
    );
    if (!inspection) {
      if (
        !Number.isSafeInteger(lot.approved) ||
        !Number.isSafeInteger(lot.released) ||
        lot.approved < 0 ||
        lot.released < 0 ||
        lot.released > lot.approved ||
        lot.approved > lot.quantity
      )
        fail("OVERAGE_HISTORY_REPAIR_REQUIRED");
      lot.quality_hold = 0;
      continue;
    }
    const decisions = history.filter(
      (h) =>
        h.command === "approval.decide" &&
        h.version < inspection.version &&
        approvals.some((a) => a.id === h.evidence.approval_id && a.target_id === lot.id),
    );
    const releases = history.filter(
      (h) => h.command === "hold.release" && h.evidence.lot_id === lot.id && h.version < inspection.version,
    );
    const approved = decisions.reduce(
      (n, h) => n + approvals.find((a) => a.id === h.evidence.approval_id)!.quantity,
      0,
    );
    const released = releases.reduce(
      (n, h) =>
        n + (h.evidence.lines ?? []).filter((l) => l.lot_id === lot.id).reduce((sum, l) => sum + (l.quantity ?? 0), 0),
      0,
    );
    // A primary overage lot can only be inspected after its initial hold has fully left B.
    // Partial releases create separate non-overage lots, so any later hold on this ID is quality.
    if (
      !Number.isSafeInteger(approved) ||
      !Number.isSafeInteger(released) ||
      approved <= 0 ||
      released <= 0 ||
      released > approved ||
      approved > lot.quantity ||
      lot.hold > released ||
      lot.approved < approved ||
      lot.released < released
    )
      fail("OVERAGE_HISTORY_REPAIR_REQUIRED");
    const recovery: OverageRecovery = {
      lot_id: lot.id,
      previous_approved: lot.approved,
      previous_released: lot.released,
      approved,
      released,
      quality_hold: lot.hold,
      first_inspection_request_id: inspection.request_id,
      evidence_request_ids: [...new Set([...decisions, ...releases, inspection].map((h) => h.request_id))],
    };
    lot.approved = approved;
    lot.released = released;
    lot.quality_hold = lot.hold;
    lot.overage_recovery = recovery;
    repaired.push(recovery);
  }
  return repaired;
}
