import { context, backup, safeFailure } from './backup-lib.mjs';
let ctx;
try {
  ctx = await context();
  const file = process.env.BACKUP_FILE ?? `backups/wms-${new Date().toISOString().replaceAll(':', '-')}.dump`;
  const result = await backup(ctx, file);
  console.log(`Private PostgreSQL custom archive created (${result.bytes} bytes): ${result.file}`);
} catch (error) { safeFailure('Backup', error); }
finally { await ctx?.client.end(); }
