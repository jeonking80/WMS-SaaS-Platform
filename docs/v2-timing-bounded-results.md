# Isolated bounded timing observation

Build `4qCVxN_qG8SkhYcwTYCgG`, schema 19 diagnostic copy, instrumentation ON. All 12 requests succeeded; all 112 selected backlog events applied. The server was stopped afterward and port 3023 had no listener. The failed original run remains FAIL; this observation does not qualify load performance.

| Request | Company 1 client ms | Company 2 client ms |
| --- | ---: | ---: |
| Workflow GET before | 224.40 | 124.70 |
| Process limit 1 | 344.75 | 236.40 |
| Process limit 5 | 1216.88 | 1132.85 |
| Process limit 50 | 11772.52 | 11224.77 |
| Workflow GET after | 200.27 | 152.13 |

Across six processing requests, server request elapsed totaled 25,862.46 ms. Business pool acquisition totaled 5.00 ms across 118 acquisitions, while connection-held spans totaled 25,808.14 ms. The maximum observed pool waiting count was one. This sequential observation provides no evidence that pool acquisition dominated these requests; it cannot characterize concurrent pool contention in the original load run.

Processing spans included persist SQL awaits 13,191.20 ms, state lock/read awaits 4,520.16 ms, state clones 2,769.33 ms, engine spans 3,135.04 ms, and persist JSON 1,119.27 ms. These inclusive spans overlap, especially engine and clone work; do not sum them as a total or percentage breakdown. SQL awaits include database execution, lock waits, transport, default JSON parsing and event-loop delays. They do not isolate SQL CPU or lock time.

The four workflow GET requests totaled 534.86 ms server elapsed, with state lock/read awaits 194.18 ms and snapshot clones 105.79 ms. Client times include complete response body transfer and JSON decoding. Server elapsed ends before diagnostic output and HTTP transport.

No instrumentation-OFF comparison was run. Timer/bookkeeping/finalization fields cover partial collector costs; logging overhead is unmeasured and no overhead was subtracted. The initial copied runtime needed packaging-only fixes to its CommonJS launcher extension and Next bootstrap dependency copy; neither changed application source or build artifacts. Startup failures preceded client requests.

[Machine-readable safe evidence](v2-timing-bounded-results.json) includes all 12 allowlisted aggregate server records, client timings, build ID, freeze-manifest hash, and limitations. It excludes keys, business IDs, payloads and ordinary server logs. Private freeze/runtime files remain under `/tmp/wms-timing-diag19-4qCVxN_qG8SkhYcwTYCgG`. The frozen schema-18 copy and verified dump remain the preserved original source; the active diagnostic database alone received the bounded processing writes.
