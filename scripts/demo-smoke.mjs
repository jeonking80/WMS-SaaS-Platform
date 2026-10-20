/** Read-only role checks; optional 180-second authenticated screencast. No login UI is recorded. */
import { chromium, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const origin = new URL(process.env.DEMO_ORIGIN ?? 'http://127.0.0.1:3000').origin;
if (!origin.startsWith('https://') && !/^http:\/\/(127\.0\.0\.1|localhost):/.test(origin)) throw new Error('Use HTTPS or a loopback origin.');
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined });
const contexts = [];
async function request(context, path, status = 200, method = 'get', data) {
  const response = await context.request[method](path, { headers: { Origin: origin }, data });
  if (response.status() !== status) throw new Error(`${method} ${path}: expected ${status}, got ${response.status()}`);
  return response;
}
try {
  for (const role of ['viewer','worker','admin']) {
    const password = process.env[`DEMO_${role.toUpperCase()}_PASSWORD`];
    if (!password) throw new Error(`DEMO_${role.toUpperCase()}_PASSWORD required.`);
    const context = await browser.newContext({ baseURL: origin, viewport: { width: 1440, height: 1000 } });
    contexts.push(context);
    let signedIn = false;
    for (let attempt=0; attempt<4; attempt++) {
      const response = await context.request.post('/api/auth/sign-in/email', { headers:{Origin:origin}, data:{email:`${role}@wms-demo.example.test`,password} });
      if (response.ok()) { signedIn=true; break; }
      if (response.status()!==429) throw new Error(`Demo login failed: HTTP ${response.status()}`);
      const seconds=Number(response.headers()['retry-after'] ?? 10);
      await delay(Math.min(60,Math.max(1,Number.isFinite(seconds)?seconds:10))*1000+250);
    }
    if (!signedIn) throw new Error('Demo login rate limit persisted.');
    const me = await (await request(context,'/api/me')).json();
    if (me.role !== role || me.tenant?.id !== '70000000-0000-4000-8000-000000000001') throw new Error('Incorrect demo identity.');
    for (const path of ['/api/dashboard','/api/stock','/api/stock-ledger','/api/documents?view=history','/api/documents/70000000-0000-4000-8000-000000000020?view=history']) await request(context,path);
    await request(context,'/api/audit-logs',role==='admin'?200:403);
    const reconciliation = await (await request(context,'/api/stock/reconcile')).json();
    if (reconciliation.consistent !== true) throw new Error('Stock reconciliation failed.');
    await request(context,'/api/items', role === 'viewer' ? 403 : 200);
    await request(context,'/api/documents', role === 'viewer' ? 403 : 200);
    if (role !== 'admin') await request(context,'/api/items',403,'post',{});
    if (role === 'viewer') {
      await request(context,'/api/documents',403,'post',{});
      await request(context,'/api/documents/70000000-0000-4000-8000-000000000020',403);
    }
    console.log(`Demo ${role}: tenant, history, stock reconciliation and role restrictions passed.`);
    if (role === 'viewer' && process.env.DEMO_RECORD_VIDEO === '1') {
      const directory = resolve(process.env.DEMO_VIDEO_DIR ?? '/tmp/wms-demo-video');
      await mkdir(directory, { recursive: true });
      // Transfer only the authenticated viewer session into the recording context.
      const recording = await browser.newContext({ baseURL: origin, storageState: await context.storageState(), viewport:{width:1440,height:1000}, recordVideo:{dir:directory,size:{width:1440,height:1000}} });
      contexts.push(recording);
      const page = await recording.newPage();
      const started = Date.now();
      for (const [path,caption,seconds] of [
        ['/dashboard','합성 데이터 · 공개 조회 전용 시연',35],
        ['/dashboard/stock','현재 재고와 입출고·이동 원장',45],
        ['/dashboard/history','확정 전표 이력 · 읽기 전용 조회',40],
        ['/dashboard/stock?item_id=70000000-0000-4000-8000-000000000010','원두 입출고·이동 수량 확인',30],
        ['/dashboard','권한·테넌트 격리와 원장 대조는 별도 자동 검증',30],
      ]) {
        await page.goto(path);
        await expect(page.locator('main')).toBeVisible();
        await page.evaluate(caption => {
          const label=document.createElement('div'); label.textContent=caption;
          label.style.cssText='position:fixed;bottom:16px;left:16px;z-index:99999;padding:12px 20px;background:#10243a;color:white;border-radius:8px;font:18px sans-serif';
          document.body.appendChild(label);
        },caption);
        if (path === '/dashboard/history') {
          await page.getByRole('button',{name:/전표 .* 열기/}).first().click();
          await expect(page.getByRole('heading',{name:'전표 상세 / 수정'})).toBeVisible();
          await page.getByRole('heading',{name:'전표 상세 / 수정'}).scrollIntoViewIfNeeded();
        }
        if (path.includes('item_id=')) {
          await page.getByLabel('검색어').first().fill('DEMO-COFFEE');
          await page.getByRole('button',{name:'검색 적용',exact:true}).first().click();
          await expect(page.locator('tbody tr').first()).toBeVisible();
        }
        await page.waitForTimeout(seconds*1000);
      }
      await recording.close(); contexts.splice(contexts.indexOf(recording),1);
      console.log(`Viewer screencast saved: ${await page.video().path()} (${Math.round((Date.now()-started)/1000)} seconds).`);
    }
  }
} catch (error) {
  console.error(`Demo smoke failed: ${error.message}`); process.exitCode=1;
} finally { for (const context of contexts) await context.close(); await browser.close(); }
