# Schema 20 bounded ON/OFF observation

Build `2rKXP8Qbi54h8gu6e8KB5` ran against two fresh schema-20 copies restored from the same immutable failed-run archive. Complete original business parity and pairwise parity passed before processing. ON ran first, OFF second, sequentially without competing workload. Both completed 12 successful HTTP requests and applied all 112 selected events, with no business rejections, dependency waits, technical retries or quarantine outcomes. Both runtimes were stopped; port 3024 had no listener at 2026-10-21 00:13:26.874879 UTC.

| Client complete-body/JSON time | ON company 1 ms | OFF company 1 ms | ON company 2 ms | OFF company 2 ms |
| --- | ---: | ---: | ---: | ---: |
| Workflow GET before | 220.57 | 211.49 | 161.13 | 145.40 |
| Process limit 1 | 229.14 | 231.97 | 161.56 | 180.86 |
| Process limit 5 | 849.76 | 911.81 | 737.85 | 773.98 |
| Process limit 50 | 7910.38 | 7484.68 | 7896.40 | 7680.78 |
| Workflow GET after | 208.37 | 185.27 | 172.64 | 171.14 |

Across all requests, client elapsed totaled 18,718.72 ms ON and 18,141.15 ms OFF. This single ordered pair does not isolate instrumentation overhead: cache/order and system variation remain confounders, and some individual OFF requests were slower. No overhead estimate was subtracted.

The six ON processing requests totaled 17,735.66 ms server elapsed. The main observed inclusive spans were:

| Processing span | Total ms |
| --- | ---: |
| State lock/read await | 5685.64 |
| State clone | 3022.18 |
| Engine, including nested work | 3431.51 |
| Persist JSON | 1393.94 |
| Persist SQL awaits | 749.96 |
| Pool acquisition, 118 acquisitions | 5.12 |
| Connection held | 17697.40 |

These spans overlap and cannot be summed as a breakdown. State lock/read awaits include database execution, lock waits, transport, default JSON parsing and event-loop delay; they do not isolate lock time or SQL CPU. Under this sequential workload, pool acquisition was small relative to time holding a connection. This says little about pool contention under concurrent load.

The four ON workflow GETs totaled 613.55 ms server elapsed, including 234.94 ms state lock/read awaits and 114.91 ms snapshot clones. Client times additionally include HTTP body transfer and JSON decoding. ON collector records retain timer/bookkeeping/finalization measures, but logging overhead is unmeasured. OFF produced no diagnostic records.

The earlier schema-19 ON observation had process-50 client times 11,772.52/11,224.77 ms and processing persist-SQL awaits totaling 13,191.20 ms, compared with current ON 7,910.38/7,896.40 ms and 749.96 ms. Those are descriptive observations from different builds, not a controlled storage-only comparison. State reads and cloning remain material measured work in the new build. This bounded run does not establish official congestion qualification or recovery success; the original run remains FAIL.

[Sanitized JSON evidence](v2-timing-schema20-results.json) retains both client reports, all 12 ON server records, aggregate outcomes, exact build and freeze hashes, and interpretation limits. Private credentials, business identifiers, payloads and ordinary logs are excluded. The copies have now received their bounded processing writes and must not be described as unused snapshots. Frozen18, the immutable dump, prior diag19 evidence and original failed reports remain preserved.
