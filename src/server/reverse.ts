import { createHash } from "node:crypto";
import { DomainError } from "./api";
import { requireRole, type Identity } from "./auth/access";
import { withTenant } from "./db/tenant";
import { documentId, documentVersion } from "./documents";
import { idempotencyKey } from "./posting";
import { applyStock, lockStock, type StockEffect } from "./stock-transaction";

export type ReversalResponse = {
  document: { id: string; status: "REVERSED"; version: number; reversed_at: string };
  reversal: { id: string; status: "POSTED"; version: 1; posted_at: string };
  ledger_entries: number;
};

export async function reverseDocument(identity: Identity, rawId: string, rawVersion: number, rawKey: string): Promise<ReversalResponse> {
  requireRole(identity, ["admin"]);
  const id = documentId(rawId);
  const version = documentVersion(rawVersion);
  const key = idempotencyKey(rawKey);
  const requestHash = createHash("sha256").update(JSON.stringify({ operation: "REVERSE_DOCUMENT", document_id: id, version })).digest("hex");
  return withTenant(identity.tenant.id, async (client) => {
    await client.query("SET LOCAL lock_timeout = '1000ms'");
    const document = (await client.query("SELECT * FROM inventory_documents WHERE id=$1 FOR UPDATE", [id])).rows[0];
    if (!document) throw new DomainError(404, "NOT_FOUND");
    if (document.reversal_of_id || !["INBOUND", "OUTBOUND", "TRANSFER"].includes(document.kind)) throw new DomainError(409, "INVALID_STATE");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`${identity.tenant.id}:${key}`]);
    const saved = (await client.query("SELECT request_hash, response FROM idempotency_requests WHERE tenant_id=$1 AND key=$2", [identity.tenant.id, key])).rows[0];
    if (saved) {
      if (saved.request_hash !== requestHash) throw new DomainError(409, "IDEMPOTENCY_CONFLICT");
      return saved.response as ReversalResponse;
    }
    if (document.status !== "POSTED") throw new DomainError(409, "INVALID_STATE");
    if (document.version !== version) throw new DomainError(409, "VERSION_CONFLICT");
    const ledger = (await client.query<{ warehouse_id: string; location_id: string; item_id: string; quantity_delta: string }>("SELECT warehouse_id,location_id,item_id,quantity_delta FROM stock_ledger WHERE document_id=$1 ORDER BY location_id,item_id", [id])).rows;
    const invalid = () => { throw new DomainError(409, "INVALID_STATE"); };
    if (ledger.length < 1 || ledger.length > 40) invalid();
    const perItem = new Map<string, Array<{ location_id: string; delta: number }>>();
    const effects: StockEffect[] = ledger.map((entry) => {
      const delta = Number(entry.quantity_delta);
      if (entry.warehouse_id !== document.warehouse_id || !Number.isInteger(delta) || delta === 0 || Math.abs(delta) > 1_000_000_000) invalid();
      const legs = perItem.get(entry.item_id) ?? [];
      legs.push({ location_id: entry.location_id, delta });
      perItem.set(entry.item_id, legs);
      return { location_id: entry.location_id, item_id: entry.item_id, delta: -delta };
    });
    if (perItem.size > 20) invalid();
    for (const legs of perItem.values()) {
      if (document.kind === "TRANSFER") {
        const source = legs.find((leg) => leg.location_id === document.source_location_id);
        const destination = legs.find((leg) => leg.location_id === document.destination_location_id);
        if (legs.length !== 2 || document.source_location_id === document.destination_location_id || !source || !destination || source.delta >= 0 || destination.delta !== -source.delta) invalid();
      } else if (legs.length !== 1 || (document.kind === "INBOUND" ? legs[0].delta <= 0 || legs[0].location_id !== document.destination_location_id : legs[0].delta >= 0 || legs[0].location_id !== document.source_location_id)) invalid();
    }
    await lockStock(client, identity.tenant.id, document.warehouse_id, effects, false);
    const kind = document.kind === "TRANSFER" ? "TRANSFER" : document.kind === "INBOUND" ? "OUTBOUND" : "INBOUND";
    const reversal = (await client.query("INSERT INTO inventory_documents (tenant_id,kind,warehouse_id,source_location_id,destination_location_id,note,status,version,posted_at,reversal_of_id) VALUES ($1,$2,$3,$4,$5,$6,'POSTED',1,clock_timestamp(),$7) RETURNING id,status,version,posted_at", [identity.tenant.id, kind, document.warehouse_id, document.destination_location_id, document.source_location_id, `Automatic reversal of ${id}`, id])).rows[0];
    for (const itemId of [...perItem.keys()].sort()) {
      const quantity = Math.abs(perItem.get(itemId)![0].delta);
      await client.query("INSERT INTO inventory_document_lines (tenant_id,document_id,item_id,quantity) VALUES ($1,$2,$3,$4)", [identity.tenant.id, reversal.id, itemId, quantity]);
    }
    await applyStock(client, identity.tenant.id, reversal.id, document.warehouse_id, effects);
    const original = (await client.query("UPDATE inventory_documents SET status='REVERSED',version=version+1,reversed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1 RETURNING id,status,version,reversed_at", [id])).rows[0];
    const response: ReversalResponse = {
      document: { ...original, reversed_at: new Date(original.reversed_at).toISOString() },
      reversal: { ...reversal, posted_at: new Date(reversal.posted_at).toISOString() },
      ledger_entries: effects.length,
    };
    await client.query("INSERT INTO audit_logs (tenant_id,document_id,actor_id,action) VALUES ($1,$2,$3,$4)", [identity.tenant.id, id, identity.user.id, "REVERSE_DOCUMENT"]);
    await client.query("INSERT INTO idempotency_requests (tenant_id,key,request_hash,response) VALUES ($1,$2,$3,$4::jsonb)", [identity.tenant.id, key, requestHash, JSON.stringify(response)]);
    return response;
  });
}
