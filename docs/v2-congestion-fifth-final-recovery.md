# Fifth official congestion run: FAILED, preserved

Run `1b846b73-9260-4171-9993-8822a05c8bec` used verified build `GgP2Fvn28yPhyBpYVJzWi`, source `39fa969`, schema 21, two web workers with pools 3+2, and native PostgreSQL within the proven common 4 CPU / 32 GiB envelope. Diagnostics were off. The original 5,400-event schedule, seed, rates, workers, thresholds and fixed 25/35-minute boundaries were unchanged.

Measured start was 03:34:07.074 UTC on 2026-10-21; exact 25 minutes was 03:59:07.074 and final bound was 04:09:07.074. The original report was generated at 04:09:11.115, with execution `interrupted` and verdict `failed`. No resume occurred.

| Evidence | Company 0 | Company 1 |
| --- | ---: | ---: |
| Normal acceptance p95, limit 1,000 ms | 1,850 ms | 1,942 ms |
| Normal application p95, limit 5,000 ms | 328,635 ms | 383,519 ms |
| Fixed peak cohort recovery, limit 600,000 ms | 591,714 ms; passed | 672,594 ms; 3 late; failed |
| Incomplete commands | 874 | 881 |
| Original quantity differences | 2,684 | 2,689 |
| Normal-window technical failures | 0 | 0 |

The single technical observation was a GET workflow request with status 0 and an incomplete response, ending 88 ms after the final deadline. It was a finalization observation; no HTTP 429 or 5xx response was recorded. Its timing does not by itself prove a transport failure cause.

After client exit, 11 samples established 10 seconds of quiet. Full snapshots and all 17,092 / 16,933 ledger rows matched the original report boundaries 8,713 / 8,679 exactly. Independent Python arithmetic found zero stock/ledger/completed-command differences, zero invalid stock/reservations and zero line constraint failures. This preserves a consistent final boundary; it does not clear the performance or original-quantity failures.

The application stopped gracefully by 04:12:25.148; native PostgreSQL stopped by 04:12:36.494. Ports 3030 and 55441 had no listeners. The owned execution lock was released, and all reports, journals, snapshots, ledger exports and native data remain preserved. The four earlier official failures and failed first preparatory namespace are unchanged.

[Machine-readable evidence and hashes](v2-congestion-fifth-final-recovery.json) include the frozen resource proof, original report SHA, exact checkpoints, quiet record, full export manifest, independent audit and stop records. The fixed 1.5-second congestion physical latency observation is supplementary; the normal shift profile owns that qualification. Neither the 1M benchmark nor the actual 8-hour run was started.
