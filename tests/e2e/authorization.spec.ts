import { randomUUID } from "node:crypto";
import { expect, test, type APIRequestContext } from "@playwright/test";
import pg from "pg";

const origin = "http://127.0.0.1:3100";
const tenantA = "00000000-0000-4000-8000-000000000001";
const tenantB = "00000000-0000-4000-8000-000000000002";

async function postAuth(request: APIRequestContext, path: string, data: Record<string, unknown>, requestOrigin = origin) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await request.post(path, {
      headers: { origin: requestOrigin }, data,
    });
    if (response.status() !== 429 || attempt === 2) {
      return response;
    }
    const seconds = Number(response.headers()["retry-after"] ?? 10);
    await new Promise(resolve => setTimeout(resolve, Math.min(10, Math.max(1, seconds)) * 1000 + 250));
  }
  throw new Error("Authentication retry exhausted.");
}

async function login(request: APIRequestContext, email: string) {
  if (!process.env.DEMO_PASSWORD) throw new Error("DEMO_PASSWORD is required.");
  const response = await postAuth(request, "/api/auth/sign-in/email", { email, password: process.env.DEMO_PASSWORD });
  expect(response.status()).toBe(200);
}

function fixturePool() {
  const connectionString = process.env.MIGRATION_DATABASE_URL;
  if (!connectionString) throw new Error("MIGRATION_DATABASE_URL is required.");
  const url = new URL(connectionString);
  if (!["127.0.0.1", "localhost"].includes(url.hostname) ||
      !["/wms_lite", "/wms_test"].includes(url.pathname)) {
    throw new Error("Authentication E2E fixtures require the isolated local/CI database.");
  }
  return new pg.Pool({ connectionString, max: 1 });
}

test("업무 API는 미인증 접근과 공개 가입·신뢰하지 않는 출처를 차단한다", async ({ request }) => {
  expect((await request.get("/api/items")).status()).toBe(401);
  expect((await postAuth(request, "/api/auth/sign-up/email", {
    name: "Blocked", email: "blocked@example.test", password: "test-only-blocked-password",
  })).status()).toBe(400);
  expect((await postAuth(request, "/api/auth/sign-in/email", {
    email: "admin.a@example.test", password: process.env.DEMO_PASSWORD,
  }, "https://untrusted.example.invalid")).status()).toBe(403);
});

test("회사 정보 위조로 다른 회사 품목 목록·상세에 접근할 수 없다", async ({ request }) => {
  test.setTimeout(60_000);
  const pool = fixturePool();
  const fixtures = [{ tenant: tenantA, id: randomUUID() }, { tenant: tenantB, id: randomUUID() }];
  try {
    for (const item of fixtures) {
      await pool.query("BEGIN");
      await pool.query("SELECT set_config('app.tenant_id', $1, true)", [item.tenant]);
      await pool.query("INSERT INTO items (id,tenant_id,code,name) VALUES ($1,$2,$3,'P1 API fixture')", [item.id, item.tenant, item.id]);
      await pool.query("COMMIT");
    }
    await login(request, "admin.a@example.test");
    const list = await request.get(`/api/items?tenant_id=${tenantB}`, { headers: { "x-tenant-id": tenantB } });
    expect(list.status()).toBe(200);
    const ids = (await list.json()).items.map((item: { id: string }) => item.id);
    expect(ids).toContain(fixtures[0].id);
    expect(ids).not.toContain(fixtures[1].id);
    expect(list.headers()["cache-control"]).toContain("no-store");
    expect((await request.get(`/api/items/${fixtures[0].id}`)).status()).toBe(200);
    expect((await request.get(`/api/items/${fixtures[1].id}`)).status()).toBe(404);
    await request.post("/api/auth/sign-out", { headers: { origin }, data: {} });
    await login(request, "admin.b@example.test");
    expect((await request.get(`/api/items/${fixtures[0].id}`)).status()).toBe(404);
    expect((await request.get(`/api/items/${fixtures[1].id}`)).status()).toBe(200);
  } finally {
    await pool.query("ROLLBACK");
    for (const item of fixtures) {
      await pool.query("BEGIN");
      await pool.query("SELECT set_config('app.tenant_id', $1, true)", [item.tenant]);
      await pool.query("DELETE FROM items WHERE id = $1", [item.id]);
      await pool.query("COMMIT");
    }
    await pool.end();
  }
});

test("조회자에게 기준정보 API를 허용하지 않고 작업자는 조회할 수 있다", async ({ request }) => {
  test.setTimeout(60_000);
  await login(request, "viewer.a@example.test");
  expect((await request.get("/api/items")).status()).toBe(403);
  await request.post("/api/auth/sign-out", { headers: { origin }, data: {} });
  await login(request, "worker.a@example.test");
  expect((await request.get("/api/items")).status()).toBe(200);
});

test("만료된 세션으로 사용자 API를 이용할 수 없다", async ({ request }) => {
  await login(request, "viewer.b@example.test");
  const session = await (await request.get("/api/auth/get-session")).json();
  const pool = fixturePool();
  try {
    await pool.query('UPDATE "session" SET "expiresAt" = CURRENT_TIMESTAMP - interval \'1 second\' WHERE id = $1', [session.session.id]);
    expect((await request.get("/api/me")).status()).toBe(401);
  } finally { await pool.end(); }
});

test("역할 변경은 기존 세션에도 즉시 적용한다", async ({ request }) => {
  await login(request, "worker.b@example.test");
  const identity = await (await request.get("/api/me")).json();
  expect(identity.role).toBe("worker");
  const pool = fixturePool();
  try {
    await pool.query("UPDATE memberships SET role = 'viewer' WHERE user_id = $1", [identity.user.id]);
    expect((await (await request.get("/api/me")).json()).role).toBe("viewer");
    expect((await request.get("/api/items")).status()).toBe(403);
  } finally {
    await pool.query("UPDATE memberships SET role = 'worker' WHERE user_id = $1", [identity.user.id]);
    await pool.end();
  }
});
