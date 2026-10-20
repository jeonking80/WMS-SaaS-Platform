import { randomUUID } from "node:crypto";
import { expect, test, type APIRequestContext } from "@playwright/test";
import pg from "pg";

test.use({ actionTimeout: 10_000 });

const origin = "http://127.0.0.1:3100";
const tenants = { a: "00000000-0000-4000-8000-000000000001", b: "00000000-0000-4000-8000-000000000002" };
type Row = { id: string; version: number; status: string; lines: { item_id: string; quantity: number }[] };

async function login(request: APIRequestContext, email: string) {
  if (!process.env.DEMO_PASSWORD) throw new Error("DEMO_PASSWORD is required.");
  await request.post("/api/auth/sign-out", { headers: { origin }, data: {} });
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await request.post("/api/auth/sign-in/email", {
      headers: { origin }, data: { email, password: process.env.DEMO_PASSWORD },
    });
    if (response.status() !== 429 || attempt === 2) {
      expect(response.status()).toBe(200);
      return;
    }
    const seconds = Number(response.headers()["retry-after"] ?? 10);
    await new Promise(resolve => setTimeout(resolve, Math.min(10, Math.max(1, seconds)) * 1000 + 250));
  }
}

function fixturePool() {
  const connectionString = process.env.MIGRATION_DATABASE_URL;
  if (!connectionString) throw new Error("MIGRATION_DATABASE_URL is required.");
  const url = new URL(connectionString);
  if (!["127.0.0.1", "localhost"].includes(url.hostname) || !["/wms_lite", "/wms_test"].includes(url.pathname)) {
    throw new Error("P2 E2E fixtures require the isolated local database.");
  }
  return new pg.Pool({ connectionString, max: 1 });
}

