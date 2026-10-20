import { expect, type Page } from "@playwright/test";

/** Open the same persisted document through the business number shown to operators. */
export async function openDocument(page: Page, id: string, history = false) {
  const response = await page.request.get(`/api/documents/${id}${history ? "?view=history" : ""}`);
  expect(response.status()).toBe(200);
  const { document } = await response.json();
  expect(document.document_number).toMatch(/^[A-Z]+-\d+/);
  await page.getByRole("button", { name: `전표 ${id} 열기`, exact: true }).click();
}
