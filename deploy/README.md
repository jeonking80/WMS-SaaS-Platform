# Production deployment

The recommended first host is Railway: one Docker web service and one private PostgreSQL service. It supplies HTTPS, service variables and persistent PostgreSQL without a GitHub Actions workflow. A hosting account, project, billing choice and domain are still required before an external deployment can be made. Do not publish the development database or reuse its passwords.

## Container contract

The Docker builder sets `WMS_STANDALONE=1`; ordinary local builds retain support for `next start`. Build the default `runner` target with `docker build -t wms-web:local .`. It runs as the nonroot `node` user, binds `0.0.0.0:$PORT` (default 3000), and includes standalone Next.js and static assets. Build-time environment files and credentials are excluded. Inject `DATABASE_URL` (restricted `wms_app`), a random `BETTER_AUTH_SECRET` of at least 32 characters, and `BETTER_AUTH_URL` (the exact public HTTPS origin) at runtime. Never pass these as Docker build arguments. `/api/health` is process liveness; `/api/ready` returns 200 only when the application role can query the migrated tenants table, otherwise 503. Use readiness for hosting health checks. A web deployment does not run migrations automatically.

The separate `operations` target includes migration dependencies and scripts. Build with `docker build --target operations -t wms-operations:local .`. It defaults to `npm run db:migrate`; pass another command explicitly for role bootstrap. It has no public server. Supply administrator and migration credentials only to short-lived operations jobs, never to the web service. Restrict and remove operations job bindings after use.

## Railway steps

1. Create a Railway project and PostgreSQL service. Keep PostgreSQL private; do not enable a public TCP proxy for normal operation. Use its private hostname and database in all three database URLs below.
2. Create a web service from this repository with the root Dockerfile and default target. Disable automatic deployment until local `npm run verify` passes and controlled migration/deployment checks are complete. Do not create GitHub Actions. Set `DATABASE_URL` to a new `wms_app` credential, `BETTER_AUTH_SECRET` to a newly generated secret, and `BETTER_AUTH_URL` to the generated HTTPS domain (or final custom domain). Set the health check path to `/api/ready`. Keep the provided deployment at one web instance. Railway supplies `PORT`; the container reads it.
3. Run a temporary service/job in the same project/private network using the dedicated `deploy/Dockerfile.operations` Dockerfile with repository root build context (`docker build -f deploy/Dockerfile.operations -t wms-operations:local .`), or a separately built operations image. For a Railway repository service, set its `RAILWAY_DOCKERFILE_PATH` variable to `deploy/Dockerfile.operations`; this selects the dedicated job Dockerfile. Bind `BOOTSTRAP_DATABASE_URL` to the database administrator, `MIGRATION_DATABASE_URL` to a new `wms_migrator` credential, and `DATABASE_URL` to the same new `wms_app` credential as the web service. URL-encode passwords. All URLs must target the same host, port and database; bootstrap enforces this. Run, in order: `npm run db:bootstrap`, `npm run db:migrate`, then `npm run db:bootstrap -- --grant`. Each must exit successfully. Then run `npm run db:check` with the application binding. These roles have distinct passwords; the web role has no superuser, ownership or migration privileges.
4. Remove administrator bindings from the operations service after bootstrap. Retain the migrator credential only in a restricted migration job for later releases. Remove the temporary service when finished. Deploy the web service and verify HTTPS `/api/health` and `/api/ready`, login, tenant separation, and the role restrictions before sharing access.
5. Configure PostgreSQL backups and retention through the host. Keep a separately stored backup and test restoration into a separate database before launch. Later releases require backup, controlled migrations, readiness checks and a tested compatible rollback plan.

Authentication rate limits use PostgreSQL: `src/server/auth/rate-limit.mjs` selects database storage, `src/server/auth/config.ts` applies it, and migration `1792368000018_v2-security-persistence.sql` creates the shared `rateLimit` table. Sessions and protected-request idle-lock state are also database-backed.

