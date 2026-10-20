import { openDocument } from "./document-ui";
import { randomUUID } from "node:crypto";
import { expect, test, type APIRequestContext } from "@playwright/test";
import pg from "pg";
import { grantFixtureWarehouse } from "./warehouse-scope";

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
  if (!["127.0.0.1", "localhost"].includes(url.hostname) || !["/wms_lite", "/wms_test"].includes(url.pathname)) throw new Error("P6 fixtures require an isolated local database.");
  const pool = new pg.Pool({ connectionString, max: 1 });
  const ids = { documents: [] as string[], locations: [] as string[], warehouses: [] as string[], items: [] as string[], keys: [] as string[] };
  const prefix = `P6-${randomUUID()}`;
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
    ids, prefix, master,
    async create() {
      const item = await master("items"); const warehouse = await master("warehouses"); const location = await master("locations", { warehouse_id: warehouse });
      const body = { kind: "INBOUND", warehouse_id: warehouse, destination_location_id: location, note: prefix, lines: [{ item_id: item, quantity: 100 }] };
      const response = await request.post("/api/documents", { headers, data: body });
      expect(response.status()).toBe(201);
      const document = (await response.json()).document as Document; ids.documents.push(document.id);
      return { item, warehouse, location, document, body, itemCode: `${prefix}-items`.toUpperCase(), itemName: `${prefix}-items` };
    },
    async transfer(warehouse: string, source: string, destination: string, item: string) {
      const response = await request.post("/api/documents", { headers, data: { kind: "TRANSFER", warehouse_id: warehouse, source_location_id: source, destination_location_id: destination, note: prefix, lines: [{ item_id: item, quantity: 60 }] } });
      expect(response.status()).toBe(201);
      const document = (await response.json()).document as Document; ids.documents.push(document.id); return document;
    },
    async destination(warehouse: string) { return master("locations", { warehouse_id: warehouse, code: `${prefix}-destination` }); },
    async outbound(warehouse: string, location: string, item: string, quantity = 80) {
      const response = await request.post("/api/documents", { headers, data: { kind: "OUTBOUND", recipient_name: "Test recipient", delivery_address: "Test delivery address", warehouse_id: warehouse, source_location_id: location, note: prefix, lines: [{ item_id: item, quantity }] } });
      expect(response.status()).toBe(201);
      const document = (await response.json()).document as Document;
      ids.documents.push(document.id); return document;
    },
    key() { const key = randomUUID(); ids.keys.push(key); return key; },
    async cleanup() {
      try {
        await pool.query("BEGIN");
        const ownership = await pool.query("SELECT pg_get_userbyid(relowner)=current_user AS owner FROM pg_class WHERE oid='inventory_documents'::regclass");
        if (ownership.rows[0]?.owner !== true) throw new Error("P6 cleanup requires the local migration owner.");
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
        for (const table of ["locations", "warehouses", "items"] as const) await pool.query(`UPDATE ${table} SET active=false WHERE id=ANY($1::uuid[])`, [ids[table]]);
        await pool.query("COMMIT");
      } catch (error) { await pool.query("ROLLBACK"); throw error; } finally { await pool.end(); }
    },
  };
}

async function seed(request: APIRequestContext, fixture: ReturnType<typeof fixtures>) {
  const first = await fixture.create();
  const documents: Document[] = [first.document];
  for (let index = 1; index < 30; index++) {
    const item = await fixture.master("items", { code: `${fixture.prefix}-${String(index).padStart(2, "0")}`, name: index === 1 ? `${fixture.prefix} literal %_` : `${fixture.prefix} item ${index}` });
    const response = await request.post("/api/documents", { headers: { origin }, data: { kind: "INBOUND", warehouse_id: first.warehouse, destination_location_id: first.location, note: fixture.prefix, lines: [{ item_id: item, quantity: index + 1 }] } });
    expect(response.status()).toBe(201);
    const document = (await response.json()).document as Document;
    fixture.ids.documents.push(document.id); documents.push(document);
  }
  for (const document of documents) {
    const response = await request.post(`/api/documents/${document.id}/post`, { headers: { origin, "Idempotency-Key": fixture.key() }, data: { version: document.version } });
    expect(response.status()).toBe(200);
  }
  const draft = await fixture.outbound(first.warehouse, first.location, first.item, 1);
  return { ...first, documents, draft };
}

