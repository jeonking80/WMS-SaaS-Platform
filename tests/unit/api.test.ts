import { afterEach, describe, expect, it, vi } from "vitest";
import { apiError, readBody, requireMutationOrigin } from "../../src/server/api";

afterEach(() => vi.unstubAllEnvs());
describe("Business API request boundary", () => {
  it("marks rolled-back lock and transaction failures as retryable", async () => {
    for (const code of ["40001", "40P01", "55P03", "57014"]) {
      const response = apiError({ code });
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: "RETRYABLE_TRANSACTION" });
    }
  });
  it("requires the configured origin, rejecting missing and forged origins", () => {
    vi.stubEnv("BETTER_AUTH_URL", "https://wms.example.test");
    for (const origin of [undefined, "null", "https://attacker.example.test", "https://wms.example.test.attacker.test"]) {
      const request = new Request("https://attacker.example.test/api/items", { headers: origin ? { origin } : {} });
      expect(() => requireMutationOrigin(request)).toThrow("ORIGIN_FORBIDDEN");
    }
    expect(() => requireMutationOrigin(new Request("https://internal/api/items", { headers: { origin: "https://wms.example.test" } }))).not.toThrow();
  });
  it("rejects malformed JSON, arrays and non-JSON bodies", async () => {
    for (const body of ["{", "null", "[]", "1"]) {
      await expect(readBody(new Request("http://test", { method: "POST", headers: { "content-type": "application/json" }, body }))).rejects.toThrow("INVALID_INPUT");
    }
    await expect(readBody(new Request("http://test", { method: "POST", body: "{}" }))).rejects.toThrow("INVALID_INPUT");
    await expect(readBody(new Request("http://test", { method: "POST", headers: { "content-type": "application/json; charset=utf-8" }, body: '{"name":"Item"}' }))).resolves.toEqual({ name: "Item" });
  });
  it("does not expose SQL or unexpected error details", async () => {
    const response = apiError({ code: "23505", detail: "secret tenant/code" });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "CONFLICT" });
    expect(response.headers.get("cache-control")).toBe("no-store");
    const unavailable = apiError(new Error("private database credentials"));
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({ error: "SERVICE_UNAVAILABLE" });
  });
});
