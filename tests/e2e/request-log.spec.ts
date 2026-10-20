import { randomUUID } from "node:crypto";
import { expect, test, type APIResponse } from "@playwright/test";

const origin = "http://127.0.0.1:3100";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function correlation(response: APIResponse, supplied: string) {
  const id = response.headers()["x-request-id"];
  expect(id).toMatch(uuid);
  expect(id).not.toBe(supplied);
  expect(response.headers()["cache-control"]).toContain("no-store");
  return id;
}

test("every business API method correlates anonymous denials with an independent server ID", async ({ request }) => {
  const id = randomUUID();
  const routes: [string, string][] = [
    ["GET", "/api/me"], ["GET", "/api/dashboard"], ["GET", "/api/lookups"],
    ["GET", "/api/item-options"], ["GET", "/api/stock"], ["GET", "/api/stock/reconcile"],
    ["GET", "/api/stock-ledger"], ["GET", "/api/audit-logs"],
    ...["items", "warehouses", "locations", "delivery-destinations", "documents"].flatMap((resource): [string, string][] => [
      ["GET", `/api/${resource}`], ["POST", `/api/${resource}`],
      ["GET", `/api/${resource}/${id}`], ["PATCH", `/api/${resource}/${id}`],
    ]),
    ...["post", "cancel", "reverse"].map((action): [string, string] => ["POST", `/api/documents/${id}/${action}`]),
  ];
  const supplied = randomUUID();
  const ids = await Promise.all(routes.map(async ([method, path]) => {
    const response = await request.fetch(`${path}?token=query-secret`, {
      method, headers: { "x-request-id": supplied, authorization: "Bearer credential-secret", origin },
    });
    expect(response.status(), `${method} ${path}`).toBe(401);
    expect(await response.json()).toEqual({ error: "UNAUTHENTICATED" });
    return correlation(response, supplied);
  }));
  expect(new Set(ids).size).toBe(routes.length);
});

test("success and authenticated validation failures retain unique correlation and safe error bodies", async ({ request }) => {
  test.setTimeout(60_000);
  if (!process.env.DEMO_PASSWORD) throw new Error("DEMO_PASSWORD is required.");
  for (let attempt = 0; attempt < 3; attempt++) {
    const login = await request.post("/api/auth/sign-in/email", {
      headers: { origin }, data: { email: "admin.a@example.test", password: process.env.DEMO_PASSWORD },
    });
    if (login.status() !== 429 || attempt === 2) { expect(login.status()).toBe(200); break; }
    const retry = Number(login.headers()["retry-after"] ?? 10);
    await new Promise(resolve => setTimeout(resolve, (Number.isFinite(retry) ? Math.min(10, Math.max(1, retry)) : 10) * 1000 + 250));
  }
  const supplied = randomUUID();
  const success = await request.get("/api/items", { headers: { "x-request-id": supplied } });
  expect(success.status()).toBe(200);
  const successId = correlation(success, supplied);
  const failure = await request.post("/api/items", {
    headers: { origin, "content-type": "application/json", "x-request-id": supplied },
    data: '{"password":"body-secret",',
  });
  expect(failure.status()).toBe(400);
  expect(await failure.json()).toEqual({ error: "INVALID_INPUT" });
  expect(correlation(failure, supplied)).not.toBe(successId);
});
