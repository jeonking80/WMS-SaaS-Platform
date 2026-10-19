import { createHash } from "node:crypto";
import { DomainError } from "./api";
import { requireRole, type Identity } from "./auth/access";
import { withTenant } from "./db/tenant";
import { documentId, documentVersion } from "./documents";

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
export async function postInbound(identity: Identity, rawId: string, rawVersion: number, rawKey: string): Promise<PostingResponse> {
  requireRole(identity, ["admin", "worker"]);
  const id = documentId(rawId);
  const version = documentVersion(rawVersion);
  const key = idempotencyKey(rawKey);
  const requestHash = createHash("sha256").update(JSON.stringify({ operation: "POST_INBOUND", document_id: id, version })).digest("hex");
  return withTenant(identity.tenant.id, async (client) => {
    const locked = await client.query("SELECT * FROM inventory_documents WHERE id=$1 FOR UPDATE", [id]);
    const document = locked.rows[0];
    if (!document) throw new DomainError(404, "NOT_FOUND");
    // Serialize keys across documents as well as serializing each document itself.
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`${identity.tenant.id}:${key}`]);
    const saved = await client.query("SELECT request_hash, response FROM idempotency_requests WHERE tenant_id=$1 AND key=$2", [identity.tenant.id, key]);
    if (saved.rows[0]) {
      if (saved.rows[0].request_hash !== requestHash) throw new DomainError(409, "IDEMPOTENCY_CONFLICT");
      return saved.rows[0].response as PostingResponse;
    }
    if (document.status !== "DRAFT" || document.kind !== "INBOUND") throw new DomainError(409, "INVALID_STATE");
    if (document.version !== version) throw new DomainError(409, "VERSION_CONFLICT");
    const linesResult = await client.query<{ item_id: string; quantity: number }>("SELECT item_id, quantity FROM inventory_document_lines WHERE document_id=$1 ORDER BY item_id", [id]);
    const lines = linesResult.rows;
    if (lines.length < 1 || lines.length > 20 || new Set(lines.map((line) => line.item_id)).size !== lines.length || lines.some((line) => !Number.isInteger(line.quantity) || line.quantity < 1 || line.quantity > 1_000_000_000)) {
      throw new DomainError(400, "INVALID_INPUT");
    }
    const missing = () => { throw new DomainError(404, "REFERENCE_NOT_FOUND"); };
    const warehouse = await client.query("SELECT id FROM warehouses WHERE id=$1 AND active=true FOR SHARE", [document.warehouse_id]);
    if (!warehouse.rowCount) missing();
    const location = await client.query("SELECT id FROM locations WHERE id=$1 AND warehouse_id=$2 AND active=true FOR SHARE", [document.destination_location_id, document.warehouse_id]);
    if (!location.rowCount) missing();
    for (const line of lines) {
      const item = await client.query("SELECT id FROM items WHERE id=$1 AND active=true FOR SHARE", [line.item_id]);
      if (!item.rowCount) missing();
    }
    // All references are held before balances are created and locked in item order.
    for (const line of lines) {
      await client.query("INSERT INTO stock_balances (tenant_id,warehouse_id,location_id,item_id,quantity) VALUES ($1,$2,$3,$4,0) ON CONFLICT (tenant_id,location_id,item_id) DO NOTHING", [identity.tenant.id, document.warehouse_id, document.destination_location_id, line.item_id]);
      const balance = await client.query("SELECT quantity FROM stock_balances WHERE tenant_id=$1 AND location_id=$2 AND item_id=$3 FOR UPDATE", [identity.tenant.id, document.destination_location_id, line.item_id]);
      if (BigInt(balance.rows[0].quantity) + BigInt(line.quantity) > BigInt(Number.MAX_SAFE_INTEGER)) throw new DomainError(409, "STOCK_OVERFLOW");
      await client.query("UPDATE stock_balances SET quantity=quantity+$4, updated_at=clock_timestamp() WHERE tenant_id=$1 AND location_id=$2 AND item_id=$3", [identity.tenant.id, document.destination_location_id, line.item_id, line.quantity]);
      await client.query("INSERT INTO stock_ledger (tenant_id,document_id,warehouse_id,location_id,item_id,quantity_delta) VALUES ($1,$2,$3,$4,$5,$6)", [identity.tenant.id, id, document.warehouse_id, document.destination_location_id, line.item_id, line.quantity]);
    }
    const updated = await client.query("UPDATE inventory_documents SET status='POSTED',version=version+1,posted_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1 RETURNING id,status,version,posted_at", [id]);
    const posted = updated.rows[0];
    const response: PostingResponse = { document: { ...posted, posted_at: new Date(posted.posted_at).toISOString() }, ledger_entries: lines.length };
    await client.query("INSERT INTO audit_logs (tenant_id,document_id,actor_id,action) VALUES ($1,$2,$3,'POST_INBOUND')", [identity.tenant.id, id, identity.user.id]);
    await client.query("INSERT INTO idempotency_requests (tenant_id,key,request_hash,response) VALUES ($1,$2,$3,$4::jsonb)", [identity.tenant.id, key, requestHash, JSON.stringify(response)]);
    return response;
  });
}
