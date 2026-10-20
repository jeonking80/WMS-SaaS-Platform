import { expect, it } from "vitest";
import { parseMasterSearch } from "../../src/server/master-search";
it("defaults history options to all items and accepts explicit active filtering", () => {
  expect(parseMasterSearch(new URLSearchParams(), true)).toMatchObject({ page: 1, page_size: 20, active: null });
  expect(parseMasterSearch(new URLSearchParams("active_only=true&q=%25_"), true)).toMatchObject({ active: true, q: "%_" });
  expect(parseMasterSearch(new URLSearchParams("active=false"))).toMatchObject({ active: false });
});
it.each(["page=0", "page=1e2", "page_size=101", "active=1", "id=bad", `q=${"x".repeat(101)}`])("rejects unsafe search boundaries %s", query => {
  expect(() => parseMasterSearch(new URLSearchParams(query), !query.startsWith("active="))).toThrow("INVALID_INPUT");
});
