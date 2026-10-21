# syntax=docker/dockerfile:1
# No credentials are required at build time. Supply secrets only at runtime.
FROM node:24.19.0-bookworm-slim AS dependencies
WORKDIR /app
COPY --chmod=644 package.json package-lock.json ./
RUN --mount=type=secret,id=build_ca \
    if [ -f /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi; \
    npm ci --no-audit --no-fund --loglevel=http

# Explicitly selected operations image; never exposed as the web service.
FROM dependencies AS operations
ENV NODE_ENV=production
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node db ./db
USER node
CMD ["npm", "run", "db:migrate"]

FROM node:24.19.0-bookworm-slim AS integration-worker
WORKDIR /app
ENV NODE_ENV=production
COPY --chown=node:node src/server/v2/integration/worker.mjs ./worker.mjs
USER node
CMD ["node", "worker.mjs"]

FROM dependencies AS builder
ENV NEXT_TELEMETRY_DISABLED=1 WMS_STANDALONE=1
COPY . .
RUN npm run build

FROM node:24.19.0-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --chown=node:node deploy/cluster-*.mjs deploy/web-process-options.mjs ./deploy/
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/ready',{signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
