import { openDocument } from "./document-ui";
import { randomUUID } from "node:crypto";
import { expect, test, type APIRequestContext } from "@playwright/test";
import pg from "pg";
import { grantFixtureWarehouse } from "./warehouse-scope";

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
  if (!["127.0.0.1", "localhost"].includes(url.hostname) || !["/wms_lite", "/wms_test"].includes(url.pathname)) throw new Error("P3 fixtures require an isolated local database.");
  const pool = new pg.Pool({ connectionString, max: 1 });
  const ids = { documents: [] as string[], locations: [] as string[], warehouses: [] as string[], items: [] as string[], keys: [] as string[] };
  const prefix = `P3-${randomUUID()}`;
  const headers = { origin };
  async function master(kind: "items" | "warehouses" | "locations", extra = {}) {
    const response = await request.post(`/api/${kind}`, { headers, data: { code: `${prefix}-${kind}`, name: `${prefix}-${kind}`, ...extra } });
    expect(response.status()).toBe(201);
    const row = (await response.json())[kind === "items" ? "item" : kind === "warehouses" ? "warehouse" : "location"];
    ids[kind].push(row.id);
    if (kind === "warehouses") await grantFixtureWarehouse(pool,tenant,row.id);
    return row.id as string;
  }
  return {
    ids,
    async create() {
      const item = await master("items"); const warehouse = await master("warehouses"); const location = await master("locations", { warehouse_id: warehouse });
      const body = { kind: "INBOUND", warehouse_id: warehouse, destination_location_id: location, note: prefix, lines: [{ item_id: item, quantity: 100 }] };
      const response = await request.post("/api/documents", { headers, data: body });
      expect(response.status()).toBe(201);
      const document = (await response.json()).document as Document; ids.documents.push(document.id);
      return { item, warehouse, location, document, body, itemCode: `${prefix}-items`.toUpperCase(), itemName: `${prefix}-items` };
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
        for (const table of ["locations", "warehouses", "items"] as const) await pool.query(`UPDATE ${table} SET active=false WHERE id=ANY($1::uuid[])`, [ids[table]]);
        await pool.query("COMMIT");
      } catch (error) { await pool.query("ROLLBACK"); throw error; } finally { await pool.end(); }
    },
  };
}

async function assertStock(request: APIRequestContext, item: string, location: string, document: string) {
  const stockResponse = await request.get(`/api/stock?item_id=${item}&page_size=100`); expect(stockResponse.status()).toBe(200);
  const stock = (await stockResponse.json()).stock as Stock[];
  expect(stock.filter(row => row.item_id === item && row.location_id === location)).toEqual([expect.objectContaining({ quantity: "100" })]);
  const ledgerResponse = await request.get(`/api/stock-ledger?item_id=${item}&page_size=100`); expect(ledgerResponse.status()).toBe(200);
  const ledger = (await ledgerResponse.json()).entries as Ledger[];
  expect(ledger.filter(row => row.document_id === document)).toEqual([expect.objectContaining({ quantity_delta: "100" })]);
  const reconcile = await request.get("/api/stock/reconcile"); expect(reconcile.status()).toBe(200);
  expect(await reconcile.json()).toEqual({ consistent: true, mismatches: [] });
}

