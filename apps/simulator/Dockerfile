FROM node:24.19.0-bookworm-slim
WORKDIR /app
COPY --chown=node:node . .
RUN mkdir -p /app/data && chown node:node /app/data
USER node
ENV SIM_HOST=0.0.0.0 SIM_PORT=4310 SIM_DATABASE=/app/data/simulator.sqlite
VOLUME ["/app/data"]
EXPOSE 4310
CMD ["node","server.mjs"]