type Row = Record<string, unknown>;
async function collection(request: APIRequestContext, path: string, key: string) {
  const response = await request.get(path); expect(response.status()).toBe(200);
  const body = await response.json();
  return { rows: body[key] as Row[], pagination: body.pagination as { page: number; page_size: number; total: number; total_pages: number } };
}

test("P6 paginated search, confirmed history and role/tenant boundaries", async ({ request }) => {
  test.setTimeout(240_000);
  const fixture = fixtures(request);
  try {
    await login(request);
    const data = await seed(request, fixture);
    for (const [endpoint, key, identity] of [["stock", "stock", "item_id"], ["stock-ledger", "entries", "id"], ["documents?view=history", "documents", "id"]]) {
      const path = `/api/${endpoint}${endpoint.includes("?") ? "&" : "?"}warehouse_id=${data.warehouse}&page_size=7`;
      const ids: unknown[] = [];
      for (let page = 1; page <= 5; page++) {
        const result = await collection(request, `${path}&page=${page}`, key);
        expect(result.pagination).toEqual({ page, page_size: 7, total: 30, total_pages: 5 });
        ids.push(...result.rows.map(row => row[identity]));
        if (page === 1) expect(await collection(request, `${path}&page=1`, key)).toEqual(result);
      }
      expect(ids).toHaveLength(30); expect(new Set(ids).size).toBe(30);
      expect((await collection(request, `${path}&page=6`, key)).rows).toEqual([]);
    }
    const literal = await collection(request, `/api/stock?warehouse_id=${data.warehouse}&q=${encodeURIComponent("%_")}`, "stock");
    expect(literal.rows).toHaveLength(1); expect(literal.rows[0].item_name).toContain("literal %_");
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    expect((await collection(request, `/api/documents?view=history&warehouse_id=${data.warehouse}&date_field=posted_at&date_from=${today}&date_to=${today}&page_size=100`, "documents")).pagination.total).toBe(30);
    expect((await collection(request, `/api/stock-ledger?warehouse_id=${data.warehouse}&date_from=2000-01-01&date_to=2000-01-01`, "entries")).pagination.total).toBe(0);
    for (const path of ["/api/stock?page=0", "/api/documents?date_from=2026-02-30", "/api/stock-ledger?page_size=10001"]) expect((await request.get(path)).status()).toBe(400);
    const lowItem = await fixture.master("items", { code: `000-${fixture.prefix}`, name: `${fixture.prefix} missing balance` });
    const threshold = await request.patch(`/api/items/${lowItem}`, { headers: { origin }, data: { min_stock: 5 } });
    expect(threshold.status()).toBe(200);
    const dashboard = await (await request.get("/api/dashboard")).json();
    expect(dashboard.low_stock).toContainEqual(expect.objectContaining({ id: lowItem, min_stock: "5", quantity: "0" }));
    expect(dashboard.recent.some((row: Row) => row.id === data.documents[29].id)).toBe(true);
    expect((await request.get("/api/audit-logs")).status()).toBe(200);
    for (const email of ["worker.a@example.test", "viewer.a@example.test"]) {
      await login(request, email);
      expect((await request.get("/api/audit-logs")).status()).toBe(403);
      const options = await collection(request, `/api/item-options?q=${encodeURIComponent(fixture.prefix)}&page_size=7`, "items");
      expect(options.pagination.total).toBe(31);
      expect(options.rows).toHaveLength(7);
      expect(options.rows.every(row => String(row.code).includes(fixture.prefix.toUpperCase()))).toBe(true);
      const history = await collection(request, `/api/documents?view=history&warehouse_id=${data.warehouse}&page_size=100`, "documents");
      expect(history.pagination.total).toBe(30); expect(history.rows.every(row => row.status === "POSTED")).toBe(true);
      expect((await request.get(`/api/documents/${data.documents[0].id}?view=history`)).status()).toBe(200);
      if (email.startsWith("viewer")) {
        expect((await request.get("/api/documents")).status()).toBe(403);
        expect((await request.get(`/api/documents/${data.draft.id}?view=history`)).status()).toBe(403);
      }
    }
    await login(request, "admin.b@example.test");
    expect((await request.get(`/api/documents/${data.documents[0].id}?view=history`)).status()).toBe(404);
    for (const [endpoint, key] of [["stock", "stock"], ["stock-ledger", "entries"], ["documents?view=history", "documents"]]) {
      const result = await collection(request, `/api/${endpoint}${endpoint.includes("?") ? "&" : "?"}warehouse_id=${data.warehouse}`, key);
      expect(result.pagination.total).toBe(0); expect(result.rows).toEqual([]);
    }
    const foreignOptions = await collection(request, `/api/item-options?q=${encodeURIComponent(fixture.prefix)}`, "items");
    expect(foreignOptions.pagination.total).toBe(0);
    expect(foreignOptions.rows).toEqual([]);
    const foreignDashboard = await (await request.get("/api/dashboard")).json();
    expect(JSON.stringify(foreignDashboard)).not.toContain(fixture.prefix);
    expect(foreignDashboard.recent.some((row: Row) => fixture.ids.documents.includes(row.id as string))).toBe(false);
    const lookups = await request.get("/api/lookups"); expect(lookups.status()).toBe(200);
    expect(JSON.stringify(await lookups.json())).not.toContain(fixture.prefix);
  } finally { await fixture.cleanup(); }
});

