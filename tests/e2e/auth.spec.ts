import { expect, test, type Page } from "@playwright/test";

async function login(page: Page, email: string) {
  const password = process.env.DEMO_PASSWORD;
  if (!password) throw new Error("DEMO_PASSWORD is required to run authentication E2E tests.");
  await page.goto("/login");
  await page.getByLabel("이메일").fill(email);
  await page.getByLabel("비밀번호").fill(password);
  // All browser tests share localhost. Honor the real authentication limiter
  // instead of disabling it or assigning artificial client IP addresses.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const responsePromise = page.waitForResponse((response) =>
      response.url().endsWith("/api/auth/sign-in/email") && response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "로그인", exact: true }).click();
    const response = await responsePromise;
    if (response.status() !== 429 || attempt === 2) {
      expect(response.status()).toBe(200);
      break;
    }
    const retryAfter = Number(response.headers()["retry-after"] ?? "10");
    const seconds = Number.isFinite(retryAfter) ? Math.min(10, Math.max(0, retryAfter)) : 10;
    await page.waitForTimeout(seconds * 1_000 + 250);
  }
  await expect(page).toHaveURL(/\/dashboard$/);
}

test("미인증 사용자의 업무 화면과 사용자 API 접근을 거절한다", async ({ page }) => {
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/login$/);
  expect((await page.request.get("/api/me")).status()).toBe(401);
});

test("잘못된 자격 증명은 일반 오류를 표시하고 세션을 만들지 않는다", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("이메일").fill("missing@example.test");
  await page.getByLabel("비밀번호").fill("invalid-password-for-login");
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "로그인할 수 없습니다" })).toBeVisible();
  expect((await page.request.get("/api/me")).status()).toBe(401);
});

for (const account of [
  { email: "admin.a@example.test", role: "admin", label: "관리자" },
  { email: "worker.a@example.test", role: "worker", label: "작업자" },
  { email: "viewer.a@example.test", role: "viewer", label: "조회자" },
]) {
  test(`${account.label} 로그인 시 회사·역할을 표시하고 로그아웃 시 세션을 폐기한다`, async ({ page }) => {
    await login(page, account.email);
    await expect(page.getByTestId("current-company")).toHaveText("데모 고객사 A");
    await expect(page.getByTestId("current-role")).toHaveText(account.label);
    const response = await page.request.get("/api/me");
    expect(response.status()).toBe(200);
    expect(await response.json()).toMatchObject({
      user: { email: account.email }, tenant: { name: "데모 고객사 A" }, role: account.role,
    });
    await page.getByRole("button", { name: "로그아웃", exact: true }).click();
    await expect(page).toHaveURL(/\/login$/);
    expect((await page.request.get("/api/me")).status()).toBe(401);
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/login$/);
  });
}

test("같은 브라우저에서 A 로그아웃 후 B 로그인 시 회사 컨텍스트를 교체한다", async ({ page }) => {
  await login(page, "admin.a@example.test");
  await expect(page.getByTestId("current-company")).toHaveText("데모 고객사 A");
  const identityA = await (await page.request.get("/api/me")).json();
  await page.getByRole("button", { name: "로그아웃", exact: true }).click();
  await expect(page).toHaveURL(/\/login$/);
  await login(page, "admin.b@example.test");
  await expect(page.getByTestId("current-company")).toHaveText("데모 고객사 B");
  await expect(page.getByTestId("current-role")).toHaveText("관리자");
  await expect(page.getByText("데모 고객사 A", { exact: true })).toHaveCount(0);
  const response = await page.request.get("/api/me");
  expect(response.status()).toBe(200);
  const identityB = await response.json();
  expect(identityB.tenant.id).not.toBe(identityA.tenant.id);
  expect(identityB.user.email).toBe("admin.b@example.test");
});
