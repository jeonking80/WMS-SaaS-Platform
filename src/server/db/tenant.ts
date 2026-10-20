import type { PoolClient } from "pg";
import { getPool } from "./pool";
import { requestActor,requestWarehouse } from "../request-log";
import {transactionApplicationName} from '../../../scripts/v2-lock-scope.mjs';

/** Only pass the tenant resolved from the authenticated server-side membership. */
export async function withTenant<T>(
  tenantId: string,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tenantId)) {
    throw new Error("Invalid tenant identifier.");
  }
  const client = await getPool().connect();
  let discard = false;
  try {
    await client.query("BEGIN");
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
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      discard = true;
    }
    throw error;
  } finally {
    client.release(discard);
  }
}
