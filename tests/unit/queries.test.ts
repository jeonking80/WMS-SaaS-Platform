import { describe, expect, it } from "vitest";
import { literalSearch, parseQuery } from "../../src/server/queries";
const parse = (query: string) => parseQuery(new URLSearchParams(query));
describe("query boundaries", () => {
  it("defaults pagination and trims searches", () => {
    expect(parse("q=++hello++")).toMatchObject({ page: 1, page_size: 25, q: "hello", date_field: "created_at" });
  });
  it.each(["page=0", "page=-1", "page=1.5", "page=1e2", "page_size=101", "page_size=0", "warehouse_id=oops", "kind=DROP", "status=unknown", "date_field=note", "date_from=2025-02-29", "date_to=2026-13-01", "date_from=2026-02-03&date_to=2026-02-02", `q=${"x".repeat(101)}`])("rejects invalid boundary %s", query => {
    expect(() => parse(query)).toThrow("INVALID_INPUT");
  });
  it("accepts leap dates and normalizes UUID filters", () => {
    expect(parse("date_from=2024-02-29&warehouse_id=ABCDEFAB-0000-0000-0000-000000000001")).toMatchObject({ date_from: "2024-02-29", warehouse_id: "abcdefab-0000-0000-0000-000000000001" });
  });
  it("escapes LIKE wildcards and the escape character", () => {
    expect(literalSearch("10%_\\")).toBe("%10\\%\\_\\\\%");
  });
});
