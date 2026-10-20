import { randomUUID } from "node:crypto";
import { expect, test, type APIRequestContext } from "@playwright/test";
import pg from "pg";

const origin = "http://127.0.0.1:3100";
const tenant = "00000000-0000-4000-8000-000000000001";
type Document = { id: string; version: number; status: string };
type Stock = { item_id: string; location_id: string; quantity: string };
type Ledger = { document_id: string; quantity_delta: string };

async function login(request: APIRequestContext, email = "admin.a@example.test") {
  if (!process.env.DEMO_PASSWORD) throw new Error("DEMO_PASSWORD is required.");
  await request.post("/api/auth/sign-out", { headers: { origin }, data: {} });
  for (let attempt = 0; attempt < 4; attempt++) {
    const response = await request.post("/api/auth/sign-in/email", { headers: { origin }, data: { email, password: process.env.DEMO_PASSWORD } });
    if (response.status() !== 429 || attempt === 3) { expect(response.status()).toBe(200); return; }
    await new Promise(resolve => setTimeout(resolve, Math.min(10, Math.max(1, Number(response.headers()["retry-after"] ?? 10))) * 1000 + 250));
  }
}

function fixtures(request: APIRequestContext) {
  const connectionString = process.env.MIGRATION_DATABASE_URL;
  if (!connectionString) throw new Error("MIGRATION_DATABASE_URL is required.");
  const url = new URL(connectionString);
  if (!["127.0.0.1", "localhost"].includes(url.hostname) || !["/wms_lite", "/wms_test"].includes(url.pathname)) throw new Error("P4 fixtures require an isolated local database.");
  const pool = new pg.Pool({ connectionString, max: 1 });
  const ids = { documents: [] as string[], locations: [] as string[], warehouses: [] as string[], items: [] as string[], keys: [] as string[] };
  const prefix = `P4-${randomUUID()}`;
  const headers = { origin };
  async function master(kind: "items" | "warehouses" | "locations", extra = {}) {
    const response = await request.post(`/api/${kind}`, { headers, data: { code: `${prefix}-${kind}`, name: `${prefix}-${kind}`, ...extra } });
    expect(response.status()).toBe(201);
    const row = (await response.json())[kind === "items" ? "item" : kind === "warehouses" ? "warehouse" : "location"];
    ids[kind].push(row.id); return row.id as string;
  }
  return {
    ids,
    async create() {
      const item = await master("items"); const warehouse = await master("warehouses"); const location = await master("locations", { warehouse_id: warehouse });
      const body = { kind: "INBOUND", warehouse_id: warehouse, destination_location_id: location, note: prefix, lines: [{ item_id: item, quantity: 100 }] };
      const response = await request.post("/api/documents", { headers, data: body });
      expect(response.status()).toBe(201);
      const document = (await response.json()).document as Document; ids.documents.push(document.id);
      return { item, warehouse, location, document, body, itemCode: `${prefix}-items` };
    },
    async outbound(warehouse: string, location: string, item: string, quantity = 80) {
      const response = await request.post("/api/documents", { headers, data: { kind: "OUTBOUND", warehouse_id: warehouse, source_location_id: location, note: prefix, lines: [{ item_id: item, quantity }] } });
      expect(response.status()).toBe(201);
      const document = (await response.json()).document as Document;
      ids.documents.push(document.id); return document;
    },
    async auditCount(document: string) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenant]);
        const result = await client.query("SELECT count(*)::int AS count FROM audit_logs WHERE document_id=$1 AND action='POST_OUTBOUND'", [document]);
        await client.query("COMMIT"); return result.rows[0].count as number;
      } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
    },
    key() { const key = randomUUID(); ids.keys.push(key); return key; },
    async cleanup() {
      try {
        await pool.query("BEGIN");
        await pool.query("SELECT set_config('app.tenant_id', $1, true)", [tenant]);
        // The browser generates its own key: scope that cleanup to responses for our fixture documents.
        await pool.query("DELETE FROM idempotency_requests WHERE key=ANY($1::text[]) OR response->'document'->>'id'=ANY($2::text[])", [ids.keys, ids.documents]);
        await pool.query("DELETE FROM audit_logs WHERE document_id=ANY($1::uuid[])", [ids.documents]);
        await pool.query("DELETE FROM stock_ledger WHERE document_id=ANY($1::uuid[])", [ids.documents]);
        await pool.query("DELETE FROM stock_balances WHERE location_id=ANY($1::uuid[]) AND item_id=ANY($2::uuid[])", [ids.locations, ids.items]);
        await pool.query("DELETE FROM inventory_document_lines WHERE document_id=ANY($1::uuid[])", [ids.documents]);
        await pool.query("DELETE FROM inventory_documents WHERE id=ANY($1::uuid[])", [ids.documents]);
        for (const table of ["locations", "warehouses", "items"] as const) await pool.query(`DELETE FROM ${table} WHERE id=ANY($1::uuid[])`, [ids[table]]);
        await pool.query("COMMIT");
      } catch (error) { await pool.query("ROLLBACK"); throw error; } finally { await pool.end(); }
    },
  };
}