test("P2 master data and document lifecycle enforce roles, tenant isolation and optimistic concurrency", async ({ request }) => {
  test.setTimeout(180_000);
  const pool = fixturePool();
  const created = new Map<string, { documents: string[]; locations: string[]; warehouses: string[]; items: string[] }>();
  for (const tenant of Object.values(tenants)) created.set(tenant, { documents: [], locations: [], warehouses: [], items: [] });
  let tenant = tenants.a;
  const code = `P2-${randomUUID()}`;
  const headers = { origin };
  async function master(kind: "items" | "warehouses" | "locations", suffix: string, extra = {}) {
    const response = await request.post(`/api/${kind}`, { headers, data: { code: `${code}-${suffix}`, name: `P2 ${suffix}`, ...extra } });
    expect(response.status()).toBe(201);
    const key = kind === "items" ? "item" : kind === "warehouses" ? "warehouse" : "location";
    const row = (await response.json())[key] as Row;
    created.get(tenant)![kind].push(row.id);
    return row;
  }
  async function document(data: Record<string, unknown>) {
    const response = await request.post("/api/documents", { headers, data });
    expect(response.status()).toBe(201);
    const row = (await response.json()).document as Row;
    created.get(tenant)!.documents.push(row.id);
    return row;
  }
  try {
    expect((await request.post("/api/documents", { headers, data: {} })).status()).toBe(401);
    await login(request, "admin.a@example.test");
    const item = await master("items", "ITEM");
    const warehouse = await master("warehouses", "WH");
    const location = await master("locations", "LOC", { warehouse_id: warehouse.id });
    const transferLocation = await master("locations", "TRANSFER-LOC", { warehouse_id: warehouse.id });
    const otherWarehouse = await master("warehouses", "OTHER");
    const otherLocation = await master("locations", "OTHER-LOC", { warehouse_id: otherWarehouse.id });
    const inactiveWarehouse = await master("warehouses", "INACTIVE-WH");
    const inactiveLocation = await master("locations", "INACTIVE-LOC", { warehouse_id: warehouse.id });
    expect((await request.patch(`/api/locations/${inactiveLocation.id}`, { headers, data: { active: false } })).status()).toBe(200);
    expect((await request.patch(`/api/warehouses/${inactiveWarehouse.id}`, { headers, data: { active: false } })).status()).toBe(200);
    expect((await request.post("/api/locations", { headers, data: { code: `${code}-BLOCKED`, name: "blocked", warehouse_id: inactiveWarehouse.id } })).status()).toBe(409);
    const inactive = await master("items", "INACTIVE");
    expect((await request.patch(`/api/items/${inactive.id}`, { headers, data: { active: false } })).status()).toBe(200);
    expect((await request.patch(`/api/items/${item.id}`, { headers, data: { name: "Updated item" } })).status()).toBe(200);
    expect((await request.post("/api/items", { headers, data: { code: `${code}-ITEM`, name: "duplicate" } })).status()).toBe(409);
    expect((await request.patch(`/api/warehouses/${warehouse.id}`, { headers, data: { active: false } })).status()).toBe(409);
    const body = { kind: "INBOUND", warehouse_id: warehouse.id, destination_location_id: location.id, note: "initial", lines: [{ item_id: item.id, quantity: 1 }] };
    expect((await request.post("/api/documents", { data: body })).status()).toBe(403);
    for (const quantity of [0, -1, 1.5, 1_000_000_001, "1"]) {
      expect((await request.post("/api/documents", { headers, data: { ...body, lines: [{ item_id: item.id, quantity }] } })).status()).toBe(400);
    }
    const invalidBodies = [
      { ...body, lines: [] },
      { ...body, lines: [body.lines[0], body.lines[0]] },
      { ...body, lines: Array.from({ length: 21 }, () => ({ item_id: randomUUID(), quantity: 1 })) },
      { ...body, kind: "UNKNOWN" },
      { ...body, destination_location_id: null },
      { ...body, source_location_id: location.id },
      { ...body, kind: "TRANSFER", source_location_id: location.id },
    ];
    for (const data of invalidBodies) expect((await request.post("/api/documents", { headers, data })).status()).toBe(400);
    for (const data of [
      { ...body, destination_location_id: otherLocation.id },
      { ...body, warehouse_id: inactiveWarehouse.id },
      { ...body, destination_location_id: inactiveLocation.id },
      { ...body, lines: [{ item_id: inactive.id, quantity: 1 }] },
    ]) expect((await request.post("/api/documents", { headers, data })).status()).toBe(404);
    const draft = await document(body);
    expect(draft.status).toBe("DRAFT");
    expect(draft.lines).toEqual([expect.objectContaining({ item_id: item.id, quantity: 1 })]);
    for (const [kind, id] of [["items", item.id], ["locations", location.id], ["warehouses", warehouse.id]]) {
      expect((await request.patch(`/api/${kind}/${id}`, { headers, data: { active: false } })).status()).toBe(409);
    }
    const race = await Promise.all(["first", "second"].map(note => request.patch(`/api/documents/${draft.id}`, { headers, data: { ...body, version: draft.version, note } })));
    expect(race.map(response => response.status()).sort()).toEqual([200, 409]);
    const current = (await (await request.get(`/api/documents/${draft.id}`)).json()).document as Row;
    expect(current.version).toBe(draft.version + 1);
    expect((await request.post(`/api/documents/${draft.id}/cancel`, { headers, data: { version: draft.version } })).status()).toBe(409);
    const cancelledResponse = await request.post(`/api/documents/${draft.id}/cancel`, { headers, data: { version: current.version } });
    expect(cancelledResponse.status()).toBe(200);
    const cancelled = (await cancelledResponse.json()).document as Row;
    expect(cancelled.status).toBe("CANCELLED");
    expect((await request.patch(`/api/documents/${draft.id}`, { headers, data: { ...body, version: cancelled.version } })).status()).toBe(409);

    await login(request, "worker.a@example.test");
    for (const kind of ["items", "warehouses", "locations"]) {
      expect((await request.get(`/api/${kind}`)).status()).toBe(200);
      expect((await request.post(`/api/${kind}`, { headers, data: { code, name: code } })).status()).toBe(403);
    }
    expect((await request.patch(`/api/items/${item.id}`, { headers, data: { name: "forbidden" } })).status()).toBe(403);
    const transfer = await document({ ...body, kind: "TRANSFER", source_location_id: location.id, destination_location_id: transferLocation.id });
    expect((await request.post(`/api/documents/${transfer.id}/cancel`, { headers, data: { version: transfer.version } })).status()).toBe(200);
    const workerDraft = await document({ ...body, kind: "OUTBOUND", recipient_name: "Test recipient", delivery_address: "Test delivery address", destination_location_id: null, source_location_id: location.id });
    expect((await request.patch(`/api/documents/${workerDraft.id}`, { headers, data: { ...body, version: workerDraft.version, lines: [{ item_id: item.id, quantity: 1_000_000_000 }] } })).status()).toBe(200);
    const workerCurrent = (await (await request.get(`/api/documents/${workerDraft.id}`)).json()).document as Row;
    expect((await request.post(`/api/documents/${workerDraft.id}/cancel`, { headers, data: { version: workerCurrent.version } })).status()).toBe(200);

    await login(request, "viewer.a@example.test");
    for (const path of ["/api/documents", `/api/documents/${draft.id}`]) expect((await request.get(path)).status()).toBe(403);
    expect((await request.post("/api/documents", { headers, data: body })).status()).toBe(403);
    expect((await request.patch(`/api/documents/${draft.id}`, { headers, data: { ...body, version: cancelled.version } })).status()).toBe(403);
    expect((await request.post(`/api/documents/${draft.id}/cancel`, { headers, data: { version: cancelled.version } })).status()).toBe(403);

    tenant = tenants.b;
    await login(request, "admin.b@example.test");
    const bItem = await master("items", "ITEM"); // Identical codes are valid in different companies.
    const bWarehouse = await master("warehouses", "WH");
    const bLocation = await master("locations", "LOC", { warehouse_id: bWarehouse.id });
    const bBody = { ...body, warehouse_id: bWarehouse.id, destination_location_id: bLocation.id, lines: [{ item_id: bItem.id, quantity: 1 }] };
    const bDraft = await document(bBody);
    expect((await request.get(`/api/documents/${draft.id}`)).status()).toBe(404);
    expect((await request.patch(`/api/documents/${draft.id}`, { headers, data: { ...bBody, version: cancelled.version } })).status()).toBe(404);
    for (const data of [body, { ...bBody, lines: body.lines }, { ...bBody, destination_location_id: location.id }]) {
      expect((await request.post("/api/documents", { headers, data })).status()).toBe(404);
    }
    expect((await request.post("/api/locations", { headers, data: { code: `${code}-FOREIGN`, name: "foreign", warehouse_id: warehouse.id } })).status()).toBe(404);
    const list = await request.get(`/api/documents?tenant_id=${tenants.a}`, { headers: { "x-tenant-id": tenants.a } });
    expect(list.status()).toBe(200);
    const ids = (await list.json()).documents.map((row: Row) => row.id);
    expect(ids).toContain(bDraft.id);
    expect(ids).not.toContain(draft.id);
    const spoofed = await document({ ...bBody, tenant_id: tenants.a });
    expect((await (await request.get(`/api/documents/${spoofed.id}`)).json()).document.tenant_id).toBe(tenants.b);
  } finally {
    await pool.query("ROLLBACK");
    for (const [tenantId, ids] of created) {
      await pool.query("BEGIN");
      try {
        await pool.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
        await pool.query("DELETE FROM inventory_document_lines WHERE document_id = ANY($1::uuid[])", [ids.documents]);
        await pool.query("DELETE FROM inventory_documents WHERE id = ANY($1::uuid[])", [ids.documents]);
        for (const table of ["locations", "warehouses", "items"] as const) await pool.query(`DELETE FROM ${table} WHERE id = ANY($1::uuid[])`, [ids[table]]);
        await pool.query("COMMIT");
      } catch (error) { await pool.query("ROLLBACK"); throw error; }
    }
    await pool.end();
  }
});

