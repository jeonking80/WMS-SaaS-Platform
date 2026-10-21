import type { Lot, Task, WorkflowState } from "./types";

export function pendingGenericHold(lot: Lot) {
  return lot.hold + lot.pending + lot.normal > 0;
}
/** A direct lot assignment supersedes order inheritance. Never infer an ambiguous origin. */
export function genericHoldOwnership(
  state: Pick<WorkflowState, "orders" | "tasks">,
  lot: Lot,
): { task?: Task; requiresAssignment: boolean } {
  const direct = state.tasks.toReversed().find((task) => task.object_type === "hold" && task.object_id === lot.id);
  if (direct) return { task: direct, requiresAssignment: false };
  let orderId: string | undefined;
  if (lot.origin_order_id !== undefined) {
    if (!state.orders.some((order) => order.id === lot.origin_order_id)) return { requiresAssignment: true };
    orderId = lot.origin_order_id;
  } else {
    const candidates = state.orders.filter((order) => order.lines.some((line) => line.id === lot.line_id));
    if (candidates.length > 1) return { requiresAssignment: true };
    orderId = candidates[0]?.id;
  }
  return {
    task: orderId
      ? state.tasks.toReversed().find((task) => task.object_type === "order" && task.object_id === orderId)
      : undefined,
    requiresAssignment: false,
  };
}
