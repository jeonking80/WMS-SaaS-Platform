import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext } from '@playwright/test';

const origin = 'http://127.0.0.1:3100';
const headers = { origin };
type Snapshot = { stock: {item_id: string; S: number; R: number; P: number; Q: number; B: number; A: number; H: number}[]; receipts: {id: string; lines: {id: string}[]}[]; ledger: {request_id: string; bucket: string; delta: number}[] };
type Response = { result: {id: string}; snapshot: Snapshot; replayed: boolean };

async function login(request: APIRequestContext, email = 'admin.a@example.test', suppliedPassword?: string) {
  const password = suppliedPassword ?? process.env.DEMO_PASSWORD;
  if (!password) throw new Error('DEMO_PASSWORD is required.');
  await request.post('/api/auth/sign-out', { headers, data: {} });
  for (let attempt = 0; attempt < 4; attempt++) {
    const response = await request.post('/api/auth/sign-in/email', { headers, data: { email, password } });
    if (response.status() !== 429 || attempt === 3) { expect(response.status()).toBe(200); return; }
    const delay = Math.min(10, Math.max(1, Number(response.headers()['retry-after'] ?? 10)));
    await new Promise(resolve => setTimeout(resolve, delay * 1000 + 250));
  }
}

async function fixture(request: APIRequestContext) {
  const prefix = `V2-${randomUUID()}`;
  const warehouseResponse = await request.post('/api/warehouses', { headers, data: { code: prefix, name: prefix } });
  expect(warehouseResponse.status()).toBe(201);
  const warehouse = (await warehouseResponse.json()).warehouse.id as string;
  async function master(kind: string, data: Record<string, unknown>) {
    const response = await request.post(`/api/v2/masters/${kind}?warehouse_id=${warehouse}`, { headers, data });
    expect(response.status()).toBe(201);
    return (await response.json()).row.id as string;
  }
  const item = await master('items', { code: `${prefix}-SKU`, name: `${prefix} item` });
  const receiving = await master('locations', { code: `${prefix}-RCV`, name: `${prefix} receiving`, kind: 'RECEIVING' });
  const partner = await master('partners', { code: `${prefix}-BP`, name: `${prefix} partner`, supplier: true, customer: true });
  const destination = await master('destinations', { partner_id: partner, recipient_name: prefix, name: `${prefix} delivery`, address_line1: 'Synthetic acceptance address' });
  const receiptDefaults = { supplier_id: partner, expected_at: '2026-10-21T09:00:00.000Z' };
  async function command(command: string, payload: Record<string, unknown>, requestId: string = randomUUID()) {
    if (command === 'receipt.create') payload = { ...receiptDefaults, ...payload };
    if (command === 'order.create') payload = { delivery: { partner_id: partner, delivery_destination_id: destination }, due_at: '2026-10-21T09:00:00.000Z', ...payload };
    if (command === 'receipt.receive') payload = { manual_entry_reason: '수락검사 실물/위치 대조', ...payload, lines: (payload.lines as Record<string, unknown>[]).map(line => ({ input_mode: 'search', ...line })) };
    const response = await request.post('/api/v2/workflow', { headers, data: { warehouse_id: warehouse, command, request_id: requestId, payload } });
    expect(response.status()).toBe(200);
    return await response.json() as Response;
  }
  return { prefix, warehouse, item, receiving, command, receiptDefaults };
}

