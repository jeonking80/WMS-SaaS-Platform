import { spawn } from 'node:child_process';
import { open, mkdir, stat, unlink } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import pg from 'pg';

export function runDocker(container, args, input) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(container)) throw new Error('Invalid container name.');
  return new Promise((resolvePromise, reject) => {
    const child = spawn('docker', ['exec', '-i', container, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    const output = [];
    child.stdout.on('data', chunk => output.push(chunk));
    // Drain diagnostics without printing SQL, connection details, or data.
    child.stderr.resume();
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolvePromise(Buffer.concat(output)) : reject(new Error(`PostgreSQL container command failed (exit ${code}); check local database and role prerequisites.`)));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}
export async function context(binding = process.env.BACKUP_DATABASE_URL ?? process.env.BOOTSTRAP_DATABASE_URL) {
  if (!binding) throw new Error('BACKUP_DATABASE_URL or BOOTSTRAP_DATABASE_URL is required.');
  const url = new URL(binding);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || decodeURIComponent(url.username) !== 'postgres') throw new Error('Backup requires a local PostgreSQL administrator binding.');
  const container = process.env.BACKUP_CONTAINER ?? 'wms-lite-db-1';
  const client = new pg.Client({ connectionString: url.href, connectionTimeoutMillis: 5000 });
  await client.connect();
  try {
    const actual = (await client.query('SELECT system_identifier::text FROM pg_control_system()')).rows[0].system_identifier;
    const expected = (await runDocker(container, ['psql', '-XAt', '-U', 'postgres', '-d', 'postgres', '-c', 'SELECT system_identifier::text FROM pg_control_system()'])).toString().trim();
    if (actual !== expected) throw new Error('Container and source binding must identify the same PostgreSQL cluster.');
    return { url, container, client, database: decodeURIComponent(url.pathname.slice(1)) };
  } catch (error) { await client.end(); throw error; }
}
export async function backup(ctx, file) {
  const path = resolve(file);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const handle = await open(path, 'wx', 0o600);
  try {
    const data = await runDocker(ctx.container, ['pg_dump', '-U', 'postgres', '-d', ctx.database, '--format=custom']);
    await handle.writeFile(data);
    return { file: path, bytes: data.length };
  } catch (error) {
    await unlink(path).catch(() => {});
    throw error;
  } finally { await handle.close(); }
}
export async function restore(ctx, file, name) {
  if (!/^wms_restore_[a-z0-9_]{1,45}$/.test(name ?? '') || name === ctx.database) throw new Error('RESTORE_DATABASE_NAME must be a distinct fresh wms_restore_* database.');
  const metadata = await stat(file);
  if (!metadata.isFile() || (metadata.mode & 0o077)) throw new Error('Backup must be a private regular file (chmod 600).');
  // CREATE DATABASE is the existence guard: never clean, drop, or reuse a target.
  await ctx.client.query(`CREATE DATABASE ${pg.escapeIdentifier(name)} TEMPLATE template0`);
  const { readFile } = await import('node:fs/promises');
  await runDocker(ctx.container, ['pg_restore', '-U', 'postgres', '-d', name, '--exit-on-error', '--single-transaction'], await readFile(file));
  return name;
}
export function safeFailure(action, error) {
  console.error(`${action} failed (${error.code ?? error.name}). ${error.code === '42P04' ? 'Target already exists; choose a fresh restore name.' : 'Check local bindings, private archive, Docker, and database roles. Existing databases are never overwritten.'}`);
  process.exitCode = 1;
}
