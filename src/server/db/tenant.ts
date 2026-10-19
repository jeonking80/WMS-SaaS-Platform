import type { PoolClient } from "pg";
import { getPool } from "./pool";

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