// Fixtures use unique warehouse scopes and remain as immutable test evidence.
// No direct DB write or business-history deletion is used by these browser tests.
test('v2 real HTTP contract isolates company results and enforces viewer permissions', async ({ request }) => {
  test.setTimeout(180_000);
  await login(request);
  const w = await fixture(request);
  const requestId: string = randomUUID();
  const payload = { ...w.receiptDefaults, lines: [{ item_id: w.item, quantity: 7 }], external_id: w.prefix };
  const first = await w.command('receipt.create', payload, requestId);
  const replay = await w.command('receipt.create', payload, requestId);
  expect(replay.replayed).toBe(true); expect(replay.result.id).toBe(first.result.id);
  const conflict = await request.post('/api/v2/workflow', { headers, data: { warehouse_id: w.warehouse, command: 'receipt.create', request_id: requestId, payload: { ...payload, external_id: `${w.prefix}-changed` } } });
  expect(conflict.status()).toBe(409);
  const missingOrigin = await request.post('/api/v2/workflow', { data: { warehouse_id: w.warehouse, command: 'receipt.create', request_id: randomUUID(), payload } });
  expect(missingOrigin.status()).toBe(403);
  const lookup = await request.get(`/api/v2/workflow?warehouse_id=${w.warehouse}&request_id=${requestId}`);
  expect(lookup.status()).toBe(200); expect((await lookup.json()).result.id).toBe(first.result.id);
  // Each run owns its viewer; repeated warehouse fixtures must not grow a shared
  // user's access list beyond the product's deliberate 100-warehouse limit.
  const viewerEmail = `viewer-${randomUUID()}@example.test`;
  const viewerPassword = `Viewer-${randomUUID()}-9!`;
  const invitation = await request.post('/api/v2/identity/users', { headers, data: { name: 'Isolated acceptance viewer', email: viewerEmail, role: 'viewer', warehouseIds: [w.warehouse] } });
  expect(invitation.status()).toBe(201);
  const issued = await invitation.json();
  const token = new URL(issued.link, origin).searchParams.get('token');
  expect(token).toBeTruthy();
  const accepted = await request.post('/api/v2/identity/accept', { headers, data: { token, password: viewerPassword } });
  expect(accepted.status()).toBe(200);
  try {
    await login(request, viewerEmail, viewerPassword);
    const read = await request.get(`/api/v2/workflow?warehouse_id=${w.warehouse}`);
    expect(read.status()).toBe(200); expect((await read.json()).snapshot.receipts[0].id).toBe(first.result.id);
    const denied = await request.post('/api/v2/workflow', { headers, data: { warehouse_id: w.warehouse, command: 'receipt.receive', request_id: randomUUID(), payload: { receipt_id: first.result.id, receiving_id: randomUUID(), lines: [{ line_id: first.snapshot.receipts[0].lines[0].id, quantity: 7, location_id: w.receiving }] } } });
    expect(denied.status()).toBe(403);
    await login(request, 'admin.b@example.test');
    for (const path of [`/api/v2/workflow?warehouse_id=${w.warehouse}`, `/api/v2/workflow?warehouse_id=${w.warehouse}&request_id=${requestId}`, `/api/v2/masters/items?warehouse_id=${w.warehouse}`]) {
      const response = await request.get(path); expect(response.status()).toBe(403);
      expect(JSON.stringify(await response.json())).not.toContain(first.result.id);
    }
  } finally {
    await login(request);
    const users = await (await request.get('/api/v2/identity/users')).json();
    const viewer = users.users.find((row: {email:string}) => row.email === viewerEmail);
    expect(viewer).toBeTruthy();
    expect((await request.patch(`/api/v2/identity/users/${viewer.userId}`, { headers, data: { status: 'suspended' } })).status()).toBe(200);
  }
});

