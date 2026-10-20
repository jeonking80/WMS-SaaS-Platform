import { DomainError } from "./api";
import { withTenant } from "./db/tenant";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export type QueryFilters = { page: number; page_size: number; q?: string; warehouse_id?: string; location_id?: string; item_id?: string; document_id?: string; kind?: string; status?: string; action?: string; date_from?: string; date_to?: string; date_field: "created_at" | "posted_at" | "reversed_at" };
function invalid(): never { throw new DomainError(400, "INVALID_INPUT"); }
export function parseQuery(params: URLSearchParams): QueryFilters {
  const integer = (key: string, fallback: number, max: number) => {
    const raw = params.get(key);
    if (raw === null) return fallback;
    if (!/^[1-9]\d*$/.test(raw)) return invalid();
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value > max) return invalid();
    return value;
  };
  const result: QueryFilters = { page: integer("page", 1, 2147483647), page_size: integer("page_size", 25, 100), date_field: "created_at" };
  for (const key of ["warehouse_id", "location_id", "item_id", "document_id"] as const) {
    const raw = params.get(key);
    if (raw !== null) { if (!uuid.test(raw)) invalid(); result[key] = raw.toLowerCase(); }
  }
  const q = params.get("q")?.trim();
  if (q && q.length > 100) invalid();
  if (q) result.q = q;
  for (const [key, values] of [["kind", ["INBOUND", "OUTBOUND", "TRANSFER"]], ["status", ["DRAFT", "CANCELLED", "POSTED", "REVERSED"]], ["date_field", ["created_at", "posted_at", "reversed_at"]]] as const) {
    const raw = params.get(key);
    if (raw !== null) { if (!(values as readonly string[]).includes(raw)) invalid(); Object.assign(result, { [key]: raw }); }
  }
  for (const key of ["date_from", "date_to"] as const) {
    const raw = params.get(key);
    if (raw !== null) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(raw) || raw < "0001-01-01" || !Number.isFinite(Date.parse(raw)) || new Date(raw).toISOString().slice(0, 10) !== raw) invalid();
      result[key] = raw;
    }
  }
  if (result.date_from && result.date_to && result.date_from > result.date_to) invalid();
  const action = params.get("action");
  if (action !== null) { if (!/^[A-Z_]{1,50}$/.test(action)) invalid(); result.action = action; }
  return result;
}
export function literalSearch(value: string) { return `%${value.replace(/[\\%_]/g, "\\$&")}%`; }
class Conditions {
  values: unknown[] = [];
  clauses: string[] = [];
  bind(value: unknown) { this.values.push(value); return `$${this.values.length}`; }
  equal(column: string, value?: string) { if (value) this.clauses.push(`${column} = ${this.bind(value)}`); }
  dates(column: string, filters: QueryFilters) {
    if (filters.date_from) this.clauses.push(`${column} >= (${this.bind(filters.date_from)}::date::timestamp AT TIME ZONE 'Asia/Seoul')`);
    if (filters.date_to) this.clauses.push(`${column} < ((${this.bind(filters.date_to)}::date + 1)::timestamp AT TIME ZONE 'Asia/Seoul')`);
  }
  search(columns: string[], q?: string) { if (q) { const p = this.bind(literalSearch(q)); this.clauses.push(`(${columns.map(column => `${column} ILIKE ${p} ESCAPE E'\\\\'`).join(" OR ")})`); } }
  where() { return this.clauses.length ? ` WHERE ${this.clauses.join(" AND ")}` : ""; }
}
async function paged(tenant: string, select: string, conditions: Conditions, order: string, filters: QueryFilters, key: string) {
  const limit = conditions.bind(filters.page_size);
  const offset = conditions.bind((filters.page - 1) * filters.page_size);
  return withTenant(tenant, async client => {
    // The count and ordered page share one statement and therefore one MVCC snapshot.
    const result = await client.query(`WITH filtered AS (${select}${conditions.where()}), page AS (SELECT * FROM filtered ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}) SELECT (SELECT count(*)::int FROM filtered) AS total, COALESCE((SELECT json_agg(page ORDER BY ${order}) FROM page), '[]'::json) AS rows`, conditions.values);
    const { total, rows } = result.rows[0];
    return { [key]: rows, pagination: { page: filters.page, page_size: filters.page_size, total, total_pages: Math.ceil(total / filters.page_size) } };
  });
}
export function pagedDocuments(tenant: string, filters: QueryFilters, history = false) {
  const c = new Conditions();
  if (history) {
    if (filters.status && !["POSTED", "REVERSED"].includes(filters.status)) throw new DomainError(403, "ROLE_FORBIDDEN");
    c.clauses.push("d.status IN ('POSTED','REVERSED')");
  }
  c.equal("d.warehouse_id", filters.warehouse_id); c.equal("d.kind", filters.kind); c.equal("d.status", filters.status);
  if (filters.location_id) { const p = c.bind(filters.location_id); c.clauses.push(`(d.source_location_id=${p} OR d.destination_location_id=${p})`); }
  if (filters.item_id) c.clauses.push(`EXISTS (SELECT 1 FROM inventory_document_lines dl WHERE (dl.tenant_id,dl.document_id)=(d.tenant_id,d.id) AND dl.item_id=${c.bind(filters.item_id)})`);
  if (filters.q) {
    const p = c.bind(literalSearch(filters.q));
    c.clauses.push(`(d.id::text ILIKE ${p} ESCAPE E'\\\\' OR d.note ILIKE ${p} ESCAPE E'\\\\' OR EXISTS (SELECT 1 FROM inventory_document_lines dl JOIN items i ON (i.tenant_id,i.id)=(dl.tenant_id,dl.item_id) WHERE (dl.tenant_id,dl.document_id)=(d.tenant_id,d.id) AND (i.code ILIKE ${p} ESCAPE E'\\\\' OR i.name ILIKE ${p} ESCAPE E'\\\\')))`);
  }
  c.dates(`d.${filters.date_field}`, filters);
  return paged(tenant, `SELECT d.*, w.name AS warehouse_name, sl.code AS source_location_code, dl.code AS destination_location_code, r.id AS reversal_document_id FROM inventory_documents d JOIN warehouses w ON (w.tenant_id,w.id)=(d.tenant_id,d.warehouse_id) LEFT JOIN locations sl ON (sl.tenant_id,sl.id)=(d.tenant_id,d.source_location_id) LEFT JOIN locations dl ON (dl.tenant_id,dl.id)=(d.tenant_id,d.destination_location_id) LEFT JOIN inventory_documents r ON (r.tenant_id,r.reversal_of_id)=(d.tenant_id,d.id)`, c, "created_at DESC, id DESC", filters, "documents");
}
const stockJoins = ` JOIN warehouses w ON (w.tenant_id,w.id)=(s.tenant_id,s.warehouse_id) JOIN locations l ON (l.tenant_id,l.id)=(s.tenant_id,s.location_id) JOIN items i ON (i.tenant_id,i.id)=(s.tenant_id,s.item_id)`;
export function pagedStock(tenant: string, filters: QueryFilters) {
  const c = new Conditions();
  c.equal("s.warehouse_id", filters.warehouse_id); c.equal("s.location_id", filters.location_id); c.equal("s.item_id", filters.item_id); c.search(["i.code", "i.name"], filters.q);
  return paged(tenant, `SELECT s.warehouse_id,w.name AS warehouse_name,s.location_id,l.code AS location_code,s.item_id,i.code AS item_code,i.name AS item_name,s.quantity::text FROM stock_balances s${stockJoins}`, c, "warehouse_name, location_code, item_code, location_id, item_id", filters, "stock");
}
export function pagedLedger(tenant: string, filters: QueryFilters) {
  const c = new Conditions();
  c.equal("s.warehouse_id", filters.warehouse_id); c.equal("s.location_id", filters.location_id); c.equal("s.item_id", filters.item_id); c.equal("d.kind", filters.kind); c.equal("d.status", filters.status); c.equal("s.document_id", filters.document_id);
  c.dates("s.created_at", filters); c.search(["i.code", "i.name", "s.document_id::text"], filters.q);
  return paged(tenant, `SELECT s.id,s.document_id,s.warehouse_id,s.location_id,s.item_id,w.name AS warehouse_name,l.code AS location_code,i.code AS item_code,i.name AS item_name,s.quantity_delta::text,s.created_at,d.kind,d.status,d.reversal_of_id FROM stock_ledger s${stockJoins} JOIN inventory_documents d ON (d.tenant_id,d.id)=(s.tenant_id,s.document_id)`, c, "created_at DESC, id DESC", filters, "entries");
}
export function pagedAuditLogs(tenant: string, filters: QueryFilters) {
  const c = new Conditions();
  c.equal("a.document_id", filters.document_id); c.equal("a.action", filters.action); c.dates("a.created_at", filters); c.search(["a.document_id::text", "a.action", "u.name"], filters.q);
  return paged(tenant, `SELECT a.id,a.document_id,a.actor_id,u.name AS actor_name,a.action,a.created_at FROM audit_logs a JOIN "user" u ON u.id=a.actor_id`, c, "created_at DESC, id DESC", filters, "entries");
}
export function listLookups(tenant: string) {
  return withTenant(tenant, async client => {
    const warehouses = await client.query("SELECT id,code,name,active FROM warehouses ORDER BY code,id LIMIT 1000");
    const locations = await client.query("SELECT id,warehouse_id,code,name,active FROM locations ORDER BY code,id LIMIT 1000");
    return { warehouses: warehouses.rows, locations: locations.rows };
  });
}
