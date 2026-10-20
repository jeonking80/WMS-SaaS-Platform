import { randomUUID } from "node:crypto";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import pg from "pg";

const origin = "http://127.0.0.1:3100";
const tenant = "00000000-0000-4000-8000-000000000001";
const provider = "https://t1.daumcdn.net/mapjsapi/bundle/postcode/prod/postcode.v2.js";
const address = { postal_code: "04524", address_line1: "서울특별시 중구 세종대로 110", address_line2: "테스트 3층" };
async function login(request: APIRequestContext, email: string) {
  if (!process.env.DEMO_PASSWORD) throw new Error("DEMO_PASSWORD is required.");
  await request.post("/api/auth/sign-out", { headers: { origin }, data: {} });
  for (let attempt = 0; attempt < 4; attempt++) {
    const response = await request.post("/api/auth/sign-in/email", { headers: { origin }, data: { email, password: process.env.DEMO_PASSWORD } });
    if (response.status() !== 429 || attempt === 3) { expect(response.status()).toBe(200); return; }
    await new Promise(resolve => setTimeout(resolve, Math.min(10, Math.max(1, Number(response.headers()["retry-after"] ?? 10))) * 1000 + 250));
  }
}
function fixtures() {
  const connectionString = process.env.MIGRATION_DATABASE_URL;
  if (!connectionString) throw new Error("MIGRATION_DATABASE_URL is required.");
  const url = new URL(connectionString);
  if (!["127.0.0.1", "localhost"].includes(url.hostname) || !["/wms_lite", "/wms_test"].includes(url.pathname)) throw new Error("Destination fixtures require an isolated local database.");
  const pool = new pg.Pool({ connectionString, max: 1 });
  const ids: string[] = [];
  return { ids, async cleanup() {
    try {
      await pool.query("BEGIN");
      await pool.query("SELECT set_config('app.tenant_id', $1, true)", [tenant]);
      await pool.query("DELETE FROM delivery_destinations WHERE id=ANY($1::uuid[])", [ids]);
      await pool.query("COMMIT");
    } catch (error) { await pool.query("ROLLBACK"); throw error; } finally { await pool.end(); }
  } };
}
async function outboundForm(page: Page) {
  await page.goto("/dashboard/documents");
  await page.getByRole("button", { name: "새 전표", exact: true }).click();
  await page.getByRole("combobox", { name: "전표 유형", exact: true }).selectOption("OUTBOUND");
}
// Exercise the production loader and embed callback without any external network dependency.
const providerScript = `window.daum = { Postcode: function(options) { this.embed = function(host) {
 const button = document.createElement('button'); button.type = 'button'; button.textContent = '테스트 도로명 주소 선택';
 button.onclick = function() { options.oncomplete({ zonecode: '04524', roadAddress: '서울특별시 중구 세종대로 110', jibunAddress: '서울특별시 중구 태평로1가 31', userSelectedType: 'R' }); };
 host.appendChild(button);
} } };`;