test('v2 recovers the original committed receive request after a lost browser response and reload', async ({ page }) => {
  test.setTimeout(180_000);
  await login(page.request);
  const w = await fixture(page.request);
  const created = await w.command('receipt.create', { lines: [{ item_id: w.item, quantity: 3 }] });
  const me = await (await page.request.get('/api/me')).json();
  await page.goto('/dashboard/v2');
  await expect(page.getByRole('heading', { name: '현장 운영', exact: true })).toBeVisible();
  const input = { warehouse_id: w.warehouse, command: 'receipt.receive', request_id: randomUUID(), payload: { receipt_id: created.result.id, receiving_id: randomUUID(), manual_entry_reason: '수락검사 실물/위치 대조', lines: [{ line_id: created.snapshot.receipts[0].lines[0].id, quantity: 3, location_id: w.receiving, input_mode: 'search' }] } };
  let committed: Response | undefined;
  // Forward to the real server, then discard only the browser's response.
  await page.route('**/api/v2/workflow', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    const body = route.request().postDataJSON();
    if (body.request_id !== input.request_id) return route.continue();
    const upstream = await route.fetch();
    expect(upstream.status()).toBe(200);
    committed = await upstream.json() as Response;
    await route.abort('connectionreset');
  });
  const storageKey = `wms-v2:${me.tenant.id}:${me.user.id}:request`;
  await page.evaluate(async ({ input, storageKey }) => {
    localStorage.setItem(storageKey, JSON.stringify(input));
    try { await fetch('/api/v2/workflow', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }); } catch { /* Browser lost response after the real server committed. */ }
  }, { input, storageKey });
  expect(committed?.result.id).toBe(created.result.id);
  await page.unroute('**/api/v2/workflow');
  await page.reload();
  await expect(page.getByRole('heading', { name: '확정 결과 복구' })).toBeVisible();
  await expect(page.getByLabel('현재 창고', { exact: true })).toHaveValue(w.warehouse);
  await page.getByRole('button', { name: '원래 확정 결과 조회', exact: true }).click();
  await expect(page.getByRole('heading', { name: '확정 결과 복구' })).toHaveCount(0);
  await expect(page.getByRole('status').filter({ hasText: '이전 확정의 서버 결과를 확인했습니다' })).toBeVisible();
  expect(await page.evaluate(key => localStorage.getItem(key), storageKey)).toBeNull();
  const retried = await w.command('receipt.receive', input.payload, input.request_id);
  expect(retried.replayed).toBe(true);
  const snapshot = (await (await page.request.get(`/api/v2/workflow?warehouse_id=${w.warehouse}`)).json()).snapshot as Snapshot;
  expect(snapshot.stock.filter(row => row.item_id === w.item).reduce((sum, row) => sum + row.Q, 0)).toBe(3);
  expect(snapshot.stock.filter(row => row.item_id === w.item).reduce((sum, row) => sum + row.H, 0)).toBe(3);
  expect(snapshot.ledger.filter(row => row.request_id === input.request_id)).toEqual([expect.objectContaining({ bucket: 'Q', delta: 3 })]);
});

test('업무 홈의 승인 대기는 현재 창고의 실제 대기 승인 목록으로 연결된다', async ({page}) => {
  test.setTimeout(120_000);
  await login(page.request);
  const w = await fixture(page.request);
  const receipt = await w.command('receipt.create', {lines:[{item_id:w.item,quantity:2}],external_id:w.prefix});
  await w.command('receipt.close.request', {receipt_id:receipt.result.id,reason:'홈 승인 연결 검증용 잔량 마감 요청'});
  await page.goto(`/dashboard/v2?warehouse_id=${w.warehouse}&tab=queue`);
  const entry = page.getByRole('link',{name:'승인 대기 1건 검토',exact:true});
  await expect(entry).toHaveAttribute('href',`/dashboard/v2?warehouse_id=${w.warehouse}&tab=inventory&inventory_view=approval&approval_status=pending`);
  await entry.click();
  await expect(page.getByRole('tab',{name:'재고·실사·승인',exact:true})).toHaveAttribute('aria-selected','true');
  await expect(page.getByRole('button',{name:'승인',exact:true})).toHaveAttribute('aria-selected','true');
  const state = page.getByRole('combobox',{name:'승인 상태',exact:true});
  await expect(state).toHaveValue('pending');
  await expect(page.getByText('요청 사유: 홈 승인 연결 검증용 잔량 마감 요청',{exact:true})).toBeVisible();
  await state.selectOption('approved');
  await expect(page.getByText('선택한 상태의 승인 요청이 없습니다.',{exact:true})).toBeVisible();
  await expect(page.getByRole('heading',{name:/승인 1 · 예정 잔량 마감/})).toHaveCount(0);
  await state.selectOption('all');
  await expect(page.getByRole('heading',{name:/승인 1 · 예정 잔량 마감/})).toBeVisible();
  await page.reload();
  await expect(state).toHaveValue('pending');
  await expect(page.getByText('요청 사유: 홈 승인 연결 검증용 잔량 마감 요청',{exact:true})).toBeVisible();
});
