# Fixed preaccepted cohort: processor time budget

The processor budget was adopted in source because it reduced client timeout exposure while preserving fixed-cohort completion and final conservation. This diagnostic does **not** establish G3 or official congestion qualification.

Both builds applied all 600 fixed cohort events. Baseline completed in 106.101 seconds (5.655 events/s); budget in 105.740 seconds (5.674 events/s). Completion throughput was essentially unchanged, while responses became shorter and processor requests increased.

| Metric | Baseline | Budget |
| --- | ---: | ---: |
| Processor POSTs | 25 | 40 |
| Client 15-second timeouts | 12 | 0 |
| Complete processor bodies | 13 | 40 |
| Processor client p95 ms | 15003.63 | 5382.91 |
| Processor client maximum ms | 15006.45 | 5449.89 |
| Events returned in complete bodies | 100 | 706 |
| Server committed applied events, including outside cohort | 695 | 706 |
| Source status GETs | 6476 | 6867 |
| Total HTTP requests | 6503 | 6909 |

Baseline requests continued committing after client timeouts, so complete-body return counts cannot measure throughput. All 600 cohort events were confirmed applied through original event-key GETs and final read-only database counts. Budget returned 15–21 events per call, median 18; complete baseline bodies returned either zero or 50. Processor POST count increased 60%. Company completion times were 102.703/106.101 seconds for baseline and 105.740/100.137 seconds for budget.

| Processing server spans, all requests | Baseline total ms | Budget total ms |
| --- | ---: | ---: |
| Request elapsed | 216984.57 | 209319.87 |
| Pool acquisition | 11601.26 | 11469.67 |
| Connection held | 203093.71 | 197149.08 |
| State lock/read awaits | 58065.25 | 55756.21 |
| State clone | 19762.96 | 19422.34 |
| Persist SQL awaits | 18569.99 | 17689.71 |
| Commit | 1281.29 | 1262.16 |
| Request telemetry | 2212.93 | 621.26 |

Requests overlap across companies, so these totals exceed wall-clock duration. Nested inclusive spans also overlap and must not be summed. SQL/read awaits include database execution, locks, transport, default JSON parsing and event-loop delay; they do not isolate database CPU or lock time. Maximum server processor elapsed was 15868.09 ms for baseline and 5411.77 ms for budget. This observed maximum does not make the soft budget a request deadline: an active transaction can still exceed five or 15 seconds.

Both fresh schema-20 copies matched the immutable original 18-migration dump and each other logically before execution. Baseline build `2rKXP8Qbi54h8gu6e8KB5` and candidate `B2lhC7WGVo-cXhsbawRWf` differed only in `src/server/v2/integration/index.ts`. Both used the same frozen client, timing ON, a 15-second complete-body/JSON timeout, 50 ms scheduling pulse, one processor lane with limit 50 per company, ten source-poll slots per company and 250 ms nonterminal poll backoff. Two companies ran concurrently; the baseline and budget modes ran sequentially without competing workload.

Each mode reached ten seconds of unchanged workflow versions with zero non-idle application database sessions before matching-boundary snapshot and complete ledger export. Baseline boundaries were 6990/6991; budget boundaries 6996/6996. Both exported 15326/15308 ledger rows, 31 pages per company. Independent Python arithmetic checked every stock bucket against all ledger deltas, nonnegative quantities, reservations no greater than stock, and order/receipt line conservation. Both modes had zero differences or failures. This is not a new physical-command intent oracle claim.

Both runtimes stopped, and port 3027 had no listener at 2026-10-21 01:22:51.809125 UTC. Previous diagnostic copies, the immutable dump and all original failure reports were preserved. The comparison copies now contain their diagnostic processing writes.

This preaccepted-backlog experiment had no source arrivals or physical workers. It cannot qualify an official arrival rate, full physical workflow or 25-minute recovery. A single ordered pair retains cache, order and system variation. The built-in background worker's short-batch delays differ from this profile-style driver and were not measured. Instrumentation was ON in both modes; no instrumentation overhead estimate was subtracted.

Verification provenance: 236 unit, 55 simulator and 188 PostgreSQL tests and the production build passed. The initial full verification exited 1 with 43 E2E passes and one warning-phase fixture failure. A test-only correction moved the warning poll from exactly 14 minutes to 14 minutes plus one second; that targeted test passed. The frozen production build was unchanged. This evidence does not claim a full verification exit 0 for that invocation.

[Sanitized JSON evidence](v2-process-budget-comparison.json) includes aggregate metrics, exact build/client/freeze hashes, cohort confirmation and export hashes. Compressed safe client reports and timing records are under `artifacts/v2-process-budget-comparison-20261021`; their hashes are recorded in the JSON. Credentials, event identities, business payloads and ordinary server logs are excluded. General server aggregates include separate final read-only exports; `integration.process` aggregates cover workload processing only, and client poll metrics exclude final exports.
