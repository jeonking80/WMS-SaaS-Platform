import { request, type MasterRow } from "./api-client";

type Kind = "warehouses" | "locations";
type LookupPage = {
  warehouses: (MasterRow & { v2_active?: boolean })[];
  locations: MasterRow[];
  pagination: Record<Kind, { next_cursor: string | null }>;
};

/** Load every authorized page before exposing choices to legacy task screens. */
export async function loadLookups() {
  const initial = await request<LookupPage>("/api/lookups");
  const result = {
    warehouses: initial.warehouses,
    locations: initial.locations,
  };
  await Promise.all((["warehouses", "locations"] as const).map(async kind => {
    let cursor = initial.pagination[kind].next_cursor;
    const seen = new Set<string>();
    while (cursor) {
      if (seen.has(cursor)) throw new Error("기준정보 페이지가 반복됩니다. 새로고침 후 다시 확인하세요.");
      seen.add(cursor);
      const page = await request<LookupPage>(`/api/lookups?${new URLSearchParams({ kind, after: cursor })}`);
      result[kind].push(...page[kind]);
      cursor = page.pagination[kind].next_cursor;
    }
    // Cursor order is immutable ID order; keep familiar code ordering in the UI.
    result[kind] = [...new Map(result[kind].map(row => [row.id, row])).values()]
      .sort((a, b) => a.code.localeCompare(b.code) || a.id.localeCompare(b.id));
  }));
  return result;
}
