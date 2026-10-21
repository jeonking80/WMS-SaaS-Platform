# Controlled row versus ordered aggregate reader

The ordered aggregate candidate was slower in this bounded comparison. Keep the row reader as the performance baseline; these results do not support advancing this aggregation patch as a performance fix.

Both builds used separately restored, logically identical schema-20 copies of the same immutable failed-run archive. Complete initial business fingerprints and pairwise parity passed. Source hashes differ only for `src/server/v2/workflow/object-storage.ts`. Row build `2rKXP8Qbi54h8gu6e8KB5` ran first; aggregate build `5kXkW7jTmieNOSezqw_8E` second. Timing diagnostics were ON for both. Each made 12 successful requests and applied exactly 112 events, with zero business rejection, dependency wait, retry or quarantine outcomes.

| Complete-body/JSON client time | Row company 1 ms | Aggregate company 1 ms | Row company 2 ms | Aggregate company 2 ms |
| --- | ---: | ---: | ---: | ---: |
| Workflow GET before | 253.50 | 349.11 | 161.28 | 305.18 |
| Process 1 | 233.82 | 353.06 | 186.82 | 273.77 |
| Process 5 | 868.18 | 1433.43 | 854.36 | 1322.45 |
| Process 50 | 8400.67 | 12987.92 | 8319.82 | 12899.46 |
| Workflow GET after | 170.81 | 278.14 | 162.75 | 243.75 |

The 50-event batches were about 55% slower in both companies. All client requests totaled 19,783.38 ms for row and 30,615.21 ms for aggregate.

| Server processing, six requests | Row total ms | Aggregate total ms |
| --- | ---: | ---: |
| Request elapsed | 18807.53 | 29218.67 |
| State lock/read awaits | 6048.89 | 17464.76 |
| State clone | 3121.85 | 2868.49 |
| Snapshot clone | 40.63 | 44.63 |
| Persist SQL awaits | 753.64 | 989.85 |
| Persist JSON | 1466.82 | 1393.75 |

The four workflow GETs totaled 578.47 ms server elapsed for row versus 1008.87 ms for aggregate; state lock/read awaits were 226.66 versus 669.20 ms and snapshot clones 117.75 versus 127.02 ms. Inclusive spans overlap and must not be added. SQL/read awaits include execution, locks, transport, default JSON parsing and event-loop delay rather than isolated database CPU or lock time.

After both bounded sequences and server shutdown, separate read-only `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` observations ran against the matching reader query in each used copy. They were excluded from client timings. Row query execution was 13.891/11.140 ms; aggregate query execution was 141.910/125.443 ms. Both plans used an external merge sort with 4176/4208 KiB disk sort space. Top-level temp read blocks were 522/526, written blocks 523/527 for both query forms. Nested buffer fields overlap; do not sum them. Aggregate peak memory was not exposed in these plans, so no aggregate-memory bound is claimed.

Plan observations used application-role tenant context and explicit tenant/warehouse filters, with an empty user context rather than a machine actor. They are indicative SQL observations, not exact live-request RLS plans. Plans omit query text, identifiers, literals and conditions. Database temp counters are cumulative and may update asynchronously; query-level plan temp blocks are the direct spill evidence.

This is one sequential pair, so order, caches and system variation remain limitations. Matching outcomes, identical initial state, a single source-file difference, consistent batch regressions and separate query timing make this evidence useful for rejecting the candidate here; it is not full-load qualification. Original congestion failures remain unchanged.

Both owned runtimes were stopped between and after execution; port 3026 had no listener afterward. The comparison copies now include their bounded processing writes. Frozen18, the immutable dump, earlier used diagnostic copies and all prior reports were preserved. [Sanitized machine-readable evidence](v2-state-reader-comparison.json) includes both client reports, all 24 safe server records, aggregate timings and sanitized plans.
