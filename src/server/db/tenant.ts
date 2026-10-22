import type { PoolClient } from "pg";
import { getPool } from "./pool";
import { requestActor,requestWarehouse } from "../request-log";
import {transactionApplicationName} from '../../../scripts/v2-lock-scope.mjs';
import {beginTiming,observeTimingPool,timeAsync} from '../timing-diagnostics';

/** Only pass the tenant resolved from the authenticated server-side membership. */
export async function withTenant<T>(
  tenantId: string,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tenantId)) {
    throw new Error("Invalid tenant identifier.");
  }
  const pool=getPool();observeTimingPool('business',pool);
  const client = await timeAsync('db.pool_acquire',()=>{const pending=pool.connect();observeTimingPool('business',pool);return pending;});
  const endHeld=beginTiming('db.connection_held');
  let discard = false;
  try {
    // BEGIN and the whole RLS context go in one simple-protocol round trip: every protected request
    // opens two or three of these transactions, and each extra round trip costs the full DB latency.
    const actor = requestActor();
    if (actor && actor.tenantId !== tenantId) throw new Error("Authenticated tenant context mismatch.");
    // The warehouse tag comes only from a successful live authorization in ALS.
    // Background/tenant-only transactions use a separate unclassified tag.
    const settings: [string, string][] = [["app.tenant_id", tenantId]];
    if (actor)
      settings.push(
        ["app.user_id", actor.userId],
        ["app.environment", process.env.WMS_ENVIRONMENT === "test" ? "test" : "production"],
      );
    settings.push(["application_name", transactionApplicationName(tenantId, actor ? requestWarehouse() : null)]);
    const context = settings
      .map(([name, value]) => `set_config(${client.escapeLiteral(name)},${client.escapeLiteral(value)},true)`)
      .join(",");
    const endContext=beginTiming('db.context');
    try{
    await timeAsync('db.begin',()=>client.query(`BEGIN;SELECT ${context}`));
    endContext();}catch(error){endContext(true);throw error;}
    const result = await timeAsync('db.operation',()=>operation(client));
    await timeAsync('db.commit',()=>client.query("COMMIT"));
    return result;
  } catch (error) {
    try {
      await timeAsync('db.rollback',()=>client.query("ROLLBACK"));
    } catch {
      discard = true;
    }
    throw error;
  } finally {
    client.release(discard);
    endHeld();observeTimingPool('business',pool);
  }
}
