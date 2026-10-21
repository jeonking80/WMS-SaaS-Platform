# Local Docker packaging qualification

The actual Dockerfile runner image built and passed default, one-worker and two-worker startup/stop smoke checks. No production source or default deployment command changed. This is packaging evidence, not production deployment or G3 qualification.

The build used an isolated archive of commit `42331d6`, the existing proxy configuration and a BuildKit CA secret mount. Image ID: `sha256:e351063cc92994b83f0038f7d2595ad2f3e7461583dc94b2049cddceccaaaf77`. Its independently rebuilt application ID is `f_DWG69-PYlFqbx_VooP5`; the source previously passed full verification as standalone build `ygoExTu2jqOW7riRXrCxw`. The image did not receive another complete E2E suite. Later schema 21 changes are outside this image.

| Mode | Startup and readiness | Observed worker pools | Stop |
| --- | --- | --- | --- |
| Existing default `node server.js` | Passed | Unmanaged single process | Exit 143, no OOM |
| Optional launcher, one worker | Passed aggregate health check | 5 | Exit 0, no OOM |
| Optional launcher, two workers | Passed aggregate health check | 3 + 2 | Exit 0, no OOM |

The runner uses the non-root `node` user. All seven deployment modules were present, including the corrected supervisor and lifecycle preload. Worker environments contained no operations database bindings. The image retained its original default command. The final filesystem had no `.env` or private binding files; its one package symlink resolved within `/app`. Scanning 7,713 regular files against 35 known private runtime/API binding values found zero matches. This bounded scan is not proof against every unknown secret.

A separate read-only saturation case held an isolated workflow header lock and issued ten workflow GET requests. Five live application backends were observed, then one worker was killed. Its replacement became healthy; six requests lost transport and four completed with HTTP 200. No POST retry or physical stock command was involved. Across 88 samples spaced 25 ms apart, the maximum observed application backend count was five. Sampling does not prove an instantaneous absolute cap between observations.

Only the fresh isolated PostgreSQL database on private port 55439 was used. Web containers had explicit 4 CPU and 32 GiB limits, but a common effective resource ancestor with PostgreSQL was not established. No throughput comparison was performed. The harness mirrored separate database and frontend networks; the full Compose deployment, HTTPS ingress and reverse proxy were not exercised.

All web containers stopped cleanly. The heavy build and runtime slot were released before subsequent work. Private logs, external runtime bindings and preserved harness failures remain under `/tmp/wms-cluster-docker-qualification-20261021`. The original failed-run databases, dump and evidence remain unchanged.
