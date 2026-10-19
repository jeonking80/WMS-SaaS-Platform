import { describe, expect, it } from "vitest";
import { getDatabaseUrl } from "../../src/server/env";

describe("database configuration", () => {
  it.each([undefined, "", "   "])("rejects absent configuration (%s)", (value) => {
    expect(() => getDatabaseUrl({ DATABASE_URL: value })).toThrow("DATABASE_URL is required");
  });

  it.each(["not a URL", "https://localhost/wms_lite", "postgresql://localhost/"])("rejects a non-database URL (%s)", (value) => {
    expect(() => getDatabaseUrl({ DATABASE_URL: value })).toThrow();
  });

  it("accepts a PostgreSQL URL without changing its connection parameters", () => {
    const url = "postgresql://localhost/wms_lite?application_name=wms";
    expect(getDatabaseUrl({ DATABASE_URL: ` ${url} ` })).toBe(url);
  });

  it("does not include connection credentials in configuration errors", () => {
    const value = "https://user:local-test-only@localhost/wms_lite";
    expect(() => getDatabaseUrl({ DATABASE_URL: value })).toThrow(/^DATABASE_URL must specify a PostgreSQL host and database\.$/);
  });
});
