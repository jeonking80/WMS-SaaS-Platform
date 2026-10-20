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
  if (!["127.0.0.1", "localhost"].includes(url.hostname) || !["/wms_lite", "/wms_test"].includes(url.pathname)) throw new Error("Delivery fixtures require an isolated local database.");
  const pool = new pg.Pool({ connectionString, max: 1 });
  const ids = { documents: [] as string[], locations: [] as string[], warehouses: [] as string[], items: [] as string[], keys: [] as string[] };
  const prefix = `DELIVERY-${randomUUID()}`;
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
      const response = await request.post("/api/documents", { headers, data: { kind: "OUTBOUND", recipient_name: "Test recipient", delivery_address: "Test delivery address", warehouse_id: warehouse, source_location_id: location, note: prefix, lines: [{ item_id: item, quantity }] } });
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

test("outbound delivery is required, editable, confirmed, and retained in history", async ({ page }) => {
  test.setTimeout(180_000);
  const fixture = fixtures(page.request);
  const headers = { origin };
  try {
    await login(page.request);
    const { item, warehouse, location, document: inbound } = await fixture.create();
    expect((await post(page.request, inbound, fixture.key())).status()).toBe(200);
    const body = { kind: "OUTBOUND", warehouse_id: warehouse, source_location_id: location, lines: [{ item_id: item, quantity: 2 }] };
    for (const missing of [{}, { recipient_name: "Recipient" }, { delivery_address: "Address" }, { recipient_name: "   ", delivery_address: "Address" }]) {
      expect((await page.request.post("/api/documents", { headers, data: { ...body, ...missing } })).status()).toBe(400);
    }
    const adminDraft = await fixture.outbound(warehouse, location, item, 1);
    expect((await (await page.request.get(`/api/documents/${adminDraft.id}`)).json()).document).toMatchObject({ recipient_name: "Test recipient", delivery_address: "Test delivery address" });
    await login(page.request, "viewer.a@example.test");
    expect((await page.request.post("/api/documents", { headers, data: { ...body, recipient_name: "Recipient", delivery_address: "Address" } })).status()).toBe(403);
    await page.goto("/dashboard/documents");
    await expect(page.getByRole("button", { name: "새 전표", exact: true })).toHaveCount(0);
    await login(page.request, "worker.a@example.test");
    await page.goto("/dashboard/documents");
    await page.getByRole("button", { name: "새 전표", exact: true }).click();
    await page.getByRole("combobox", { name: "전표 유형", exact: true }).selectOption("OUTBOUND");
    await page.getByRole("combobox", { name: "창고", exact: true }).selectOption(warehouse);
    await page.getByRole("combobox", { name: "출발 보관위치", exact: true }).selectOption(location);
    await page.getByRole("combobox", { name: "품목 1", exact: true }).selectOption(item);
    await page.getByLabel("수량 1", { exact: true }).fill("2");
    await page.getByLabel("받는 거래처", { exact: true }).fill("  Delivery customer  ");
    await page.getByRole("textbox", { name: "배송지", exact: true }).fill("  Seoul delivery address  ");
    const creation = page.waitForResponse(r => r.url().endsWith("/api/documents") && r.request().method() === "POST");
    await page.getByRole("button", { name: "전표 저장", exact: true }).click();
    const response = await creation; expect(response.status()).toBe(201);
    const document = (await response.json()).document; fixture.ids.documents.push(document.id);
    expect(document).toMatchObject({ recipient_name: "Delivery customer", delivery_address: "Seoul delivery address" });
    await page.getByLabel("받는 거래처", { exact: true }).fill("Updated customer");
    await page.getByRole("textbox", { name: "배송지", exact: true }).fill("Updated address\nFloor 2");
    await expect(page.getByRole("button", { name: "출고 확정", exact: true })).toBeDisabled();
    const update = page.waitForResponse(r => r.url().endsWith(`/api/documents/${document.id}`) && r.request().method() === "PATCH");
    await page.getByRole("button", { name: "전표 저장", exact: true }).click();
    expect((await update).status()).toBe(200);
    await page.getByRole("button", { name: "출고 확정", exact: true }).click();
    await expect(page.getByRole("dialog")).toContainText("Updated customer");
    await expect(page.getByRole("dialog")).toContainText("Updated address");
    await page.getByRole("button", { name: "확정 실행", exact: true }).click();
    await expect(page.getByText(/출고 확정됨 · 읽기 전용/)).toBeVisible();
    await expect(page.getByText("배송지: Updated address", { exact: false })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "배송지", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "전표 저장", exact: true })).toHaveCount(0);
    await page.goto("/dashboard/history");
    await page.getByRole("button", { name: `전표 ${document.id} 열기`, exact: true }).click();
    await expect(page.getByText("받는 거래처: Updated customer", { exact: true })).toBeVisible();
    await expect(page.getByText("배송지: Updated address", { exact: false })).toBeVisible();
    await login(page.request, "admin.b@example.test");
    expect((await page.request.get(`/api/documents/${document.id}`)).status()).toBe(404);
    expect((await page.request.patch(`/api/documents/${document.id}`, { headers, data: { ...body, version: document.version, recipient_name: "Foreign", delivery_address: "Foreign" } })).status()).toBe(404);
  } finally { await fixture.cleanup(); }
});
