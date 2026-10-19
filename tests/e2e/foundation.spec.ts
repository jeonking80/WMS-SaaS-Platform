import { expect, test } from "@playwright/test";

test("초기 화면은 프로젝트와 현재 개발 상태를 명시한다", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "WMS Lite", exact: true })).toBeVisible();
  await expect(page.getByTestId("development-status")).toContainText("초기 개발 단계");
});

test("앱 생존 확인 API는 캐시하지 않는 상태 응답을 반환한다", async ({ request }) => {
  const response = await request.get("/api/health");

  expect(response.status()).toBe(200);
  expect(await response.json()).toEqual({ status: "ok" });
  expect(response.headers()["cache-control"]).toContain("no-store");
});

test("준비 상태 API는 실제 PostgreSQL 연결을 확인한다", async ({ request }) => {
  const response = await request.get("/api/ready");

  expect(response.status()).toBe(200);
  expect(await response.json()).toEqual({ status: "ok", database: "ok" });
  expect(response.headers()["cache-control"]).toContain("no-store");
});