test("P6 browser refreshes tenant data after logout and history is read only at tablet size", async ({ page }) => {
  test.setTimeout(180_000);
  const fixture = fixtures(page.request);
  try {
    await login(page.request);
    const data = await fixture.create();
    const response = await page.request.post(`/api/documents/${data.document.id}/post`, { headers: { origin, "Idempotency-Key": fixture.key() }, data: { version: data.document.version } });
    expect(response.status()).toBe(200);
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.goto("/dashboard");
    await expect(page.getByTestId("current-company")).toHaveText("데모 고객사 A");
    await page.getByRole("link", { name: "확정 이력", exact: true }).click();
    await openDocument(page, data.document.id, true);
    await expect(page.getByRole("button", { name: "전표 저장", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "확정 취소", exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => document.body.scrollWidth <= window.innerWidth)).toBe(true);
    await page.getByRole("button", { name: "로그아웃", exact: true }).click();
    await expect(page).toHaveURL(/\/login$/);
    await page.getByLabel("이메일", { exact: true }).fill("admin.b@example.test");
    await page.getByLabel("비밀번호", { exact: true }).fill(process.env.DEMO_PASSWORD!);
    for (let attempt = 0; attempt < 4; attempt++) {
      const [response] = await Promise.all([
        page.waitForResponse(r => new URL(r.url()).pathname === "/api/auth/sign-in/email" && r.request().method() === "POST"),
        page.getByRole("button", { name: "로그인", exact: true }).click(),
      ]);
      if (response.status() !== 429 || attempt === 3) { expect(response.status()).toBe(200); break; }
      const retryAfter = Number(response.headers()["retry-after"] ?? 10);
      await page.waitForTimeout(Math.min(60, Math.max(1, Number.isFinite(retryAfter) ? retryAfter : 10)) * 1000 + 250);
    }
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(page.getByTestId("current-company")).toHaveText("데모 고객사 B");
    await expect(page.getByText(data.document.id, { exact: true })).toHaveCount(0);
    await page.getByRole("link", { name: "확정 이력", exact: true }).click();
    await expect(page.getByRole("button", { name: `전표 ${data.document.id} 열기`, exact: true })).toHaveCount(0);
    await page.getByRole("link", { name: "재고 조회", exact: true }).click();
    await expect(page.getByText(data.itemCode, { exact: true })).toHaveCount(0);
    const lookup = await page.request.get("/api/lookups");
    expect(JSON.stringify(await lookup.json())).not.toContain(fixture.prefix);
  } finally { await fixture.cleanup(); }
});

test("P6 stock browser searches, paginates and distinguishes loading, empty and failures", async ({ page }) => {
  test.setTimeout(240_000);
  const fixture = fixtures(page.request);
  try {
    await login(page.request);
    const data = await seed(page.request, fixture);
    await page.goto("/dashboard/stock");
    await page.getByRole("combobox", { name: /^창고 필터/ }).selectOption(data.warehouse);
    await page.getByRole("button", { name: "검색 적용", exact: true }).click();
    const stock = page.locator("section").filter({ has: page.getByRole("heading", { name: "현재 재고", exact: true }) });
    await expect(stock.getByText("총 30건 · 1 / 2 페이지", { exact: true })).toBeVisible();
    await expect(stock.locator("tbody tr")).toHaveCount(25);
    await expect(page.getByText("원장 날짜·유형·상태 필터는 재고 변동 이력에 적용됩니다. 현재 재고는 현재 수량을 표시합니다.", { exact: true })).toBeVisible();
    await page.getByLabel("원장 시작일 (서울)", { exact: true }).fill("2000-01-01");
    await page.getByLabel("원장 종료일 (서울)", { exact: true }).fill("2000-01-01");
    const [currentResponse, ledgerResponse] = await Promise.all([
      page.waitForResponse(response => new URL(response.url()).pathname === "/api/stock" && new URL(response.url()).searchParams.get("warehouse_id") === data.warehouse),
      page.waitForResponse(response => new URL(response.url()).pathname === "/api/stock-ledger" && new URL(response.url()).searchParams.get("date_from") === "2000-01-01"),
      page.getByRole("button", { name: "검색 적용", exact: true }).click(),
    ]);
    const currentParams = new URL(currentResponse.url()).searchParams;
    for (const key of ["date_from", "date_to", "date_field"]) expect(currentParams.has(key)).toBe(false);
    expect((await currentResponse.json()).pagination.total).toBe(30);
    expect((await ledgerResponse.json()).pagination.total).toBe(0);
    await expect(stock.getByText("총 30건 · 1 / 2 페이지", { exact: true })).toBeVisible();
    await expect(stock.locator("tbody tr")).toHaveCount(25);
    const ledger = page.locator("section").filter({ has: page.getByRole("heading", { name: "재고 변동 이력", exact: true }) });
    await expect(ledger.getByText("재고 변동 이력이 없습니다.", { exact: true })).toBeVisible();
    await page.getByLabel("원장 시작일 (서울)", { exact: true }).fill("");
    await page.getByLabel("원장 종료일 (서울)", { exact: true }).fill("");
    await page.getByRole("button", { name: "검색 적용", exact: true }).click();
    await expect(ledger.getByText("총 30건 · 1 / 2 페이지", { exact: true })).toBeVisible();
    await stock.getByRole("button", { name: "다음 페이지", exact: true }).click();
    await expect(stock.getByText("총 30건 · 2 / 2 페이지", { exact: true })).toBeVisible();
    await expect(stock.locator("tbody tr")).toHaveCount(5);
    await page.getByLabel("검색어", { exact: true }).fill("%_");
    await page.getByRole("button", { name: "검색 적용", exact: true }).click();
    await expect(stock.locator("tbody tr")).toHaveCount(1);
    await expect(stock.getByText(`${fixture.prefix} literal %_`, { exact: true })).toBeVisible();
    await page.getByLabel("검색어", { exact: true }).fill(`missing-${randomUUID()}`);
    await page.getByRole("button", { name: "검색 적용", exact: true }).click();
    await expect(stock.getByText("등록된 재고가 없습니다.", { exact: true })).toBeVisible();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    await page.route("**/api/stock?**", async route => {
      await gate;
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "SERVICE_UNAVAILABLE" }) });
    });
    await page.getByRole("button", { name: "재고 새로고침", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "불러오는 중" })).toBeVisible();
    await expect(stock.getByText("등록된 재고가 없습니다.", { exact: true })).toHaveCount(0);
    release();
    await expect(page.getByRole("alert").filter({ hasText: "서버에 연결할 수 없습니다." })).toBeVisible();
    await expect(stock.getByText("등록된 재고가 없습니다.", { exact: true })).toHaveCount(0);
    await expect(page.getByText("현재 재고와 변동 이력의 수량이 일치합니다.", { exact: true })).toHaveCount(0);
    await expect(stock.locator("tbody tr")).toHaveCount(0);
    await page.unroute("**/api/stock?**");
  } finally { await fixture.cleanup(); }
});