async function post(request: APIRequestContext, document: Document, key: string) {
  return request.post(`/api/documents/${document.id}/post`, { headers: { origin, "Idempotency-Key": key }, data: { version: document.version } });
}

async function assertEffects(request: APIRequestContext, item: string, location: string, document: string, quantity: string, delta?: string) {
  const response = await request.get(`/api/stock?location_id=${location}&item_id=${item}`);
  expect(response.status()).toBe(200);
  expect((await response.json()).stock).toEqual([expect.objectContaining({ item_id: item, location_id: location, quantity })]);
  const ledger = await request.get(`/api/stock-ledger?item_id=${item}&page_size=100`); expect(ledger.status()).toBe(200);
  const entries = ((await ledger.json()).entries as Ledger[]).filter(row => row.document_id === document);
  expect(entries).toEqual(delta === undefined ? [] : [expect.objectContaining({ quantity_delta: delta })]);
  const reconcile = await request.get("/api/stock/reconcile"); expect(reconcile.status()).toBe(200);
  expect(await reconcile.json()).toEqual({ consistent: true, mismatches: [] });
}

test("P4 outbound is idempotent, shortage atomic, and role and tenant protected", async ({ request }) => {
  test.setTimeout(180_000);
  const fixture = fixtures(request);
  try {
    await login(request);
    const { item, warehouse, location, document: inbound } = await fixture.create();
    expect((await post(request, inbound, fixture.key())).status()).toBe(200);
    const outbound = await fixture.outbound(warehouse, location, item);
    const key = fixture.key();
    await login(request, "viewer.a@example.test");
    expect((await post(request, outbound, key)).status()).toBe(403);
    await login(request, "admin.b@example.test");
    expect((await post(request, outbound, key)).status()).toBe(404);
    expect((await (await request.get(`/api/stock?location_id=${location}&item_id=${item}`)).json()).stock).toEqual([]);
    await login(request, "worker.a@example.test");
    const responses = await Promise.all([post(request, outbound, key), post(request, outbound, key)]);
    expect(responses.map(response => response.status())).toEqual([200, 200]);
    const result = await responses[0].json(); expect(await responses[1].json()).toEqual(result);
    expect(result).toMatchObject({ ledger_entries: 1, document: { id: outbound.id, status: "POSTED", version: outbound.version + 1 } });
    await assertEffects(request, item, location, outbound.id, "20", "-80");
    expect(await fixture.auditCount(outbound.id)).toBe(1);
    await login(request);
    const shortage = await fixture.outbound(warehouse, location, item);
    const shortageKey = fixture.key();
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await post(request, shortage, shortageKey);
      expect(response.status()).toBe(409); expect(await response.json()).toEqual({ error: "INSUFFICIENT_STOCK" });
    }
    await assertEffects(request, item, location, shortage.id, "20");
    expect(await fixture.auditCount(shortage.id)).toBe(0);
    const unchanged = await request.get(`/api/documents/${shortage.id}`);
    expect((await unchanged.json()).document).toMatchObject({ status: "DRAFT", version: shortage.version });
    expect((await request.get("/api/stock?location_id=invalid")).status()).toBe(400);
    expect((await request.get("/api/stock?item_id=invalid")).status()).toBe(400);
    expect((await (await request.get(`/api/stock?location_id=${randomUUID()}&item_id=${item}`)).json()).stock).toEqual([]);
  } finally { await fixture.cleanup(); }
});

