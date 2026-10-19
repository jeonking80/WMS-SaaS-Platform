import { AccessError } from "./auth/access";

export class DomainError extends Error {
  constructor(public readonly status: number, public readonly code: string) {
    super(code);
  }
}

export function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export function requireMutationOrigin(request: Request): void {
  const configured = process.env.BETTER_AUTH_URL;
  if (!configured) throw new Error("Authentication origin is not configured.");
  if (request.headers.get("origin") !== new URL(configured).origin) {
    throw new DomainError(403, "ORIGIN_FORBIDDEN");
  }
}

export async function readBody(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json") {
    throw new DomainError(400, "INVALID_INPUT");
  }
  let value: unknown;
  try { value = await request.json(); }
  catch { throw new DomainError(400, "INVALID_INPUT"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DomainError(400, "INVALID_INPUT");
  }
  return value as Record<string, unknown>;
}

export function apiError(error: unknown): Response {
  if (error instanceof DomainError || error instanceof AccessError) {
    return json({ error: error.code }, error.status);
  }
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  if (["40001", "40P01", "55P03", "57014"].includes(String(code))) {
    return json({ error: "RETRYABLE_TRANSACTION" }, 503);
  }
  if (code === "23505") return json({ error: "CONFLICT" }, 409);
  if (code === "23503") return json({ error: "REFERENCE_CONFLICT" }, 409);
  if (code === "23514" || code === "22P02") return json({ error: "INVALID_INPUT" }, 400);
  return json({ error: "SERVICE_UNAVAILABLE" }, 503);
}