The provided deployment still uses one web instance. Multi-instance routing, concurrent authorization and replay behavior, framework cache coordination, and graceful draining remain unvalidated. The current pool limit is five connections per web process (`src/server/db/pool.ts`); adding a second unchanged process would allow ten rather than preserve an aggregate cap of five. This documentation correction changes no replica configuration or resource allocation.

Self-registration is disabled. Existing development `db:seed` / `auth:seed` are not a production identity provisioning workflow: `auth:seed` refuses `NODE_ENV=production`. Provision production tenants, initial administrator and memberships through a reviewed operator process before allowing users in. Do not change `NODE_ENV` to bypass the seed guard. For a synthetic demonstration only, create a separate database named `wms_demo` (the Compose default), set `WMS_DEMO_SEED=synthetic-only`, `DEMO_DATABASE_NAME=wms_demo` and three distinct random `DEMO_VIEWER_PASSWORD`, `DEMO_WORKER_PASSWORD`, `DEMO_ADMIN_PASSWORD` values of 16–128 characters in the operations job. Run `node scripts/demo-seed.mjs` after migrations and grants. These values must differ from the old `DEMO_PASSWORD`; never bind any demo passwords to the web service. With Compose, run `docker compose --env-file deploy/production.env -f deploy/compose.yaml run --rm operations node scripts/demo-seed.mjs`. Remove the demo password bindings afterward and retain private administrator/worker credentials securely. This command refuses databases without an explicit matching demo name and only provisions synthetic data. Business production provisioning still requires a reviewed operator process; this is not an open signup service.

For a public demonstration, share only a dedicated viewer account in an isolated demo tenant, keep administrator/worker credentials private, and prevent that viewer from reading real customer data. Never publish the six development accounts or their shared `DEMO_PASSWORD`. Public viewer access requires a separate, deliberately provisioned identity; the deployment does not create one automatically.

## Optional self-hosted Compose

`deploy/compose.yaml` leaves the repository's local-development compose file unchanged. It creates its own database volume and internal database network, without publishing PostgreSQL. The web port binds only to host loopback; place a trusted HTTPS reverse proxy on that host in front of it. The example does not install or configure TLS itself.

Copy `deploy/environment.example` to an ignored `deploy/production.env` or a secure file outside the checkout, replace every placeholder and set permissions to 600. Use the same file for each command:

```sh
docker compose --env-file deploy/production.env -f deploy/compose.yaml build
docker compose --env-file deploy/production.env -f deploy/compose.yaml --profile operations build operations
docker compose --env-file deploy/production.env -f deploy/compose.yaml up -d db
docker compose --env-file deploy/production.env -f deploy/compose.yaml run --rm operations npm run db:bootstrap
docker compose --env-file deploy/production.env -f deploy/compose.yaml run --rm operations npm run db:migrate
docker compose --env-file deploy/production.env -f deploy/compose.yaml run --rm operations npm run db:bootstrap -- --grant
docker compose --env-file deploy/production.env -f deploy/compose.yaml run --rm operations npm run db:check
docker compose --env-file deploy/production.env -f deploy/compose.yaml up -d web
curl --fail http://127.0.0.1:3000/api/ready
```

Remove `BOOTSTRAP_DATABASE_URL` from the retained environment file after bootstrap; keep administrative recovery credentials separately. For subsequent migrations use the operations image with only its migration binding. Never run `down -v` on a database you need to preserve. Host environment files remain secrets and must not be committed, included in image contexts, or pasted into logs. Avoid logging expanded `docker compose config` output because it contains resolved credentials.

For a corporate proxy build, forward Docker's predefined `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY` build arguments and optionally supply `--secret id=build_ca,src=/path/to/trusted-proxy-ca.pem`. The optional certificate is mounted only during dependency installation; it is not copied into image layers. Preserve TLS verification. Ordinary hosts do not need these options.
