import { readWorkflowState } from "./object-storage";
import type { Identity } from "../../auth/access";
import { DomainError } from "../../api";
import { withTenant } from "../../db/tenant";
import { requireV2Access } from "../access";
import { emptyState } from "./types";
import { uuid } from "./engine";
import { validateCorrection } from "./corrections";
import { legacyCorrectionSource } from "./legacy-corrections";
import { documentNumberSql } from "../../document-number";
const key = (x: { item_id: string; location_id: string; bucket: string }) =>
  `${x.item_id}:${x.location_id}:${x.bucket}`;
export type CorrectionSourceQuery = { q?: string; item_id?: string; cursor?: string; limit?: number };
const identifier = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
async function legacySources(
  client: import("pg").PoolClient,
  tenant: string,
  warehouse: string,
  query: CorrectionSourceQuery,
) {
  const q = (query.q ?? "").trim(),
    item = query.item_id ?? "",
    limit = query.limit ?? 50;
  if (q.length > 100 || !Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new DomainError(400, "INVALID_INPUT");
  if (item) uuid(item);
  const values: unknown[] = [tenant, warehouse, limit + 1],
    conditions = ["d.tenant_id=$1", "d.warehouse_id=$2", "d.status='POSTED'", "d.posted_at IS NOT NULL"];
  const bind = (value: unknown) => {
    values.push(value);
    return "$" + values.length;
  };
  if (q) {
    const search = bind("%" + q.replace(/[\\%_]/g, "\\$&") + "%");
    conditions.push(
      `(${documentNumberSql("d")} ILIKE ${search} ESCAPE '\\' OR d.document_no::text ILIKE ${search} ESCAPE '\\' OR d.note ILIKE ${search} ESCAPE '\\' OR EXISTS(SELECT 1 FROM inventory_document_lines x JOIN items i ON(i.tenant_id,i.id)=(x.tenant_id,x.item_id) WHERE (x.tenant_id,x.document_id)=(d.tenant_id,d.id) AND (i.code ILIKE ${search} ESCAPE '\\' OR i.name ILIKE ${search} ESCAPE '\\')))`,
    );
  }
  if (item)
    conditions.push(
      `EXISTS(SELECT 1 FROM inventory_document_lines x WHERE(x.tenant_id,x.document_id)=(d.tenant_id,d.id) AND x.item_id=${bind(item)}::uuid)`,
    );
  if (query.cursor) {
    let cursor: { tenant: string; warehouse: string; q: string; item: string; created_at: string; id: string };
    try {
      if (query.cursor.length > 2048) throw Error();
      cursor = JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8"));
      if (
        cursor.tenant !== tenant ||
        cursor.warehouse !== warehouse ||
        cursor.q !== q ||
        cursor.item !== item ||
        !identifier.test(cursor.id) ||
        typeof cursor.created_at !== "string" ||
        !Number.isFinite(Date.parse(cursor.created_at))
      )
        throw Error();
    } catch {
      throw new DomainError(400, "INVALID_CURSOR");
    }
    conditions.push(`(d.posted_at,d.id)<(${bind(cursor.created_at)}::timestamptz,${bind(cursor.id)}::uuid)`);
  }
  const rows = (
    await client.query(
      `SELECT d.id,'legacy' AS kind,d.document_no,${documentNumberSql("d")} AS document_number,d.kind AS document_kind,d.posted_at::text AS created_at FROM inventory_documents d WHERE ${conditions.join(" AND ")} ORDER BY d.posted_at DESC,d.id DESC LIMIT $3`,
      values,
    )
  ).rows;
  const has_more = rows.length > limit,
    sources = rows.slice(0, limit),
    last = sources.at(-1);
  const next_cursor =
    has_more && last
      ? Buffer.from(JSON.stringify({ tenant, warehouse, q, item, created_at: last.created_at, id: last.id })).toString(
          "base64url",
        )
      : null;
  return { sources, next_cursor, has_more };
}
export async function inspectWorkflowCorrectionSource(
  identity: Identity,
  warehouseId: string,
  originalId?: string,
  query: CorrectionSourceQuery = {},
) {
  uuid(warehouseId);
  await requireV2Access(identity, warehouseId, "read");
  return withTenant(identity.tenant.id, async (client) => {
    if (!originalId) return legacySources(client, identity.tenant.id, warehouseId, query);
    const state = (await readWorkflowState(client, identity.tenant.id, warehouseId, "SHARE")) ?? emptyState();
    uuid(originalId);
    let source: { id: string; kind: string; document_no?: unknown; command?: string };
    let lines: { item_id: string; location_id: string; bucket: string; quantity: number }[];
    const row = (
      await client.query(
        "SELECT id,request_id,item_id,location_id,bucket,delta::float8 AS quantity,command FROM v2_workflow_ledger WHERE tenant_id=$1 AND warehouse_id=$2 AND id=$3",
        [identity.tenant.id, warehouseId, originalId],
      )
    ).rows[0];
    let globalLimits: Map<string, number> | undefined;
    if (row) {
      source = { id: row.id, kind: "v2", command: row.command };
      const group = (
        await client.query(
          "SELECT item_id,location_id,bucket,delta::float8 AS quantity FROM v2_workflow_ledger WHERE tenant_id=$1 AND warehouse_id=$2 AND request_id=$3 AND item_id=$4",
          [identity.tenant.id, warehouseId, row.request_id, row.item_id],
        )
      ).rows;
      lines = group.reduce((n, r) => n + r.quantity, 0) === 0 ? group : [row];
    } else {
      const legacy = await legacyCorrectionSource(client, identity.tenant.id, warehouseId, originalId);
      source = { id: legacy.document.id, kind: "legacy", document_no: legacy.document.document_no };
      lines = legacy.lines;
      globalLimits = legacy.limits;
    }
    const grouped = new Map<string, { item_id: string; location_id: string; bucket: string; quantity: number }>();
    for (const l of lines) {
      const existing = grouped.get(key(l));
      grouped.set(key(l), { ...l, quantity: (existing?.quantity ?? 0) + l.quantity });
    }
    lines = [...grouped.values()].filter((l) => l.quantity !== 0);
    const previous = (
      await client.query(
        "SELECT item_id,location_id,bucket,sum(delta)::float8 AS quantity FROM v2_workflow_ledger WHERE tenant_id=$1 AND warehouse_id=$2 AND original_id=$3 GROUP BY item_id,location_id,bucket",
        [identity.tenant.id, warehouseId, source.id],
      )
    ).rows;
    const used = new Map<string, number>();
    for (const p of previous) {
      const scope = p.item_id + ":" + -Math.sign(p.quantity);
      used.set(scope, (used.get(scope) ?? 0) + Math.abs(p.quantity));
    }
    lines = lines
      .map((l) => {
        const prior = previous.filter((p) => key(p) === key(l)).reduce((n, p) => n + Number(p.quantity), 0);
        let remaining = Math.max(0, Math.abs(l.quantity) - Math.abs(prior));
        if (globalLimits) {
          const scope = l.item_id + ":" + Math.sign(l.quantity);
          remaining = Math.min(remaining, Math.max(0, (globalLimits.get(scope) ?? 0) - (used.get(scope) ?? 0)));
          used.set(scope, (used.get(scope) ?? 0) + remaining);
        }
        return { ...l, quantity: -Math.sign(l.quantity) * remaining };
      })
      .filter((l) => l.quantity !== 0);
    let blocked_reason: string | null = null;
    if (!lines.length) blocked_reason = "CORRECTION_LIMIT_EXCEEDED";
    else
      try {
        await validateCorrection(client, identity.tenant.id, warehouseId, state, { original_id: source.id, lines });
      } catch (error) {
        if (error instanceof DomainError) blocked_reason = error.code;
        else throw error;
      }
    return { source, lines, blocked_reason };
  });
}
