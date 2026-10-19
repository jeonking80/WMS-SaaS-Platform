import type { PoolClient } from "pg";
import { DomainError } from "./api";
import { withTenant } from "./db/tenant";

export type DocumentKind = "INBOUND" | "OUTBOUND" | "TRANSFER";
export type DocumentInput = {
  kind: DocumentKind; warehouse_id: string; source_location_id: string | null;
  destination_location_id: string | null; note: string;
  lines: { item_id: string; quantity: number }[];
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function invalid(): never { throw new DomainError(400, "INVALID_INPUT"); }
function identifier(value: unknown): string {
  if (typeof value !== "string" || !uuid.test(value)) return invalid();
  return value.toLowerCase();
}
export function documentId(value: string): string {
  if (!uuid.test(value)) throw new DomainError(404, "NOT_FOUND");
  return value.toLowerCase();
}
export function documentVersion(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 2147483646) return invalid();
  return value;
}
export function parseDocument(body: Record<string, unknown>): DocumentInput {
  if (!["INBOUND", "OUTBOUND", "TRANSFER"].includes(body.kind as string)) return invalid();
  const kind = body.kind as DocumentKind;
  const warehouse_id = identifier(body.warehouse_id);
  const source_location_id = body.source_location_id == null ? null : identifier(body.source_location_id);
  const destination_location_id = body.destination_location_id == null ? null : identifier(body.destination_location_id);
  if (kind === "INBOUND" && (source_location_id || !destination_location_id)) return invalid();
  if (kind === "OUTBOUND" && (!source_location_id || destination_location_id)) return invalid();
  if (kind === "TRANSFER" && (!source_location_id || !destination_location_id || source_location_id === destination_location_id)) return invalid();
  const note = body.note === undefined ? "" : body.note;
  if (typeof note !== "string" || note.length > 2000) return invalid();
  if (!Array.isArray(body.lines) || body.lines.length < 1 || body.lines.length > 20) return invalid();
  const lines = body.lines.map((line: unknown) => {
    if (!line || typeof line !== "object" || Array.isArray(line)) return invalid();
    const row = line as Record<string, unknown>;
    const item_id = identifier(row.item_id);
    if (typeof row.quantity !== "number" || !Number.isInteger(row.quantity) || row.quantity < 1 || row.quantity > 1_000_000_000) return invalid();
    return { item_id, quantity: row.quantity };
  });
  if (new Set(lines.map((line) => line.item_id)).size !== lines.length) return invalid();
  return { kind, warehouse_id, source_location_id, destination_location_id, note, lines };
}
async function references(client: PoolClient, input: DocumentInput) {
  const missing = () => { throw new DomainError(404, "REFERENCE_NOT_FOUND"); };
  const warehouse = await client.query("SELECT id FROM warehouses WHERE id = $1 AND active = true FOR SHARE", [input.warehouse_id]);
  if (!warehouse.rowCount) missing();
  for (const id of [input.source_location_id, input.destination_location_id].filter((id): id is string => id !== null).sort()) {
    const location = await client.query("SELECT id FROM locations WHERE id = $1 AND warehouse_id = $2 AND active = true FOR SHARE", [id, input.warehouse_id]);
    if (!location.rowCount) missing();
  }
  for (const id of input.lines.map((line) => line.item_id).sort()) {
    const item = await client.query("SELECT id FROM items WHERE id = $1 AND active = true FOR SHARE", [id]);
    if (!item.rowCount) missing();
  }
}
async function detail(client: PoolClient, id: string) {
  const result = await client.query("SELECT * FROM inventory_documents WHERE id = $1 FOR SHARE", [id]);
  if (!result.rows[0]) throw new DomainError(404, "NOT_FOUND");
  const lines = await client.query("SELECT id, tenant_id, document_id, item_id, quantity FROM inventory_document_lines WHERE document_id = $1 ORDER BY item_id, id", [id]);
  return { ...result.rows[0], lines: lines.rows };
}
async function addLines(client: PoolClient, tenantId: string, id: string, input: DocumentInput) {
  for (const line of input.lines) {
    await client.query("INSERT INTO inventory_document_lines (tenant_id, document_id, item_id, quantity) VALUES ($1, $2, $3, $4)", [tenantId, id, line.item_id, line.quantity]);
  }
}
export function listDocuments(tenantId: string) {
  return withTenant(tenantId, async (client) => (await client.query("SELECT * FROM inventory_documents ORDER BY updated_at DESC, id DESC LIMIT 100")).rows);
}
export function getDocument(tenantId: string, id: string) {
  return withTenant(tenantId, (client) => detail(client, documentId(id)));
}
export function createDocument(tenantId: string, input: DocumentInput) {
  return withTenant(tenantId, async (client) => {
    await references(client, input);
    const result = await client.query("INSERT INTO inventory_documents (tenant_id, kind, warehouse_id, source_location_id, destination_location_id, note) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id", [tenantId, input.kind, input.warehouse_id, input.source_location_id, input.destination_location_id, input.note]);
    const id = result.rows[0].id as string;
    await addLines(client, tenantId, id, input);
    return detail(client, id);
  });
}
export function updateDocument(tenantId: string, rawId: string, version: number, input?: DocumentInput) {
  const id = documentId(rawId);
  return withTenant(tenantId, async (client) => {
    const result = await client.query("SELECT version, status FROM inventory_documents WHERE id = $1 FOR UPDATE", [id]);
    const row = result.rows[0];
    if (!row) throw new DomainError(404, "NOT_FOUND");
    if (row.version !== version) throw new DomainError(409, "VERSION_CONFLICT");
    if (row.status !== "DRAFT") throw new DomainError(409, "INVALID_STATE");
    if (input) {
      await references(client, input);
      await client.query("UPDATE inventory_documents SET kind=$2, warehouse_id=$3, source_location_id=$4, destination_location_id=$5, note=$6, version=version+1, updated_at=clock_timestamp() WHERE id=$1", [id, input.kind, input.warehouse_id, input.source_location_id, input.destination_location_id, input.note]);
      await client.query("DELETE FROM inventory_document_lines WHERE document_id=$1", [id]);
      await addLines(client, tenantId, id, input);
    } else {
      await client.query("UPDATE inventory_documents SET status='CANCELLED', version=version+1, updated_at=clock_timestamp() WHERE id=$1", [id]);
    }
    return detail(client, id);
  });
}