for (const loseResponse of [false, true]) test(`P4 browser posts outbound and handles shortage${loseResponse ? " after retrying a lost response" : " after saving edits"}`, async ({ page }) => {
  test.setTimeout(180_000);
  const fixture = fixtures(page.request);
  try {
    await login(page.request);
    const { item, warehouse, location, document: inbound } = await fixture.create();
    expect((await post(page.request, inbound, fixture.key())).status()).toBe(200);
    const outbound = await fixture.outbound(warehouse, location, item, loseResponse ? 80 : 79);
    await page.goto("/dashboard/documents");
    await page.getByRole("button", { name: `전표 ${outbound.id} 열기`, exact: true }).click();
    await expect(page.getByText(/참고 재고.*100/)).toBeVisible();
    if (!loseResponse) {
      await page.getByLabel("수량 1", { exact: true }).fill("80");
      await expect(page.getByRole("button", { name: "출고 확정", exact: true })).toBeDisabled();
      await page.getByRole("button", { name: "전표 저장", exact: true }).click();
      await expect(page.getByRole("status")).toHaveText("전표를 저장했습니다.");
    }
    const keys: string[] = [];
    if (loseResponse) await page.route(`**/api/documents/${outbound.id}/post`, async route => {
      const key = route.request().headers()["idempotency-key"]; keys.push(key); fixture.ids.keys.push(key);
      const response = await route.fetch(); expect(response.status()).toBe(200);
      if (keys.length === 1) await route.abort("connectionreset"); else await route.fulfill({ response });
    });
    await page.getByRole("button", { name: "출고 확정", exact: true }).click();
    await page.getByRole("button", { name: "확정 실행", exact: true }).click();
    if (loseResponse) {
      await page.getByRole("button", { name: "출고 확정 다시 시도", exact: true }).click();
      await expect.poll(() => keys.length).toBe(2); expect(keys[0]).toBeTruthy(); expect(keys[1]).toBe(keys[0]);
    }
    await expect(page.getByText(/출고 확정됨 · 읽기 전용/)).toBeVisible();
    await expect(page.getByLabel("수량 1", { exact: true })).toBeDisabled();
    await assertEffects(page.request, item, location, outbound.id, "20", "-80");
    expect(await fixture.auditCount(outbound.id)).toBe(1);
    const shortage = await fixture.outbound(warehouse, location, item);
    await page.getByRole("button", { name: "목록 새로고침", exact: true }).click();
    await page.getByRole("button", { name: `전표 ${shortage.id} 열기`, exact: true }).click();
    await expect(page.getByText(/참고 재고.*20/)).toBeVisible();
    await page.getByRole("button", { name: "출고 확정", exact: true }).click();
    await page.getByRole("button", { name: "확정 실행", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: "재고가 부족합니다." })).toBeVisible();
    await expect(page.getByLabel("수량 1", { exact: true })).toBeEnabled();
    await expect(page.getByRole("button", { name: "전표 저장", exact: true })).toBeEnabled();
    await assertEffects(page.request, item, location, shortage.id, "20");
    expect(await fixture.auditCount(shortage.id)).toBe(0);
  } finally { await fixture.cleanup(); }
});
