import type { PoolClient } from "pg";
import { getPool } from "../../db/pool";
import { beginTiming, observeTimingPool, timeAsync } from "../../timing-diagnostics";
export type ApiMetric = {
  tenantId: string;
  warehouseId: string;
  requestId: string;
  actorId: string;
  operation: string;
  command?: string;
  method: string;
  status: number;
  errorCode: string;
  durationMs: number;
};
/** Runs after the business transaction completes. A telemetry outage never changes its response. */
export async function persistApiMetric(metric: ApiMetric): Promise<void> {
  let client: PoolClient | undefined;
  let pool: ReturnType<typeof getPool> | undefined;
  let discard = false;
  let endHeld: (failed?: boolean) => void = () => {};
  try {
    const activePool = getPool();
    pool = activePool;
    observeTimingPool("telemetry", activePool);
    client = await timeAsync("telemetry.pool_acquire", () => {
      const pending = activePool.connect();
      observeTimingPool("telemetry", activePool);
      return pending;
    });
    endHeld = beginTiming("telemetry.connection_held");
    const connection = client;
    // BEGIN, the timeout and the RLS context share one round trip; this write sits on every request's path.
    const context = [
      ["app.tenant_id", metric.tenantId],
      ["app.user_id", metric.actorId],
      ["app.environment", process.env.WMS_ENVIRONMENT === "test" ? "test" : "production"],
    ]
      .map(([name, value]) => `set_config(${connection.escapeLiteral(name)},${connection.escapeLiteral(value)},true)`)
      .join(",");
    const endContext = beginTiming("telemetry.context");
    try {
      await timeAsync("telemetry.begin", () =>
        connection.query(`BEGIN;SET LOCAL statement_timeout='500ms';SELECT ${context}`),
      );
      endContext();
    } catch (error) {
      endContext(true);
      throw error;
    }
    await timeAsync("telemetry.insert", () =>
      connection.query(
        `INSERT INTO api_request_metrics(tenant_id,warehouse_id,request_id,actor_id,operation,command,method,status,error_code,duration_ms) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(tenant_id,request_id) DO NOTHING`,
        [
          metric.tenantId,
          metric.warehouseId,
          metric.requestId,
          metric.actorId,
          metric.operation,
          metric.command ?? null,
          metric.method,
          metric.status,
          metric.errorCode,
          metric.durationMs,
        ],
      ),
    );
    await timeAsync("telemetry.commit", () => connection.query("COMMIT"));
  } catch {
    if (client) {
      const connection = client;
      try {
        await timeAsync("telemetry.rollback", () => connection.query("ROLLBACK"));
      } catch {
        discard = true;
      }
    }
  } finally {
    client?.release(discard);
    endHeld();
    if (pool) observeTimingPool("telemetry", pool);
  }
}
