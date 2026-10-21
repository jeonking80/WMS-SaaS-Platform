import type { Stock } from "./types";

type LocationReference = { id: string; active?: boolean; reservation_blocked?: boolean; kind?: string };
/** Rebuild from current references; preserve Array.find's first duplicate match. */
export function refreshStockLocations(
  state: { stock: Stock[]; location_blocks?: { location_id: string }[] },
  locations: readonly LocationReference[],
) {
  const firstById = new Map<string, LocationReference>();
  for (const location of locations) if (!firstById.has(location.id)) firstById.set(location.id, location);
  const blocked = new Set((state.location_blocks ?? []).map((row) => row.location_id));
  for (const st of state.stock) {
    const ref = firstById.get(st.location_id);
    st.reservation_blocked = ref?.reservation_blocked === true || ref?.active === false || blocked.has(st.location_id);
    st.location_kind = ref?.kind;
  }
}
