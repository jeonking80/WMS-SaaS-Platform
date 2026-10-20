import { searchMaster } from "./master-search";
import type { PoolClient } from "pg";
import { DomainError, apiError, json, readBody, requireMutationOrigin } from "./api";
import { requireIdentity, requireRole } from "./auth/access";
import { withTenant } from "./db/tenant";

export type MasterKind = "items" | "warehouses" | "locations";
const singular = { items: "item", warehouses: "warehouse", locations: "location" };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function validateMasterInput(body: Record<string, unknown>, kind: MasterKind, patch = false) {
  const allowed = patch ? ["code", "name", "active"] : ["code", "name", ...(kind === "locations" ? ["warehouse_id"] : [])];
  if (kind === "items") allowed.push("min_stock");
  if (Object.keys(body).some((key) => !allowed.includes(key)) || (patch && !Object.keys(body).length)) throw new DomainError(400, "INVALID_INPUT");
  const result: Record<string, string | boolean | number> = {};
  for (const key of ["code", "name"] as const) {
    if (patch && !(key in body)) continue;
    if (typeof body[key] !== "string") throw new DomainError(400, "INVALID_INPUT");
    const value = key === "code" ? body[key].trim().toUpperCase() : body[key].trim();
    if (!value.length || value.length > (key === "code" ? 64 : 128)) throw new DomainError(400, "INVALID_INPUT");
    result[key] = value;
  }
  if ("active" in body) {
    if (typeof body.active !== "boolean") throw new DomainError(400, "INVALID_INPUT");
    result.active = body.active;
  }
  if (!patch && kind === "locations") {
    if (typeof body.warehouse_id !== "string" || !uuid.test(body.warehouse_id)) throw new DomainError(400, "INVALID_INPUT");
    result.warehouse_id = body.warehouse_id;
  }
  if ("min_stock" in body) {
    if (typeof body.min_stock !== "number" || !Number.isInteger(body.min_stock) || body.min_stock < 0 || body.min_stock > 1_000_000_000) throw new DomainError(400, "INVALID_INPUT");
    result.min_stock = body.min_stock;
  }
  return result;
}
function columns(kind: MasterKind) {
  return `id, code, name, active${kind === "items" ? ", min_stock" : ""}${kind === "locations" ? ", warehouse_id" : ""}`;
}
async function activeWarehouse(client: PoolClient, id: string) {
  const result = await client.query("SELECT id, active FROM warehouses WHERE id = $1 FOR SHARE", [id]);
  if (!result.rows[0]) throw new DomainError(404, "NOT_FOUND");
  if (!result.rows[0].active) throw new DomainError(409, "INACTIVE_REFERENCE");
}
async function ensureUnused(client: PoolClient, kind: MasterKind, id: string) {
  const stockColumn = { items: "item_id", warehouses: "warehouse_id", locations: "location_id" }[kind];
  if ((await client.query(`SELECT 1 FROM stock_balances WHERE ${stockColumn} = $1 AND quantity > 0 LIMIT 1`, [id])).rowCount) {
    throw new DomainError(409, "IN_USE");
  }
  const reference = kind === "items"
    ? "SELECT 1 FROM inventory_documents d JOIN inventory_document_lines l ON l.document_id = d.id AND l.tenant_id = d.tenant_id WHERE d.status = 'DRAFT' AND l.item_id = $1 LIMIT 1"
    : kind === "warehouses"
      ? "SELECT 1 FROM inventory_documents WHERE status = 'DRAFT' AND warehouse_id = $1 UNION ALL SELECT 1 FROM locations WHERE warehouse_id = $1 AND active = true LIMIT 1"
      : "SELECT 1 FROM inventory_documents WHERE status = 'DRAFT' AND (source_location_id = $1 OR destination_location_id = $1) LIMIT 1";
  if ((await client.query(reference, [id])).rows.length) throw new DomainError(409, "IN_USE");
}
export async function masterCollection(request: Request, kind: MasterKind) {
  try {
    const identity = await requireIdentity(request.headers);
    const mutation = request.method === "POST";
    requireRole(identity, mutation ? ["admin"] : ["admin", "worker"]);
    if (mutation) requireMutationOrigin(request);
    if (!mutation && ["q", "page", "page_size", "active"].some(key => new URL(request.url).searchParams.has(key))) return json(await searchMaster(identity.tenant.id, kind, new URL(request.url).searchParams));
    const input = mutation ? validateMasterInput(await readBody(request), kind) : null;
    const warehouseId = !mutation && kind === "locations" ? new URL(request.url).searchParams.get("warehouse_id") : null;
    if (warehouseId !== null && !uuid.test(warehouseId)) throw new DomainError(400, "INVALID_INPUT");
    const result = await withTenant(identity.tenant.id, async (client) => {
      if (!input) return (await client.query(`SELECT ${columns(kind)} FROM ${kind}${warehouseId ? " WHERE warehouse_id = $1" : ""} ORDER BY code, id LIMIT 1000`, warehouseId ? [warehouseId] : [])).rows;
      if (kind === "locations") await activeWarehouse(client, input.warehouse_id as string);
      const keys = ["tenant_id", ...Object.keys(input)];
      return (await client.query(`INSERT INTO ${kind} (${keys.join(", ")}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING ${columns(kind)}`, [identity.tenant.id, ...Object.values(input)])).rows[0];
    });
    return json({ [mutation ? singular[kind] : kind]: result }, mutation ? 201 : 200);
  } catch (error) { return apiError(error); }
}
export async function masterDetail(request: Request, context: { params: Promise<{ id: string }> }, kind: MasterKind) {
  try {
    const identity = await requireIdentity(request.headers);
    const mutation = request.method === "PATCH";
    requireRole(identity, mutation ? ["admin"] : ["admin", "worker"]);
    if (mutation) requireMutationOrigin(request);
    const { id } = await context.params;
    if (!uuid.test(id)) throw new DomainError(404, "NOT_FOUND");
    const input = mutation ? validateMasterInput(await readBody(request), kind, true) : null;
    const result = await withTenant(identity.tenant.id, async (client) => {
      // Parent warehouse precedes location locks, matching document reference locks.
      if (input && kind === "locations") {
        const location = (await client.query("SELECT warehouse_id FROM locations WHERE id = $1", [id])).rows[0];
        if (!location) throw new DomainError(404, "NOT_FOUND");
        if (input.active === true) await activeWarehouse(client, location.warehouse_id);
        else await client.query("SELECT id FROM warehouses WHERE id = $1 FOR SHARE", [location.warehouse_id]);
      }
      const current = (await client.query(`SELECT ${columns(kind)} FROM ${kind} WHERE id = $1${input ? " FOR UPDATE" : ""}`, [id])).rows[0];
      if (!current) throw new DomainError(404, "NOT_FOUND");
      if (!input) return current;
      if (input.active === false) await ensureUnused(client, kind, id);
      const entries = Object.entries(input);
      return (await client.query(`UPDATE ${kind} SET ${entries.map(([key], i) => `${key} = $${i + 2}`).join(", ")} WHERE id = $1 RETURNING ${columns(kind)}`, [id, ...entries.map(([, value]) => value)])).rows[0];
    });
    return json({ [singular[kind]]: result });
  } catch (error) { return apiError(error); }
}