test("P3 posting is idempotent, immutable, tenant isolated and role protected", async ({ request }) => {
  test.setTimeout(180_000);
  const fixture = fixtures(request);
  try {
    await login(request); const { item, warehouse, location, document, body } = await fixture.create();
    const path = `/api/documents/${document.id}/post`; const data = { version: document.version }; const key = fixture.key();
    expect((await request.post(path, { headers: { origin }, data })).status()).toBe(400);
    expect((await request.post(path, { headers: { origin, "Idempotency-Key": "x".repeat(129) }, data })).status()).toBe(400);
    expect((await request.post(path, { headers: { "Idempotency-Key": key }, data })).status()).toBe(403);
    const headers = { origin, "Idempotency-Key": key };
    const results = await Promise.all([request.post(path, { headers, data }), request.post(path, { headers, data })]);
    expect(results.map(result => result.status())).toEqual([200, 200]);
    const posted = await results[0].json(); expect(await results[1].json()).toEqual(posted);
    expect(posted.ledger_entries).toBe(1);
    expect(posted.document).toMatchObject({ id: document.id, status: "POSTED", version: document.version + 1, posted_at: expect.any(String) });
    await assertStock(request, item, location, document.id);
    expect((await request.post(path, { headers, data: { version: document.version + 1 } })).status()).toBe(409);
    expect((await request.post(path, { headers: { origin, "Idempotency-Key": fixture.key() }, data })).status()).toBe(409);
    expect((await request.patch(`/api/documents/${document.id}`, { headers: { origin }, data: { ...body, version: posted.document.version } })).status()).toBe(409);
    expect((await request.post(`/api/documents/${document.id}/cancel`, { headers: { origin }, data: { version: posted.document.version } })).status()).toBe(409);
    for (const [kind, id] of [["items", item], ["locations", location], ["warehouses", warehouse]]) expect((await request.patch(`/api/${kind}/${id}`, { headers: { origin }, data: { active: false } })).status()).toBe(409);
    await login(request, "worker.a@example.test"); await assertStock(request, item, location, document.id);
    await login(request, "viewer.a@example.test");
    expect((await request.post(path, { headers, data })).status()).toBe(403);
    await assertStock(request, item, location, document.id);
    await login(request, "admin.b@example.test");
    expect((await request.post(path, { headers, data })).status()).toBe(404);
    const stock = await (await request.get(`/api/stock?item_id=${item}&page_size=100`)).json(); expect(stock.stock.some((row: Stock) => row.item_id === item)).toBe(false);
    const ledger = await (await request.get(`/api/stock-ledger?item_id=${item}&page_size=100`)).json(); expect(ledger.entries.some((row: Ledger) => row.document_id === document.id)).toBe(false);
  } finally { await fixture.cleanup(); }
});

for (const loseResponse of [false, true]) test(`P3 browser posts 100 units${loseResponse ? " and safely retries a lost committed response" : " and displays stock"}`, async ({ page }) => {
  test.setTimeout(120_000);
  const fixture = fixtures(page.request);
  try {
    await login(page.request); const { item, location, document, itemCode } = await fixture.create();
    await page.goto("/dashboard/documents");
    await openDocument(page, document.id);
    const path = `/api/documents/${document.id}/post`;
    const keys: string[] = [];
    if (loseResponse) await page.route(`**${path}`, async route => {
      const key = route.request().headers()["idempotency-key"]; keys.push(key); fixture.ids.keys.push(key);
      const response = await route.fetch(); expect(response.status()).toBe(200);
      if (keys.length === 1) await route.abort("connectionreset"); else await route.fulfill({ response });
    });
    await page.getByRole("button", { name: "입고 확정", exact: true }).click();
    await page.getByRole("button", { name: "확정 실행", exact: true }).click();
    if (loseResponse) {
      await page.getByRole("button", { name: "입고 확정 다시 시도", exact: true }).click();
      await expect.poll(() => keys.length).toBe(2); expect(keys[0]).toBeTruthy(); expect(keys[1]).toBe(keys[0]);
    }
    await expect(page.getByText("입고 확정됨", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("읽기 전용", { exact: true })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "메모", exact: true })).toBeDisabled();
    await assertStock(page.request, item, location, document.id);
    await page.getByRole("link", { name: "재고 조회", exact: true }).click();
    await expect(page).toHaveURL(/\/dashboard\/stock$/);
    await expect(page.getByRole("heading", { name: "현재 재고", exact: true })).toBeVisible();
    await expect(page.locator("section").filter({ has: page.getByRole("heading", { name: "현재 재고", exact: true }) }).getByRole("row").filter({ hasText: itemCode }).getByRole("cell", { name: "100", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "재고 변동 이력", exact: true })).toBeVisible();
    const detail = await (await page.request.get(`/api/documents/${document.id}`)).json();
    await expect(page.getByRole("row").filter({ hasText: detail.document.document_number }).getByRole("cell", { name: "+100", exact: true })).toBeVisible();
    await expect(page.getByText("현재 재고와 변동 이력의 수량이 일치합니다.", { exact: true })).toBeVisible();
  } finally { await fixture.cleanup(); }
});
