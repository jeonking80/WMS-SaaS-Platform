import { context, restore, safeFailure } from './backup-lib.mjs';
let ctx;
try {
  if (!process.env.BACKUP_FILE) throw new Error('BACKUP_FILE is required.');
  ctx = await context();
  await restore(ctx, process.env.BACKUP_FILE, process.env.RESTORE_DATABASE_NAME);
  console.log('Archive restored to a fresh database; run reconciliation and role checks before using it.');
} catch (error) { safeFailure('Restore', error); }
finally { await ctx?.client.end(); }