test("admin registers a searched address inline, retries provider failure, and reuses the saved destination", async ({ page }) => {
  test.setTimeout(120_000);
  const fixture = fixtures();
  const recipient = `DEST-${randomUUID()}`;
  let attempts = 0;
  await page.route(provider, async route => {
    attempts++;
    if (attempts === 1) await route.abort("failed");
    else await route.fulfill({ contentType: "application/javascript", body: providerScript });
  });
  try {
    await login(page.request, "admin.a@example.test");
    await outboundForm(page);
    await page.getByRole("button", { name: "새 배송지 등록", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "새 배송지 등록", exact: true });
    await dialog.getByLabel("받는 거래처", { exact: true }).fill(recipient);
    await dialog.getByLabel("배송지 이름", { exact: true }).fill("본사");
    await dialog.getByRole("button", { name: "주소 검색", exact: true }).click();
    const search = page.getByRole("dialog", { name: "우편번호 · 주소 검색", exact: true });
    await expect(search.getByRole("alert")).toContainText("다시 시도");
    await search.getByRole("button", { name: "주소 검색 다시 시도", exact: true }).click();
    await search.getByRole("button", { name: "테스트 도로명 주소 선택", exact: true }).click();
    await expect(search).toHaveCount(0);
    await expect(dialog.getByLabel("우편번호", { exact: true })).toHaveValue(address.postal_code);
    await expect(dialog.getByLabel("기본 주소", { exact: true })).toHaveValue(address.address_line1);
    await dialog.getByLabel("상세주소", { exact: true }).fill(address.address_line2);
    const created = page.waitForResponse(r => r.url().endsWith("/api/delivery-destinations") && r.request().method() === "POST");
    await dialog.getByRole("button", { name: "배송지 등록", exact: true }).click();
    const response = await created;
    expect(response.status()).toBe(201);
    const destination = (await response.json()).destination;
    fixture.ids.push(destination.id);
    expect(destination).toMatchObject({ recipient_name: recipient, name: "본사", ...address });
    expect(attempts).toBe(2);
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId("destination-summary")).toContainText(recipient);
    await expect(page.getByTestId("destination-summary")).toContainText(`${address.address_line1} ${address.address_line2}`);
    await expect(page.getByRole("textbox", { name: "배송지", exact: true })).toHaveCount(0);
    await outboundForm(page);
    await page.getByLabel("거래처·배송지 검색", { exact: true }).fill(destination.recipient_name);
    await page.getByRole("button", { name: new RegExp(`${destination.recipient_name} · ${destination.name}`) }).click();
    await expect(page.getByTestId("destination-summary")).toContainText(recipient);
    await expect(page.getByTestId("destination-summary")).toContainText(destination.delivery_address);
  } finally { await fixture.cleanup(); }
});

test("destination access is tenant scoped; workers select active entries while viewers cannot access them", async ({ page }) => {
  test.setTimeout(120_000);
  const fixture = fixtures();
  const body = { recipient_name: `ACCESS-${randomUUID()}`, name: "창고", ...address };
  const headers = { origin };
  try {
    await login(page.request, "admin.a@example.test");
    const created = await page.request.post("/api/delivery-destinations", { headers, data: body });
    expect(created.status()).toBe(201);
    const destination = (await created.json()).destination; fixture.ids.push(destination.id);
    await login(page.request, "worker.a@example.test");
    expect((await page.request.post("/api/delivery-destinations", { headers, data: body })).status()).toBe(403);
    expect((await page.request.patch(`/api/delivery-destinations/${destination.id}`, { headers, data: { active: false } })).status()).toBe(403);
    expect((await page.request.get("/api/delivery-destinations?include_inactive=true")).status()).toBe(403);
    await outboundForm(page);
    await expect(page.getByRole("button", { name: "새 배송지 등록", exact: true })).toHaveCount(0);
    await page.getByLabel("거래처·배송지 검색", { exact: true }).fill(destination.recipient_name);
    await page.getByRole("button", { name: new RegExp(`${destination.recipient_name} · ${destination.name}`) }).click();
    await expect(page.getByTestId("destination-summary")).toContainText(body.recipient_name);
    await login(page.request, "admin.b@example.test");
    const foreignList = await page.request.get(`/api/delivery-destinations?q=${encodeURIComponent(body.recipient_name)}`);
    expect(foreignList.status()).toBe(200);
    expect((await foreignList.json()).destinations).toEqual([]);
    expect((await page.request.get(`/api/delivery-destinations/${destination.id}`)).status()).toBe(404);
    expect((await page.request.patch(`/api/delivery-destinations/${destination.id}`, { headers, data: { active: false } })).status()).toBe(404);
    await login(page.request, "viewer.a@example.test");
    expect((await page.request.get("/api/delivery-destinations")).status()).toBe(403);
    expect((await page.request.get(`/api/delivery-destinations/${destination.id}`)).status()).toBe(403);
    expect((await page.request.post("/api/delivery-destinations", { headers, data: body })).status()).toBe(403);
  } finally { await fixture.cleanup(); }
});
