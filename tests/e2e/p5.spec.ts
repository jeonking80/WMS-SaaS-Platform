import { randomUUID } from "node:crypto";
import { expect, test, type APIRequestContext } from "@playwright/test";
import pg from "pg";

const origin = "http://127.0.0.1:3100";
const tenant = "00000000-0000-4000-8000-000000000001";
type Document = { id: string; version: number; status: string; reversal_of_id?: string; reversal_document_id?: string };
type Stock = { item_id: string; location_id: string; quantity: string };

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
  if (!["127.0.0.1", "localhost"].includes(url.hostname) || !["/wms_lite", "/wms_test"].includes(url.pathname)) throw new Error("P5 fixtures require an isolated local database.");
  const pool = new pg.Pool({ connectionString, max: 1 });
  const ids = { documents: [] as string[], locations: [] as string[], warehouses: [] as string[], items: [] as string[], keys: [] as string[] };
  const prefix = `P5-${randomUUID()}`;
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
    async transfer(warehouse: string, source: string, destination: string, item: string) {
      const response = await request.post("/api/documents", { headers, data: { kind: "TRANSFER", warehouse_id: warehouse, source_location_id: source, destination_location_id: destination, note: prefix, lines: [{ item_id: item, quantity: 60 }] } });
      expect(response.status()).toBe(201);
      const document = (await response.json()).document as Document; ids.documents.push(document.id); return document;
    },
    async destination(warehouse: string) { return master("locations", { warehouse_id: warehouse, code: `${prefix}-destination` }); },
    async outbound(warehouse: string, location: string, item: string, quantity = 80) {
      const response = await request.post("/api/documents", { headers, data: { kind: "OUTBOUND", warehouse_id: warehouse, source_location_id: location, note: prefix, lines: [{ item_id: item, quantity }] } });
      expect(response.status()).toBe(201);
      const document = (await response.json()).document as Document;
      ids.documents.push(document.id); return document;
    },
    key() { const key = randomUUID(); ids.keys.push(key); return key; },
    async cleanup() {
      try {
        await pool.query("BEGIN");
        const ownership = await pool.query("SELECT pg_get_userbyid(relowner)=current_user AS owner FROM pg_class WHERE oid='inventory_documents'::regclass");
        if (ownership.rows[0]?.owner !== true) throw new Error("P5 cleanup requires the local migration owner.");
        await pool.query("SELECT set_config('app.tenant_id', $1, true)", [tenant]);
        // Recover only reversals linked to fixture originals, including lost browser responses.
        const reversals = await pool.query("SELECT id FROM inventory_documents WHERE reversal_of_id=ANY($1::uuid[])", [ids.documents]);
        const reversalIds = reversals.rows.map(row => row.id as string);
        const ownedIds = [...ids.documents, ...reversalIds];
        await pool.query("DELETE FROM idempotency_requests WHERE key=ANY($1::text[]) OR response->'document'->>'id'=ANY($2::text[]) OR response->'reversal'->>'id'=ANY($2::text[])", [ids.keys, ownedIds]);
        await pool.query("DELETE FROM audit_logs WHERE document_id=ANY($1::uuid[])", [ownedIds]);
        await pool.query("DELETE FROM stock_ledger WHERE document_id=ANY($1::uuid[])", [ownedIds]);
        await pool.query("DELETE FROM stock_balances WHERE location_id=ANY($1::uuid[]) AND item_id=ANY($2::uuid[])", [ids.locations, ids.items]);
        await pool.query("DELETE FROM inventory_document_lines WHERE document_id=ANY($1::uuid[])", [ownedIds]);
        await pool.query("DELETE FROM inventory_documents WHERE id=ANY($1::uuid[])", [reversalIds]);
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

async function reverse(request: APIRequestContext, document: Document, key: string) {
  return request.post(`/api/documents/${document.id}/reverse`, { headers: { origin, "Idempotency-Key": key }, data: { version: document.version } });
}
async function detail(request: APIRequestContext, id: string): Promise<Document> {
  const response = await request.get(`/api/documents/${id}`); expect(response.status()).toBe(200);
  return (await response.json()).document;
}
async function balance(request: APIRequestContext, item: string, location: string) {
  const response = await request.get(`/api/stock?location_id=${location}&item_id=${item}`);
  expect(response.status()).toBe(200);
  return ((await response.json()).stock as Stock[]).reduce((total, row) => total + Number(row.quantity), 0);
}
async function transferBalances(request: APIRequestContext, item: string, source: string, destination: string, expected: [number, number]) {
  const quantities = [await balance(request, item, source), await balance(request, item, destination)];
  expect(quantities).toEqual(expected); expect(quantities[0] + quantities[1]).toBe(100);
  expect(await (await request.get("/api/stock/reconcile")).json()).toEqual({ consistent: true, mismatches: [] });
}

test("P5 transfer and linked reversal are atomic, idempotent and protected", async ({ request }) => {
  test.setTimeout(180_000);
  const fixture = fixtures(request);
  try {
    await login(request);
    const { item, warehouse, location, document: inbound } = await fixture.create();
    expect((await post(request, inbound, fixture.key())).status()).toBe(200);
    const destination = await fixture.destination(warehouse);
    const transfer = await fixture.transfer(warehouse, location, destination, item);
    const posted = await post(request, transfer, fixture.key()); expect(posted.status()).toBe(200);
    const original = (await posted.json()).document as Document;
    await transferBalances(request, item, location, destination, [40, 60]);
    const key = fixture.key();
    const partial = await request.post(`/api/documents/${original.id}/reverse`, {
      headers: { origin, "Idempotency-Key": key },
      data: { version: original.version, lines: [{ item_id: item, quantity: 1 }] },
    });
    expect(partial.status()).toBe(400);
    expect(await partial.json()).toEqual({ error: "INVALID_INPUT" });
    expect(await detail(request, original.id)).toMatchObject({ status: "POSTED", version: original.version, reversal_document_id: null });
    await transferBalances(request, item, location, destination, [40, 60]);
    for (const email of ["worker.a@example.test", "viewer.a@example.test"]) {
      await login(request, email); expect((await reverse(request, original, key)).status()).toBe(403);
    }
    await login(request, "admin.b@example.test"); expect((await reverse(request, original, key)).status()).toBe(404);
    await login(request);
    const results = await Promise.all([reverse(request, original, key), reverse(request, original, key)]);
    expect(results.map(response => response.status())).toEqual([200, 200]);
    const result = await results[0].json(); expect(await results[1].json()).toEqual(result);
    expect(result).toMatchObject({ document: { id: original.id, status: "REVERSED", version: original.version + 1 }, reversal: { status: "POSTED" }, ledger_entries: 2 });
    const reversal = result.reversal as Document;
    expect(await detail(request, original.id)).toMatchObject({ status: "REVERSED", reversal_document_id: reversal.id });
    expect(await detail(request, reversal.id)).toMatchObject({ status: "POSTED", reversal_of_id: original.id });
    await transferBalances(request, item, location, destination, [100, 0]);
    const ledgerResponse = await request.get("/api/stock-ledger"); expect(ledgerResponse.status()).toBe(200);
    const entries = (await ledgerResponse.json()).entries as { document_id: string; quantity_delta: string }[];
    expect(entries.filter(row => row.document_id === original.id).map(row => Number(row.quantity_delta)).sort((a, b) => a - b)).toEqual([-60, 60]);
    expect(entries.filter(row => row.document_id === reversal.id).map(row => Number(row.quantity_delta)).sort((a, b) => a - b)).toEqual([-60, 60]);
    expect((await reverse(request, result.document, fixture.key())).status()).toBe(409);
    expect((await reverse(request, reversal, fixture.key())).status()).toBe(409);
    expect((await post(request, reversal, fixture.key())).status()).toBe(409);
    expect((await request.post(`/api/documents/${reversal.id}/cancel`, { headers: { origin }, data: { version: reversal.version } })).status()).toBe(409);
    for (const email of ["worker.a@example.test", "viewer.a@example.test"]) {
      await login(request, email); expect((await reverse(request, original, key)).status()).toBe(403);
    }
    await login(request, "admin.b@example.test"); expect((await reverse(request, original, key)).status()).toBe(404);
    await login(request); await transferBalances(request, item, location, destination, [100, 0]);
  } finally { await fixture.cleanup(); }
});

for (const loseResponse of [false, true]) test(`P5 browser transfers and reverses${loseResponse ? " with a lost reversal response" : " after saving"}`, async ({ page }) => {
  test.setTimeout(180_000);
  const fixture = fixtures(page.request);
  try {
    await login(page.request);
    const { item, warehouse, location, document: inbound } = await fixture.create();
    expect((await post(page.request, inbound, fixture.key())).status()).toBe(200);
    const destination = await fixture.destination(warehouse);
    const transfer = await fixture.transfer(warehouse, location, destination, item);
    await page.goto("/dashboard/documents");
    await page.getByRole("button", { name: `전표 ${transfer.id} 열기`, exact: true }).click();
    await page.getByLabel("수량 1", { exact: true }).fill("59");
    await expect(page.getByRole("button", { name: "이동 확정", exact: true })).toBeDisabled();
    await page.getByLabel("수량 1", { exact: true }).fill("60");
    await page.getByRole("button", { name: "전표 저장", exact: true }).click();
    await expect(page.getByRole("status")).toHaveText("전표를 저장했습니다.");
    await page.getByRole("button", { name: "이동 확정", exact: true }).click();
    await expect(page.getByLabel("수량 1", { exact: true })).toBeDisabled();
    await transferBalances(page.request, item, location, destination, [40, 60]);
    const keys: string[] = [];
    if (loseResponse) await page.route(`**/api/documents/${transfer.id}/reverse`, async route => {
      const key = route.request().headers()["idempotency-key"]; keys.push(key); fixture.ids.keys.push(key);
      const response = await route.fetch(); expect(response.status()).toBe(200);
      if (keys.length === 1) await route.abort("connectionreset"); else await route.fulfill({ response });
    });
    await page.getByRole("button", { name: "확정 취소", exact: true }).click();
    if (loseResponse) {
      await page.getByRole("button", { name: "확정 취소 다시 시도", exact: true }).click();
      await expect.poll(() => keys.length).toBe(2); expect(keys[0]).toBeTruthy(); expect(keys[1]).toBe(keys[0]);
    }
    await page.getByRole("button", { name: "반대 전표 열기", exact: true }).click();
    await expect(page.getByRole("button", { name: "확정 취소", exact: true })).toHaveCount(0);
    await expect(page.getByLabel("수량 1", { exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "원본 전표 열기", exact: true }).click();
    await expect(page.getByRole("button", { name: "반대 전표 열기", exact: true })).toBeVisible();
    await transferBalances(page.request, item, location, destination, [100, 0]);
    const another = await fixture.transfer(warehouse, location, destination, item);
    expect((await post(page.request, another, fixture.key())).status()).toBe(200);
    await login(page.request, "worker.a@example.test");
    await page.reload();
    await page.getByRole("button", { name: `전표 ${another.id} 열기`, exact: true }).click();
    await expect(page.getByRole("button", { name: "확정 취소", exact: true })).toHaveCount(0);
  } finally { await fixture.cleanup(); }
});
