# Sixth official congestion run: FAILED, preserved

Run `585faebc-1be1-4e52-9d8e-a3525707b548` used verified source `2aa2774`, build `Lb3NKb1lCgfxlUs60Wy1T`, schema 22, two workers/pools3+2 and native PostgreSQL within the proven common 4 CPU / 32 GiB budget. Diagnostics were OFF. All 12 simulator modules matched official fifth; the original 5,400arrivals, seed, rates, workers, timeouts and criteria were unchanged.

Measured start was **05:13:46.274 UTC** on 2026-10-21. Exact 25 minutes was 05:38:46.274; the retained checkpoint completed 793 ms later. Final 35 minutes was **05:48:46.274**. The original report was generated 05:48:51.476 with execution `interrupted` and verdict `failed`; no resume or deadline extension occurred.

| Result | Company 0 | Company 1 |
| --- | ---: | ---: |
| Normal acceptance p95, limit 1,000 ms | 1,629 ms | 1,611 ms |
| Normal application p95, limit 5,000 ms | 221,857 ms | 251,991 ms |
| Fixed peak recovery, limit 600,000 ms | 392,248 ms; passed | 413,808 ms; passed |
| Peak cohort late / unresolved | 0 /0 | 0 /0 |
| Incomplete commands, all unsent | 788 | 789 |
| Original quantity differences | 2,432 | 2,409 |
| Technical /429 attempts | 0 /0 | 0 /0 |

All 5,400 source events were accepted:5,280 applied and120 expected revision rejections. SQLite recorded 68,903 HTTP 200, 5,600 HTTP 202 and one 409; no transport status 0, 429 or 5xx attempts. Normal latency and completion remain failed even though both peak cohorts recovered. The original client integrity result remains false.

After client exit, 11 samples established 10 stable seconds with zero nonidle application sessions. Full snapshots and all **18,420 / 18,360 ledger rows** (37 pages each) matched the original final report boundaries **9,053 / 9,054** exactly. Independent Python arithmetic over every stock bucket, complete ledger and durable completed-command deltas found **zero differences**, zero invalid stock/reservations and zero line violations. This physical conservation result does not clear the incomplete original quantities or performance failures.

The cluster stopped gracefully by **05:50:02.948 UTC**; native PostgreSQL stopped by **05:50:17.086 UTC**. Ports 3033/55444 had no listeners, all owned processes were absent or inactive zombies, and the owned slot lock was released. Original reports, journal, snapshots, all ledgers, frozen files and native data remain preserved. The first sixth preparation was superseded before any formal client and is not counted as another run. All five earlier official failures remain unchanged.

Local correctness verification remains 359 unit / 55 simulator / 223 PostgreSQL / 44 E2E plus type/build pass. The actual schema 22 restore evidence from c9d4673 is retained with unchanged SQL/restore script; no new restore is claimed. Current scope is finished: no additional performance iteration, new run, 1M benchmark or actual8-hour profile was started.

[Machine-readable final evidence and hashes](v2-congestion-sixth-final-recovery.json) retain the exact 25-minute checkpoint, original peak identities, original report, quiet/full export manifest, independent audit, resource proof and stop records.