test("P2 browser creates master data and saves, edits and cancels a document", async ({ page }) => {
  test.setTimeout(90_000);
  const pool = fixturePool();
  const ids = { documents: [] as string[], locations: [] as string[], warehouses: [] as string[], items: [] as string[] };
  const code = `UI-${randomUUID()}`.toUpperCase();
  try {
    await login(page.request, "admin.a@example.test");
    await page.goto("/dashboard/master");
    await expect(page.getByRole("heading", { name: "기준정보 관리" })).toBeVisible();
    async function create(kind: "items" | "warehouses" | "locations", title: string) {
      await page.getByRole("button", { name: title, exact: true }).click();
      await page.getByRole("button", { name: `${title} 등록`, exact: true }).click();
      const dialog = page.getByRole("dialog");
      await dialog.getByLabel(`${title} 코드`, { exact: true }).fill(`${code}-${kind}`);
      await dialog.getByLabel(`${title} 이름`, { exact: true }).fill(`${code} ${title}`);
      if (kind === "locations") await dialog.getByRole("combobox", { name: "소속 창고", exact: true }).selectOption(ids.warehouses[0]);
      const responsePromise = page.waitForResponse(response => response.url().endsWith(`/api/${kind}`) && response.request().method() === "POST");
      await dialog.getByRole("button", { name: "저장", exact: true }).click();
      const response = await responsePromise;
      expect(response.status()).toBe(201);
      const singular = kind === "items" ? "item" : kind === "warehouses" ? "warehouse" : "location";
      ids[kind].push((await response.json())[singular].id);
      await expect(dialog).toHaveCount(0);
      await page.getByLabel("검색어", { exact: true }).fill(`${code}-${kind}`);
      await page.getByRole("button", { name: "검색 적용", exact: true }).click();
      await expect(page.getByRole("button", { name: `${title} ${code}-${kind.toUpperCase()} 수정`, exact: true })).toBeVisible();
    }
    await create("items", "품목");
    await create("warehouses", "창고");
    await create("locations", "보관위치");
    await page.goto("/dashboard/documents");
    await page.getByRole("button", { name: "새 전표", exact: true }).click();
    await page.getByRole("combobox", { name: "창고", exact: true }).selectOption(ids.warehouses[0]);
    await page.getByRole("combobox", { name: "도착 보관위치", exact: true }).selectOption(ids.locations[0]);
    await page.getByLabel("품목 1 검색", { exact: true }).fill(`${code}-items`);
    await page.getByRole("combobox", { name: "품목 1 검색 결과", exact: true }).selectOption({ label: `${code}-ITEMS · ${code} 품목` });
    await page.getByLabel("수량 1", { exact: true }).fill("3");
    await page.getByRole("textbox", { name: "메모", exact: true }).fill("browser draft");
    const createResponse = page.waitForResponse(response => response.url().endsWith("/api/documents") && response.request().method() === "POST");
    await page.getByRole("button", { name: "전표 저장", exact: true }).click();
    const saved = await createResponse;
    expect(saved.status()).toBe(201);
    const savedDocument = (await saved.json()).document as Row;
    ids.documents.push(savedDocument.id);
    await expect(page.getByRole("status").filter({ hasText: "전표를 저장했습니다." })).toHaveText("전표를 저장했습니다.");
    const concurrentUpdate = await page.request.patch(`/api/documents/${savedDocument.id}`, {
      headers: { origin },
      data: {
        kind: "INBOUND", warehouse_id: ids.warehouses[0], destination_location_id: ids.locations[0],
        note: "another operator", lines: [{ item_id: ids.items[0], quantity: 4 }], version: savedDocument.version,
      },
    });
    expect(concurrentUpdate.status()).toBe(200);
    await page.getByRole("textbox", { name: "메모", exact: true }).fill("stale browser edit");
    const conflictResponse = page.waitForResponse(response => response.url().endsWith(`/api/documents/${savedDocument.id}`) && response.request().method() === "PATCH");
    await page.getByRole("button", { name: "전표 저장", exact: true }).click();
    expect((await conflictResponse).status()).toBe(409);
    await expect(page.getByRole("alert").filter({ hasText: "최신 전표를 다시 불러오세요." })).toBeVisible();
    await expect(page.getByRole("button", { name: "전표 저장", exact: true })).toBeDisabled();
    page.once("dialog", async dialog => {
      expect(dialog.type()).toBe("confirm");
      expect(dialog.message()).toContain("저장하지 않은 변경 내용");
      await dialog.accept();
    });
    await page.getByRole("button", { name: "최신 전표 다시 불러오기", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "메모", exact: true })).toHaveValue("another operator");
    await expect(page.getByLabel("수량 1", { exact: true })).toHaveValue("4");
    await page.getByRole("textbox", { name: "메모", exact: true }).fill("browser edited");
    await page.getByLabel("수량 1", { exact: true }).fill("5");
    const updateResponse = page.waitForResponse(response => response.url().endsWith(`/api/documents/${ids.documents[0]}`) && response.request().method() === "PATCH");
    await page.getByRole("button", { name: "전표 저장", exact: true }).click();
    expect((await updateResponse).status()).toBe(200);
    await expect(page.getByLabel("수량 1", { exact: true })).toHaveValue("5");
    page.once("dialog", async dialog => {
      expect(dialog.type()).toBe("confirm");
      expect(dialog.message()).toBe("이 초안 전표를 취소할까요?");
      await dialog.accept();
    });
    const cancelResponse = page.waitForResponse(response => response.url().endsWith(`/api/documents/${ids.documents[0]}/cancel`));
    await page.getByRole("button", { name: "전표 취소", exact: true }).click();
    expect((await cancelResponse).status()).toBe(200);
    await expect(page.getByRole("status").filter({ hasText: "전표를 취소했습니다." })).toHaveText("전표를 취소했습니다.");
    await expect(page.getByRole("textbox", { name: "메모", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "전표 저장", exact: true })).toHaveCount(0);
    await login(page.request, "viewer.a@example.test");
    for (const path of ["/dashboard/master", "/dashboard/documents"]) {
      await page.goto(path);
      await expect(page.getByRole("alert").filter({ hasText: "접근 권한이 없습니다." })).toBeVisible();
      await expect(page.getByRole("button", { name: "새 전표", exact: true })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "품목 등록", exact: true })).toHaveCount(0);
    }
  } finally {
    await pool.query("BEGIN");
    try {
      await pool.query("SELECT set_config('app.tenant_id', $1, true)", [tenants.a]);
      await pool.query("DELETE FROM inventory_document_lines WHERE document_id = ANY($1::uuid[])", [ids.documents]);
      await pool.query("DELETE FROM inventory_documents WHERE id = ANY($1::uuid[])", [ids.documents]);
      for (const table of ["locations", "warehouses", "items"] as const) await pool.query(`DELETE FROM ${table} WHERE id = ANY($1::uuid[])`, [ids[table]]);
      await pool.query("COMMIT");
    } catch (error) { await pool.query("ROLLBACK"); throw error; }
    finally { await pool.end(); }
  }
});
