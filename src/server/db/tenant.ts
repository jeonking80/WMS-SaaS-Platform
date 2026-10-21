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
    await timeAsync('db.begin',()=>client.query("BEGIN"));
    const endContext=beginTiming('db.context');
    try{
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const actor = requestActor();
    if (actor) {
      if (actor.tenantId !== tenantId) throw new Error("Authenticated tenant context mismatch.");
      await client.query("SELECT set_config('app.user_id', $1, true),set_config('app.environment',$2,true)", [
        actor.userId, process.env.WMS_ENVIRONMENT === "test" ? "test" : "production",
      ]);
    }
    // The warehouse tag comes only from a successful live authorization in ALS.
    // Background/tenant-only transactions use a separate unclassified tag.
    await client.query("SELECT set_config('application_name',$1,true)",[
      transactionApplicationName(tenantId,actor?requestWarehouse():null),
    ]);
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
