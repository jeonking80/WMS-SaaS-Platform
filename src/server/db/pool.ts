import { Pool } from "pg";
import { getDatabaseUrl } from "../env";

const dbGlobal = globalThis as typeof globalThis & { wmsPool?: Pool };

export function getPool(): Pool {
  if (!dbGlobal.wmsPool) {
    dbGlobal.wmsPool = new Pool({
      connectionString: getDatabaseUrl(),
      max: 5,
      connectionTimeoutMillis: 3000,
      idleTimeoutMillis: 10000,
      statement_timeout: 3000,
    });
    // An idle client error must not terminate the application process.
    dbGlobal.wmsPool.on("error", () => console.error("An idle database connection failed."));
  }
  return dbGlobal.wmsPool;
}
