import { DomainError } from "./api";
import { withTenant } from "./db/tenant";
import { literalSearch } from "./queries";
import type { MasterKind } from "./master-data";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function parseMasterSearch(params: URLSearchParams, options = false) {
  const invalid = (): never => { throw new DomainError(400, "INVALID_INPUT"); };
  const integer = (key: string, fallback: number, max: number) => {
    const raw = params.get(key); if (raw === null) return fallback;
    if (!/^[1-9]\d*$/.test(raw)) return invalid();
    const value = Number(raw); if (!Number.isSafeInteger(value) || value > max) return invalid(); return value;
  };
  const q = params.get("q")?.trim() ?? "";
  if (q.length > 100) invalid();
  const active = params.get(options ? "active_only" : "active");
  if (active !== null && active !== "true" && active !== "false") invalid();
  const id = options ? params.get("id") : null;
  const warehouse = params.get("warehouse_id");
  if ((id !== null && !uuid.test(id)) || (warehouse !== null && !uuid.test(warehouse))) invalid();
  return { q, page: integer("page", 1, 2147483647), page_size: integer("page_size", 20, 100), active: options ? (active === "true" ? true : null) : (active === null ? null : active === "true"), id, warehouse };
}
export async function searchMaster(tenant: string, kind: MasterKind, params: URLSearchParams, options = false) {
  const filters = parseMasterSearch(params, options);
  const values: unknown[] = [];
  const clauses: string[] = [];
  const bind = (value: unknown) => { values.push(value); return `$${values.length}`; };
  if (filters.q) { const p = bind(literalSearch(filters.q)); clauses.push(`(code ILIKE ${p} ESCAPE E'\\\\' OR name ILIKE ${p} ESCAPE E'\\\\')`); }
  if (filters.active !== null) clauses.push(`active=${bind(filters.active)}`);
  if (filters.id) clauses.push(`id=${bind(filters.id)}`);
  if (kind === "locations" && filters.warehouse) clauses.push(`warehouse_id=${bind(filters.warehouse)}`);
  const limit = bind(filters.page_size), offset = bind((filters.page - 1) * filters.page_size);
  return withTenant(tenant, async client => {
    const result = await client.query(`WITH filtered AS (SELECT id,code,name,active${kind === "items" ? ",min_stock" : ""}${kind === "locations" ? ",warehouse_id" : ""} FROM ${kind}${clauses.length ? ` WHERE ${clauses.join(" AND ")}` : ""}), page AS (SELECT * FROM filtered ORDER BY code,id LIMIT ${limit} OFFSET ${offset}) SELECT (SELECT count(*)::int FROM filtered) AS total, COALESCE((SELECT json_agg(page ORDER BY code,id) FROM page),'[]'::json) AS rows`, values);
    const { total, rows } = result.rows[0];
    return { [kind]: rows, pagination: { page: filters.page, page_size: filters.page_size, total, total_pages: Math.ceil(total / filters.page_size) } };
  });
}
