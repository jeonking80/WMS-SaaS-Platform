import { DomainError, apiError, json, readBody, requireMutationOrigin } from "./api";
import { requireIdentity, requireRole } from "./auth/access";
import { withTenant } from "./db/tenant";
import { literalSearch, parseQuery } from "./queries";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fields = { recipient_name: 128, name: 128, postal_code: 5, address_line1: 300, address_line2: 160 };
const columns = "*, address_line1 || CASE WHEN address_line2 = '' THEN '' ELSE ' ' || address_line2 END AS delivery_address";
function invalid(): never { throw new DomainError(400, "INVALID_INPUT"); }
export function validateDestinationInput(body: Record<string, unknown>, patch = false) {
  const allowed = [...Object.keys(fields), ...(patch ? ["active"] : [])];
  if (Object.keys(body).some(key => !allowed.includes(key)) || (patch && !Object.keys(body).length)) invalid();
  const result: Record<string, string | boolean> = {};
  for (const [key, limit] of Object.entries(fields)) {
    if (patch && !(key in body)) continue;
    const raw = body[key] === undefined && !patch && ["postal_code", "address_line2"].includes(key) ? "" : body[key];
    if (typeof raw !== "string") invalid();
    const value = raw.trim();
    if (value.length > limit || (!["postal_code", "address_line2"].includes(key) && !value)) invalid();
    if (key === "postal_code" && value !== "" && !/^[0-9]{5}$/.test(value)) invalid();
    result[key] = value;
  }
  if ("active" in body) {
    if (typeof body.active !== "boolean") invalid();
    result.active = body.active;
  }
  return result;
}
export function parseDestinationQuery(params: URLSearchParams) {
  const parsed = parseQuery(new URLSearchParams({ page: params.get("page") ?? "1", page_size: params.get("page_size") ?? "20", q: params.get("q") ?? "" }));
  const inactive = params.get("include_inactive");
  if (inactive !== null && inactive !== "true" && inactive !== "false") invalid();
  return { page: parsed.page, page_size: parsed.page_size, q: parsed.q, include_inactive: inactive === "true" };
}
export function listDestinations(tenant: string, filters: ReturnType<typeof parseDestinationQuery>) {
  return withTenant(tenant, async client => {
    const search = filters.q ? literalSearch(filters.q) : null;
    const result = await client.query(`WITH filtered AS (SELECT ${columns} FROM delivery_destinations
      WHERE ($1::boolean OR active) AND ($2::text IS NULL OR recipient_name ILIKE $2 ESCAPE E'\\\\' OR name ILIKE $2 ESCAPE E'\\\\' OR postal_code ILIKE $2 ESCAPE E'\\\\' OR address_line1 ILIKE $2 ESCAPE E'\\\\' OR address_line2 ILIKE $2 ESCAPE E'\\\\')),
      page AS (SELECT * FROM filtered ORDER BY recipient_name,name,id LIMIT $3 OFFSET $4)
      SELECT (SELECT count(*)::int FROM filtered) AS total, COALESCE((SELECT json_agg(page ORDER BY recipient_name,name,id) FROM page),'[]'::json) AS rows`, [filters.include_inactive, search, filters.page_size, (filters.page - 1) * filters.page_size]);
    const { total, rows } = result.rows[0];
    return { destinations: rows, pagination: { page: filters.page, page_size: filters.page_size, total, total_pages: Math.ceil(total / filters.page_size) } };
  });
}
export async function destinationCollection(request: Request) {
  try {
    const identity = await requireIdentity(request.headers);
    const mutation = request.method === "POST";
    requireRole(identity, mutation ? ["admin"] : ["admin", "worker"]);
    if (!mutation) {
      const filters = parseDestinationQuery(new URL(request.url).searchParams);
      if (filters.include_inactive) requireRole(identity, ["admin"]);
      return json(await listDestinations(identity.tenant.id, filters));
    }
    requireMutationOrigin(request);
    const input = validateDestinationInput(await readBody(request));
    const entries = Object.entries(input);
    const destination = await withTenant(identity.tenant.id, async client => (await client.query(`INSERT INTO delivery_destinations (tenant_id,${entries.map(([key]) => key).join(",")}) VALUES ($1,${entries.map((_, index) => `$${index + 2}`).join(",")}) RETURNING ${columns}`, [identity.tenant.id, ...entries.map(([, value]) => value)])).rows[0]);
    return json({ destination }, 201);
  } catch (error) { return apiError(error); }
}
export async function destinationDetail(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const identity = await requireIdentity(request.headers);
    const mutation = request.method === "PATCH";
    requireRole(identity, mutation ? ["admin"] : ["admin", "worker"]);
    if (mutation) requireMutationOrigin(request);
    const { id } = await context.params;
    if (!uuid.test(id)) throw new DomainError(404, "NOT_FOUND");
    const input = mutation ? validateDestinationInput(await readBody(request), true) : null;
    const destination = await withTenant(identity.tenant.id, async client => {
      if (!input) return (await client.query(`SELECT ${columns} FROM delivery_destinations WHERE id=$1${identity.role === "admin" ? "" : " AND active"}`, [id])).rows[0];
      const entries = Object.entries(input);
      return (await client.query(`UPDATE delivery_destinations SET ${entries.map(([key], index) => `${key}=$${index + 2}`).join(",")},updated_at=clock_timestamp() WHERE id=$1 RETURNING ${columns}`, [id, ...entries.map(([, value]) => value)])).rows[0];
    });
    if (!destination) throw new DomainError(404, "NOT_FOUND");
    return json({ destination });
  } catch (error) { return apiError(error); }
}