test("completion workflow searches master pages, writes from dashboard and drills into stock history", async ({ page }) => {
  test.setTimeout(240_000);
  const fixture = fixtures(page.request);
  try {
    await login(page.request);
    const data = await seed(page.request, fixture);
    await page.goto("/dashboard/master?tab=items");
    await page.getByLabel("검색어", { exact: true }).fill(fixture.prefix);
    await page.getByRole("button", { name: "검색 적용", exact: true }).click();
    await expect(page.getByText("총 30건 · 1 / 2 페이지", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "다음 페이지", exact: true }).click();
    await expect(page.getByText("총 30건 · 2 / 2 페이지", { exact: true })).toBeVisible();
    await expect(page.locator("tbody tr")).toHaveCount(10);
    const row = page.locator("tbody tr").first();
    const itemName = await row.locator("td").nth(1).innerText();
    await row.getByRole("button", { name: / 수정$/ }).click();
    const editor = page.getByRole("dialog", { name: "품목 수정", exact: true });
    await editor.getByLabel("품목 이름", { exact: true }).fill(`${itemName} edited`);
    await editor.getByRole("button", { name: "저장", exact: true }).click();
    await expect(editor).toHaveCount(0);
    await expect(page.getByText(`${itemName} edited`, { exact: true })).toBeVisible();

    await page.goto("/dashboard");
    await page.getByRole("link", { name: "입고 작성", exact: true }).click();
    await expect(page.getByRole("combobox", { name: "전표 유형", exact: true })).toHaveValue("INBOUND");
    await page.getByRole("combobox", { name: "창고", exact: true }).selectOption(data.warehouse);
    await page.getByRole("combobox", { name: "도착 보관위치", exact: true }).selectOption(data.location);
    await page.getByLabel("품목 1 검색", { exact: true }).fill(data.itemCode);
    await page.getByRole("combobox", { name: "품목 1 검색 결과", exact: true }).selectOption({ label: `${data.itemCode} · ${data.itemName}` });
    await page.getByLabel("수량 1", { exact: true }).fill("7");
    const savedResponse = page.waitForResponse(response => new URL(response.url()).pathname === "/api/documents" && response.request().method() === "POST");
    await page.getByRole("button", { name: "전표 저장", exact: true }).click();
    const saved = await savedResponse;
    expect(saved.status()).toBe(201);
    const document = (await saved.json()).document;
    fixture.ids.documents.push(document.id);
    expect(document.document_number).toMatch(/^WMS-\d{6,}$/);
    await expect(page.getByText(document.document_number, { exact: true }).first()).toBeVisible();
    await expect(page.getByText(document.id, { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "입고 확정", exact: true }).click();
    await page.getByRole("button", { name: "확정 실행", exact: true }).click();
    await expect(page.getByText("입고 확정됨", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("읽기 전용", { exact: true })).toBeVisible();
    await expect(page.getByLabel("수량 1", { exact: true })).toBeDisabled();

    await page.goto(`/dashboard/stock?item_id=${data.item}`);
    const stock = page.locator("section").filter({ has: page.getByRole("heading", { name: "현재 재고", exact: true }) });
    await expect(stock.locator("tbody tr")).toHaveCount(1);
    await expect(stock.getByRole("cell", { name: "107", exact: true })).toBeVisible();
    const ledgerResponse = page.waitForResponse(response => {
      const url = new URL(response.url());
      return url.pathname === "/api/stock-ledger" && url.searchParams.get("item_id") === data.item && url.searchParams.get("location_id") === data.location;
    });
    await stock.getByRole("button", { name: /변동 이력 보기$/ }).click();
    expect((await ledgerResponse).status()).toBe(200);
    const ledger = page.locator("section").filter({ has: page.getByRole("heading", { name: "재고 변동 이력", exact: true }) });
    await expect(ledger.locator("tbody tr")).toHaveCount(2);
    await expect(ledger.getByRole("columnheader", { name: "작업자", exact: true })).toBeVisible();
    await expect(ledger.getByText("작업자 정보 없음", { exact: true })).toHaveCount(0);
    await ledger.getByRole("link", { name: document.document_number, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/dashboard/history\\?id=${document.id}$`));
    await expect(page.getByLabel("수량 1", { exact: true })).toHaveValue("7");
    await expect(page.getByRole("button", { name: "전표 저장", exact: true })).toHaveCount(0);

    await login(page.request, "viewer.a@example.test");
    await page.goto("/dashboard");
    await expect(page.getByRole("link", { name: "입고 작성", exact: true })).toHaveCount(0);
    await expect(page.locator(`a[href*="${data.draft.id}"]`)).toHaveCount(0);
    const dashboard = await (await page.request.get("/api/dashboard")).json();
    expect(dashboard.pending ?? []).toEqual([]);
    expect(JSON.stringify(dashboard)).not.toContain(data.draft.id);
    await page.goto(`/dashboard/history?id=${data.draft.id}`);
    await expect(page.getByRole("alert").filter({ hasText: "접근 권한이 없습니다." })).toBeVisible();
    await expect(page.getByRole("button", { name: "전표 저장", exact: true })).toHaveCount(0);
  } finally { await fixture.cleanup(); }
});
