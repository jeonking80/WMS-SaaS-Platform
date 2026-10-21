# Internal workflow state ownership

The workflow transaction service now consumes its fresh PostgreSQL state graph instead of deep-cloning that complete graph again inside the engine. Public `applyCommand` retains its `structuredClone` wrapper and unchanged-input contract. This change is not a cross-request cache or copy-on-write implementation, and it makes no measured throughput claim.

## Ownership boundary

Every new, non-replayed `executeWorkflowInTransaction` call uses the same owned engine path for full and compact responses. Ownership is granted only after the locked UPDATE read captured its immutable serialized persistence baseline and after the existing authorization, reference, assignment, legacy-history, correction and scan checks. No request field or response option grants ownership. Saved-request replay keeps its existing path.

`claimLoadedWorkflowState` requires the captured baseline. The internal capability is single-use: consuming removes its runtime handle before command execution, and a graph cannot be claimed twice. The graph must not be retained, reused or repersisted after a failed command. The capability factory is an internal module export used by storage and differential tests, not an HTTP authorization boundary.

Before mutation, ownership captures detached prior stock rows and the original ledger count/length scalars. Persistence compares current S/R/P/Q/B values with those detached rows. Engine ledger accounting uses the captured scalars. Simply aliasing `before` and `after` without these captures would skip changed-stock writes and lose newly added ledger counts.

The body writer continues comparing against the exact serialized baseline captured before legacy hydration. In-place changes cannot modify those strings. An owned graph without that capture fails closed; the writer cannot reconstruct its old baseline from the mutated graph. Full-state reads, required stock copies, all queries, live authority checks, barcode conversion, complete reconciliation, ledger writes and transaction boundaries remain in place.

## Failure and response lifetime

SQL rollback does not undo JavaScript mutations. An owned draft may be partly changed when a late line, reconciliation or persistence step fails, so it is discarded. The integration savepoint catch is outside the workflow invocation; a subsequent invocation reads a fresh database graph. CSV groups likewise invoke the service afresh. No draft is published to a cache or reused by a later command.

Full response materialization deep-clones the completed graph before response hydration. Compact materialization retains its existing top-level copy and cloned stock rows while sharing other bodies; legacy hydration can still update shared lot metadata after persistence. That graph is retired after the call and must not become a later persisted baseline. `withTenant` returns a response only after COMMIT succeeds; uncertain outcomes continue to use the original durable request/event identities.

## Focused validation

After application, the complete `tests/unit/v2-workflow.test.ts` file passed **63/63**, typecheck passed, and seven targeted PostgreSQL files passed **42/42**, all with exit code0. The unit file runs pure and owned execution with the same generated IDs, compares complete states/results and errors, verifies public input immutability and single-use capabilities, and requires successful coverage of all40 current commands. Run that file without a test-name filter because its final coverage assertion requires the complete suite.

The PostgreSQL targets covered workflow, response representation, domain boundaries, object storage, integration and pool behavior. They included missing-baseline rejection before writer SQL, late persistence rollback, savepoint rollback followed by a fresh compact retry on the same client/request identity, and subsequent full replay. Date/undefined/-0/BigInt/Map metadata checks preserve the ordinary engine's structured-clone semantics; JSON stringify/parse is not a replacement.

Logs are `/tmp/v2-owned-engine-unit.log`, `/tmp/v2-owned-engine-typecheck.log` and `/tmp/v2-owned-engine-pg.log`. Full local verification subsequently passed with exit code 0: 357 unit, 55 simulator, 211 PostgreSQL and 44 browser tests, plus typecheck and the standalone production build. Build `DsWNeYcKhO8by_QV1Sd2Z`; log `/tmp/wms-v2-owned-engine-full-verify.log`, SHA-256 `4b3d34e2fa4dfc790fdd5e77dde6ead1731a35d4ed348b98ecd5d9ce2839d4ff`. These local passes do not qualify deployment, recovery, throughput or the official performance gates. All five official congestion failures remain preserved; a controlled comparison is pending.

## Timing interpretation

The earlier schema20 `workflow.state_clone` aggregate includes both the full engine clone and stock-only clones in `lockState` and persistence. Subtracting that entire aggregate from inclusive engine time does **not** reveal nonclone engine cost or the amount this change can remove. Required stock copies remain, and ownership capture is timed under `workflow.state_clone` within `workflow.engine`. Benefit must be established by a controlled comparison after functional validation; historical aggregate spans alone cannot establish it.
