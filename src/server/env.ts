export function getDatabaseUrl(environment: Record<string, string | undefined> = process.env): string {
  const value = environment.DATABASE_URL?.trim();
  if (!value) throw new Error("DATABASE_URL is required.");
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("DATABASE_URL must be a PostgreSQL connection URL.");
  }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol) || !parsed.hostname || parsed.pathname.length < 2) {
    throw new Error("DATABASE_URL must specify a PostgreSQL host and database.");
  }
  if (decodeURIComponent(parsed.username) !== "wms_app") {
    throw new Error("DATABASE_URL must use the restricted wms_app role.");
  }
  return value;
}
