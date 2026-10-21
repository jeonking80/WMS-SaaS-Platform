import type { PoolClient } from "pg";
import type { WorkflowState } from "./types";

type ActorRecord = {
  actor_id?: string;
  actor_name?: string;
  requester_id?: string;
  requester_name?: string;
  decider_id?: string;
  decider_name?: string;
  assignee_id?: string;
  assignee_name?: string;
};
/** Resolve only actors already present in authorized warehouse results. Preserved
 * current names identify history; these are not names snapshotted at event time.
 * Neither membership status nor key revocation removes historical identification.
 */
export async function nameHistoricalActors(client: PoolClient, tenantId: string, records: ActorRecord[]) {
  const fields = [
    ["actor_id", "actor_name"],
    ["requester_id", "requester_name"],
    ["decider_id", "decider_name"],
    ["assignee_id", "assignee_name"],
  ] as const;
  const ids = [
    ...new Set(
      records.flatMap((row) =>
        fields.map(([id]) => row[id]).filter((id): id is string => typeof id === "string" && id.length > 0),
      ),
    ),
  ];
  if (!ids.length) return;
  const names = (
    await client.query<{ id: string; name: string }>(
      `SELECT m.user_id AS id,u.name FROM memberships m JOIN "user" u ON u.id=m.user_id WHERE m.tenant_id=$1 AND m.user_id=ANY($2::text[])
 UNION ALL SELECT 'machine:'||k.id::text AS id,k.name FROM v2_machine_keys k WHERE k.tenant_id=$1 AND ('machine:'||k.id::text)=ANY($2::text[])`,
      [tenantId, ids],
    )
  ).rows;
  const byId = new Map(names.map((row) => [row.id, row.name]));
  for (const row of records)
    for (const [id, name] of fields) {
      const value = row[id];
      if (value && byId.has(value)) row[name] = byId.get(value);
    }
}
export async function nameSnapshotActors(client: PoolClient, tenantId: string, state: WorkflowState) {
  const shifts = state.shifts.flatMap(
    (shift) => [shift, ...(Array.isArray(shift.handover) ? shift.handover : [])] as ActorRecord[],
  );
  await nameHistoricalActors(client, tenantId, [
    ...state.ledger,
    ...state.approvals,
    ...state.tasks,
    ...state.counts,
    ...state.shipments.flatMap((shipment) => shipment.events),
    ...shifts,
  ]);
}
