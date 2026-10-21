import type { Stock, WorkflowState } from "./types";

const brand: unique symbol = Symbol("owned workflow state");
export type OwnedWorkflowState = { readonly [brand]: true };
type Accounting = { ledger_count?: number; ledger: { length: number } };
type Ownership = { state: WorkflowState; previousStock: Stock[]; accounting: Accounting };
const handles = new WeakMap<object, Ownership>(),
  claimed = new WeakSet<WorkflowState>();
/** Internal capability factory. Storage must establish fresh UPDATE-read provenance
 * before calling; no request payload or response option grants ownership. */
export function ownDetachedWorkflowState(state: WorkflowState): OwnedWorkflowState {
  if (claimed.has(state)) throw new Error("Workflow state ownership already claimed");
  const previousStock = state.stock.map((row) => ({ ...row }));
  const accounting = { ledger_count: state.ledger_count, ledger: { length: state.ledger.length } };
  const handle = Object.freeze({}) as OwnedWorkflowState;
  claimed.add(state);
  handles.set(handle, { state, previousStock, accounting });
  return handle;
}
export function wasWorkflowStateOwned(state: WorkflowState) {
  return claimed.has(state);
}
/** Consume once on success or failure; a failed draft must be discarded. */
export function takeOwnedWorkflowState(handle: OwnedWorkflowState): Ownership {
  const owned = handles.get(handle);
  if (!owned) throw new Error("Workflow state ownership unavailable");
  handles.delete(handle);
  return owned;
}
