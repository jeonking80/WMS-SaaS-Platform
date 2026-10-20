import { createHash } from "node:crypto";
import { DomainError } from "./api";
import { requireRole, type Identity } from "./auth/access";
import { withTenant } from "./db/tenant";
import { documentId, documentVersion } from "./documents";
import { lockStock, applyStock, type StockEffect } from "./stock-transaction";

export type PostingResponse = {
  document: { id: string; status: "POSTED"; version: number; posted_at: string };
  ledger_entries: number;
};

export function idempotencyKey(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(value)) {
    throw new DomainError(400, "INVALID_INPUT");
  }
  return value;
}

/** The document and every stock effect commit with the saved response. */
async function post(identity: Identity, rawId: string, rawVersion: number, rawKey: string, inboundOnly: boolean): Promise<PostingResponse> {
  requireRole(identity, ["admin", "worker"]);
  const id = documentId(rawId);
  const version = documentVersion(rawVersion);
  const key = idempotencyKey(rawKey);
  return withTenant(identity.tenant.id, async (client) => {
    await client.query("SET LOCAL lock_timeout = '1000ms'");
    const locked = await client.query("SELECT * FROM inventory_documents WHERE id=$1 FOR UPDATE", [id]);
    const document = locked.rows[0];
    if (!document) throw new DomainError(404, "NOT_FOUND");
    if ((inboundOnly && document.kind !== "INBOUND") || !["INBOUND", "OUTBOUND", "TRANSFER"].includes(document.kind) || document.reversal_of_id) throw new DomainError(409, "INVALID_STATE");
    const outbound = document.kind === "OUTBOUND";
    const operation = document.kind === "TRANSFER" ? "POST_TRANSFER" : outbound ? "POST_OUTBOUND" : "POST_INBOUND";
    // Retain the P3 inbound hash contract so already committed keys remain replayable.
    const requestHash = createHash("sha256").update(JSON.stringify({ operation, document_id: id, version })).digest("hex");
    // Serialize keys across documents as well as serializing each document itself.
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`${identity.tenant.id}:${key}`]);
    const saved = await client.query("SELECT request_hash, response FROM idempotency_requests WHERE tenant_id=$1 AND key=$2", [identity.tenant.id, key]);
    if (saved.rows[0]) {
      if (saved.rows[0].request_hash !== requestHash) throw new DomainError(409, "IDEMPOTENCY_CONFLICT");
      return saved.rows[0].response as PostingResponse;
    }
    if (document.status !== "DRAFT") throw new DomainError(409, "INVALID_STATE");
    if (document.version !== version) throw new DomainError(409, "VERSION_CONFLICT");
    if (outbound && (typeof document.recipient_name !== "string" || !document.recipient_name.trim() || typeof document.delivery_address !== "string" || !document.delivery_address.trim())) {
      throw new DomainError(400, "DELIVERY_REQUIRED");
    }
    const linesResult = await client.query<{ item_id: string; quantity: number }>("SELECT item_id, quantity FROM inventory_document_lines WHERE document_id=$1 ORDER BY item_id", [id]);
    const lines = linesResult.rows;
    if (lines.length < 1 || lines.length > 20 || new Set(lines.map((line) => line.item_id)).size !== lines.length || lines.some((line) => !Number.isInteger(line.quantity) || line.quantity < 1 || line.quantity > 1_000_000_000)) {
      throw new DomainError(400, "INVALID_INPUT");
    }
    if (document.kind === "TRANSFER" && (!document.source_location_id || !document.destination_location_id || document.source_location_id === document.destination_location_id)) throw new DomainError(409, "INVALID_STATE");
    const effects: StockEffect[] = lines.flatMap((line) => [
      ...(document.kind !== "INBOUND" ? [{ location_id: document.source_location_id, item_id: line.item_id, delta: -line.quantity }] : []),
      ...(document.kind !== "OUTBOUND" ? [{ location_id: document.destination_location_id, item_id: line.item_id, delta: line.quantity }] : []),
    ]);
    await lockStock(client, identity.tenant.id, document.warehouse_id, effects, true);
    await applyStock(client, identity.tenant.id, id, document.warehouse_id, effects);
    const updated = await client.query("UPDATE inventory_documents SET status='POSTED',version=version+1,posted_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1 RETURNING id,status,version,posted_at", [id]);
    const posted = updated.rows[0];
    const response: PostingResponse = { document: { ...posted, posted_at: new Date(posted.posted_at).toISOString() }, ledger_entries: effects.length };
    await client.query("INSERT INTO audit_logs (tenant_id,document_id,actor_id,action) VALUES ($1,$2,$3,$4)", [identity.tenant.id, id, identity.user.id, operation]);
    await client.query("INSERT INTO idempotency_requests (tenant_id,key,request_hash,response) VALUES ($1,$2,$3,$4::jsonb)", [identity.tenant.id, key, requestHash, JSON.stringify(response)]);
    return response;
  });
}

/** Post either supported document kind using its locked, persisted identity. */
export function postDocument(identity: Identity, id: string, version: number, key: string): Promise<PostingResponse> {
  return post(identity, id, version, key, false);
}

/** Compatibility entry point for inbound-only callers. */
export function postInbound(identity: Identity, id: string, version: number, key: string): Promise<PostingResponse> {
  return post(identity, id, version, key, true);
}
