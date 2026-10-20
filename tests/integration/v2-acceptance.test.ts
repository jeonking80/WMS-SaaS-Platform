import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { migrate } from '../../scripts/db-migrate.mjs';
import type { Identity } from '../../src/server/auth/access';
import { assertPersistedInvariants, quantities } from '../helpers/v2-invariants';

const state = vi.hoisted(() => ({ pool: undefined as pg.Pool | undefined }));
vi.mock('../../src/server/db/pool', () => ({ getPool: () => state.pool }));
import { withTenant } from '../../src/server/db/tenant';
import { executeWorkflow, getWorkflowSnapshot } from '../../src/server/v2/workflow';
import { authenticateV2Machine } from '../../src/server/v2/access';
import { createKey, revokeKey } from '../../src/server/v2/identity/service';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl || !decodeURIComponent(new URL(databaseUrl).pathname).endsWith('_test')) throw new Error('A dedicated TEST_DATABASE_URL ending in _test is required.');
const schema = `v2_acceptance_${randomUUID().replaceAll('-', '')}`;
const role = `app_${randomUUID().replaceAll('-', '')}`;
const password = randomBytes(32).toString('hex');
const owner = new pg.Pool({ connectionString: databaseUrl });
const appUrl = new URL(databaseUrl);
appUrl.username = role;
appUrl.password = password;
let roleCreated = false;
const tenant = randomUUID();
const otherTenant = randomUUID();
const actor = randomUUID();
const approver = randomUUID();
const identity: Identity = { user: { id: actor, name: 'Worker', email: `${actor}@example.test` }, tenant: { id: tenant, name: 'A' }, role: 'worker' };
const manager: Identity = { user: { id: approver, name: 'Approver', email: `${approver}@example.test` }, tenant: identity.tenant, role: 'admin' };
const tables = ['v2_workflow_state', 'v2_workflow_stock', 'v2_workflow_ledger', 'v2_workflow_requests'];

beforeAll(async () => {
  await owner.query(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD ${pg.escapeLiteral(password)}`);
  roleCreated = true;
  await migrate(databaseUrl, { schema, migrationsSchema: schema, createSchema: true, createMigrationsSchema: true, log: () => {} });
  await owner.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${role}"`);
  await owner.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA "${schema}" TO "${role}"`);
  await owner.query(`INSERT INTO "${schema}".tenants(id,name) VALUES ($1,'A'),($2,'B')`, [tenant, otherTenant]);
  for (const user of [identity.user, manager.user]) await owner.query(`INSERT INTO "${schema}"."user"(id,name,email) VALUES ($1,$2,$3)`, [user.id, user.name, user.email]);
  await owner.query(`INSERT INTO "${schema}".memberships(tenant_id,user_id,role) VALUES ($1,$2,'worker'),($1,$3,'admin')`, [tenant, actor, approver]);
  state.pool = new pg.Pool({ connectionString: appUrl.toString(), max: 8, application_name: schema, options: `-c search_path=${schema}` });
}, 30_000);
afterAll(async () => {
  await state.pool?.end();
  try { await owner.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
  finally { try { if (roleCreated) await owner.query(`DROP ROLE "${role}"`); } finally { await owner.end(); } }
});

async function world() {
  const warehouse = randomUUID(); const partner = randomUUID(); const destination = randomUUID();
  const location = { receiving: randomUUID(), storage: randomUUID(), second: randomUUID(), staging: randomUUID(), hold: randomUUID() };
  await withTenant(tenant, async client => {
    await client.query("INSERT INTO warehouses(id,tenant_id,code,name) VALUES ($1::uuid,$2,$1::text,'Acceptance')", [warehouse, tenant]);
    for (const [name, id] of Object.entries(location)) {
      const kind = name === 'receiving' ? 'RECEIVING' : name === 'staging' ? 'STAGING' : name === 'hold' ? 'HOLD' : 'STORAGE';
      await client.query('INSERT INTO locations(id,tenant_id,warehouse_id,code,name,kind) VALUES ($1::uuid,$2,$3,$1::text,$4,$5)', [id, tenant, warehouse, name, kind]);
    }
    for (const userId of [actor, approver]) await client.query('INSERT INTO v2_warehouse_grants(tenant_id,user_id,warehouse_id) VALUES ($1,$2,$3)', [tenant, userId, warehouse]);
    await client.query("INSERT INTO business_partners(id,tenant_id,code,name,supplier,customer) VALUES($1::uuid,$2,$1::text,'Acceptance partner',true,true)", [partner,tenant]);
    await client.query("INSERT INTO delivery_destinations(id,tenant_id,partner_id,recipient_name,name,address_line1) VALUES($1::uuid,$2,$3,'Acceptance recipient',$1::text,'Synthetic test address')", [destination,tenant,partner]);
  });
  async function item() {
    const id = randomUUID();
    await withTenant(tenant, client => client.query("INSERT INTO items(id,tenant_id,code,name) VALUES ($1::uuid,$2,$1::text,'SKU')", [id, tenant]));
    return id;
  }
  const physicalCommands = new Set(['receipt.receive', 'receipt.inspect', 'receipt.putaway', 'order.pick', 'order.return_picked', 'order.damage', 'package.create', 'return.receive', 'return.inspect', 'return.putaway', 'stock.move', 'stock.hold', 'stock.inspect', 'stock.putaway', 'hold.release']);
  const command = (command: string, payload: Record<string, unknown>, who = identity, requestId: string = randomUUID()) => {
    if (command === 'receipt.create') payload = { supplier_id: partner, expected_at: '2026-10-21T09:00:00.000Z', ...payload };
    if (command === 'order.create') payload = { delivery: { partner_id: partner, delivery_destination_id: destination }, due_at: '2026-10-21T09:00:00.000Z', ...payload };
    if (physicalCommands.has(command)) payload = { manual_entry_reason: '수락검사 실물/위치 대조', ...payload, ...(Array.isArray(payload.lines) ? { lines: payload.lines.map(line => ({ input_mode: 'search', ...line })) } : { input_mode: 'search' }) };
    return executeWorkflow(who, { warehouse_id: warehouse, command, payload, request_id: requestId });
  };
  const snapshot = () => getWorkflowSnapshot(identity, warehouse);
  async function receive(itemId: string, quantity: number) {
    const created = await command('receipt.create', { lines: [{ item_id: itemId, quantity }] });
    const receipt = created.snapshot.receipts.find(row => row.id === created.result.id)!;
    const received = await command('receipt.receive', { receipt_id: receipt.id, receiving_id: randomUUID(), lines: [{ line_id: receipt.lines[0].id, quantity, location_id: location.receiving }] });
    return received.snapshot.receipts.find(row => row.id === receipt.id)!;
  }
  async function seed(itemId: string, quantity: number, storageId = location.storage) {
    const receipt = await receive(itemId, quantity);
    await command('receipt.inspect', { receipt_id: receipt.id, lines: [{ lot_id: receipt.lots[0].id, quantity, outcome: 'normal' }] });
    await command('receipt.putaway', { receipt_id: receipt.id, lines: [{ lot_id: receipt.lots[0].id, quantity, location_id: storageId }] });
  }
  async function order(itemId: string, quantity: number) {
    const created = await command('order.create', { lines: [{ item_id: itemId, quantity }] });
    return created.snapshot.orders.find(row => row.id === created.result.id)!;
  }
  async function pick(itemId: string, quantity: number) {
    const original = await order(itemId, quantity);
    const reserved = await command('order.reserve', { order_id: original.id, partial: false });
    const orderRow = reserved.snapshot.orders.find(row => row.id === original.id)!;
    const picked = await command('order.pick', { order_id: original.id, lines: orderRow.reservations.map(row => ({ reservation_id: row.id, quantity: row.quantity, location_id: location.staging, scanned_item_id: itemId, scanned_location_id: row.location_id })) });
    return picked.snapshot.orders.find(row => row.id === original.id)!;
  }
  const invariant = () => withTenant(tenant, client => assertPersistedInvariants(client, warehouse));
  async function effects() {
    return withTenant(tenant, async client => {
      const result: Record<string, unknown[]> = {};
      for (const table of tables) result[table] = (await client.query(`SELECT to_jsonb(t) AS row FROM ${table} t WHERE warehouse_id=$1 ORDER BY to_jsonb(t)::text`, [warehouse])).rows;
      return result;
    });
  }
  return { warehouse, location, item, command, snapshot, receive, seed, order, pick, invariant, effects };
}

async function rawWarehouseScope(actorId: string, warehouseIds: string[], environment = 'test') {
  return withTenant(tenant, async client => {
    await client.query("SELECT set_config('app.user_id',$1,true),set_config('app.environment',$2,true)", [actorId,environment]);
    return (await client.query<{id:string}>('SELECT id FROM warehouses WHERE id=ANY($1::uuid[]) ORDER BY id', [warehouseIds])).rows.map(row => row.id);
  });
}

async function assertQuantities(w: Awaited<ReturnType<typeof world>>, itemId: string, expected: Partial<ReturnType<typeof quantities>>) {
  const snapshot = await w.snapshot();
  expect(quantities(snapshot, itemId)).toMatchObject(expected);
  for (const bucket of ['A', 'H'] as const) if (expected[bucket] !== undefined) {
    expect(snapshot.stock.filter(row => row.item_id === itemId).reduce((sum, row) => sum + row[bucket], 0)).toBe(expected[bucket]);
  }
  await w.invariant();
}

/** Barrier verifies separate PostgreSQL connections really compete on a held row. */
async function race(warehouse: string, operations: (() => Promise<unknown>)[]) {
  const blocker = await owner.connect();
  try {
    await blocker.query('BEGIN');
    await blocker.query(`SELECT warehouse_id FROM "${schema}".v2_workflow_state WHERE warehouse_id=$1 FOR UPDATE`, [warehouse]);
    const outcomes = Promise.allSettled(operations.map(operation => operation()));
    let waiting = 0;
    for (let attempt = 0; attempt < 100 && waiting < operations.length; attempt++) {
      waiting = (await owner.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE usename=$1 AND datname=current_database() AND wait_event_type='Lock'", [role])).rows[0].count;
      if (waiting < operations.length) await new Promise(resolve => setTimeout(resolve, 20));
    }
    expect(waiting).toBeGreaterThanOrEqual(operations.length);
    await blocker.query('COMMIT');
    return await outcomes;
  } finally { await blocker.query('ROLLBACK'); blocker.release(); }
}

describe('WMS v2 acceptance against PostgreSQL with enforced tenant RLS', () => {
  it('AC-01/02 partially receives, retries once, inspects and puts away without double counting', async () => {
    const w = await world(); const item = await w.item();
    const created = await w.command('receipt.create', { lines: [{ item_id: item, quantity: 100 }] });
    const receipt = created.snapshot.receipts[0];
    const payload = { receipt_id: receipt.id, receiving_id: randomUUID(), lines: [{ line_id: receipt.lines[0].id, quantity: 60, location_id: w.location.receiving }] };
    const key = randomUUID(); const first = await w.command('receipt.receive', payload, identity, key);
    const replay = await w.command('receipt.receive', payload, identity, key);
    expect(replay.replayed).toBe(true); expect(replay.result).toEqual(first.result);
    await assertQuantities(w, item, { H: 60, Q: 60, A: 0 });
    const lot = first.snapshot.receipts[0].lots[0];
    await w.command('receipt.inspect', { receipt_id: receipt.id, lines: [{ lot_id: lot.id, quantity: 55, outcome: 'normal' }, { lot_id: lot.id, quantity: 5, outcome: 'hold' }] });
    await w.command('receipt.putaway', { receipt_id: receipt.id, lines: [{ lot_id: lot.id, quantity: 30, location_id: w.location.storage }] });
    await expect(w.command('receipt.cancel', { receipt_id: receipt.id, reason: 'Partial receipt needs approval' })).rejects.toMatchObject({ code: 'CLOSE_APPROVAL_REQUIRED' });
    const close = await w.command('receipt.close.request', { receipt_id: receipt.id, reason: 'Close only remaining 40' });
    await w.command('approval.decide', { approval_id: close.result.id, approve: true, reason: 'Independent approval of remaining forty' }, manager);
    await assertQuantities(w, item, { H: 60, S: 30, Q: 25, B: 5, A: 30 });
    expect((await w.snapshot()).receipts[0].lines[0]).toMatchObject({ quantity: 100, received: 60, cancelled: 40 });
  });

  it('AC-03 serializes full reservations and requires explicit partial reservation', async () => {
    const w = await world(); const item = await w.item(); await w.seed(item, 100);
    const a = await w.order(item, 80); const b = await w.order(item, 80);
    const outcomes = await race(w.warehouse, [() => w.command('order.reserve', { order_id: a.id, partial: false }), () => w.command('order.reserve', { order_id: b.id, partial: false })]);
    expect(outcomes.filter(row => row.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter(row => row.status === 'rejected')).toHaveLength(1);
    await assertQuantities(w, item, { S: 100, R: 80, A: 20, H: 100 });
    const loser = outcomes[0].status === 'rejected' ? a : b;
    await w.command('order.reserve', { order_id: loser.id, partial: true });
    await assertQuantities(w, item, { R: 100, A: 0, H: 100 });
  });

  it('AC-04/08 keeps reservations protected and rejects wrong scans with zero effects', async () => {
    const w = await world(); const item = await w.item(); await w.seed(item, 100);
    const order = await w.order(item, 60);
    const reserved = await w.command('order.reserve', { order_id: order.id, partial: false });
    const reservation = reserved.snapshot.orders[0].reservations[0];
    const before = await w.effects();
    await expect(w.command('stock.move', { lines: [{ item_id: item, from_location_id: w.location.storage, location_id: w.location.second, quantity: 50 }], reason: 'Reservation protected' })).rejects.toBeDefined();
    await expect(w.command('stock.hold', { lines: [{ item_id: item, from_location_id: w.location.storage, location_id: w.location.hold, quantity: 50 }], reason: 'Reservation protected' })).rejects.toBeDefined();
    await expect(w.command('order.pick', { order_id: order.id, lines: [{ reservation_id: reservation.id, quantity: 20, location_id: w.location.staging, scanned_item_id: randomUUID(), scanned_location_id: w.location.storage }] })).rejects.toBeDefined();
    expect(await w.effects()).toEqual(before);
    const payload = { order_id: order.id, lines: [{ reservation_id: reservation.id, quantity: 20, location_id: w.location.staging, scanned_item_id: item, scanned_location_id: w.location.storage }] };
    const key = randomUUID(); await w.command('order.pick', payload, identity, key); await w.command('order.pick', payload, identity, key);
    await assertQuantities(w, item, { S: 80, R: 40, P: 20, A: 40, H: 100 });
  });

  it('AC-05/07 ships whole selected packages and returns only physically received quantity', async () => {
    const w = await world(); const item = await w.item(); await w.seed(item, 20);
    const order = await w.pick(item, 20); const pick = order.picks[0];
    const p15 = await w.command('package.create', { order_id: order.id, lines: [{ pick_id: pick.id, quantity: 15 }] });
    await w.command('package.create', { order_id: order.id, lines: [{ pick_id: pick.id, quantity: 5 }] });
    await assertQuantities(w, item, { P: 20, H: 20 });
    const shipped = await w.command('shipment.create', { package_ids: [p15.result.id], handover_by: 'Driver', carrier: 'Test carrier' });
    await assertQuantities(w, item, { P: 5, H: 5 });
    await w.command('shipment.delivery', { shipment_id: shipped.result.id, status: 'failed', revision: 1, reason: 'Customer unavailable' });
    await assertQuantities(w, item, { P: 5, H: 5 });
    const shipment = shipped.snapshot.shipments[0];
    const requested = await w.command('return.request', { shipment_id: shipment.id, lines: [{ shipment_line_id: shipment.lines[0].id, quantity: 5 }], reason: 'Return approved' });
    const returned = requested.snapshot.returns[0];
    await w.command('return.receive', { return_id: returned.id, receiving_id: randomUUID(), lines: [{ line_id: returned.lines[0].id, quantity: 3, location_id: w.location.receiving }] });
    await w.command('return.close', { return_id: returned.id, reason: 'Remaining two never arrived' });
    await assertQuantities(w, item, { Q: 3, P: 5, H: 8, A: 0 });
    await w.command('return.request', { shipment_id: shipment.id, lines: [{ shipment_line_id: shipment.lines[0].id, quantity: 12 }], reason: 'Released approval permits twelve' });
    await expect(w.command('return.request', { shipment_id: shipment.id, lines: [{ shipment_line_id: shipment.lines[0].id, quantity: 1 }], reason: 'Exceeds cumulative receipt and approvals' })).rejects.toBeDefined();
    const receivedLot = (await w.snapshot()).returns.find(row => row.id === returned.id)!.lots[0];
    await w.command('return.inspect', { return_id: returned.id, lines: [{ lot_id: receivedLot.id, quantity: 3, outcome: 'normal' }] });
    await w.command('return.putaway', { return_id: returned.id, lines: [{ lot_id: receivedLot.id, quantity: 3, location_id: w.location.storage }] });
    await assertQuantities(w, item, { S: 3, Q: 0, P: 5, H: 8, A: 3 });
  });

  it('AC-06 cancellation and shipment race has exactly one winner and preserves order quantity', async () => {
    const w = await world(); const item = await w.item(); await w.seed(item, 5);
    const order = await w.pick(item, 5);
    const packed = await w.command('package.create', { order_id: order.id, lines: [{ pick_id: order.picks[0].id, quantity: 5 }] });
    const outcomes = await race(w.warehouse, [() => w.command('order.cancel', { order_id: order.id, lines: [{ line_id: order.lines[0].id, quantity: 5 }], reason: 'Cancelled' }), () => w.command('shipment.create', { package_ids: [packed.result.id], handover_by: 'Driver', carrier: 'Carrier' })]);
    expect(outcomes.filter(row => row.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter(row => row.status === 'rejected')).toHaveLength(1);
    if (outcomes[0].status === 'fulfilled') {
      await assertQuantities(w, item, { S: 0, A: 0, P: 5, H: 5 });
      await w.command('package.unpack', { package_id: packed.result.id, reason: 'Cancellation return' });
      await w.command('order.return_picked', { order_id: order.id, lines: [{ pick_id: order.picks[0].id, quantity: 5, location_id: w.location.storage, outcome: 'normal' }], reason: 'Physical return confirmed' });
      await assertQuantities(w, item, { S: 5, P: 0, H: 5, A: 5 });
      expect((await w.snapshot()).orders[0].lines[0]).toMatchObject({ quantity: 5, cancelled: 5, shipped: 0 });
    } else {
      await assertQuantities(w, item, { P: 0, H: 0, A: 0 });
      expect((await w.snapshot()).orders[0].lines[0]).toMatchObject({ quantity: 5, cancelled: 0, shipped: 5 });
    }
  });

  it('AC-09 rolls back every row when a later line fails and returns original result after response loss', async () => {
    const w = await world(); const a = await w.item(); const b = await w.item(); await w.seed(a, 5); await w.seed(b, 3);
    const before = await w.effects();
    await expect(w.command('stock.move', { lines: [{ item_id: a, from_location_id: w.location.storage, location_id: w.location.second, quantity: 5 }, { item_id: b, from_location_id: w.location.storage, location_id: w.location.second, quantity: 4 }], reason: 'One invalid line' })).rejects.toBeDefined();
    expect(await w.effects()).toEqual(before);
    const payload = { lines: [{ item_id: a, from_location_id: w.location.storage, location_id: w.location.second, quantity: 5 }], reason: 'Lost response' };
    const key = randomUUID(); const success = await w.command('stock.move', payload, identity, key);
    // Discarded response is recovered with a fresh transaction and the persisted key.
    const replay = await w.command('stock.move', payload, identity, key);
    expect(replay.replayed).toBe(true); expect(replay.result).toEqual(success.result);
    const after = await w.effects();
    await expect(w.command('stock.move', { ...payload, reason: 'Changed body' }, identity, key)).rejects.toBeDefined();
    expect(await w.effects()).toEqual(after); await assertQuantities(w, a, { S: 5, H: 5 });
  });

  it('AC-09 database failure inserting the durable response rolls back state, stock and ledger', async () => {
    const w = await world(); const item = await w.item(); await w.seed(item, 5);
    const before = await w.effects(); const key = randomUUID();
    const functionName = `fail_${randomUUID().replaceAll('-', '')}`;
    await owner.query(`CREATE FUNCTION "${schema}"."${functionName}"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.request_id='${key}'::uuid THEN RAISE EXCEPTION 'injected durable response failure'; END IF; RETURN NEW; END $$`);
    await owner.query(`CREATE TRIGGER "${functionName}" BEFORE INSERT ON "${schema}".v2_workflow_requests FOR EACH ROW EXECUTE FUNCTION "${schema}"."${functionName}"()`);
    try { await expect(w.command('stock.move', { lines: [{ item_id: item, from_location_id: w.location.storage, location_id: w.location.second, quantity: 5 }], reason: 'Atomicity injection' }, identity, key)).rejects.toBeDefined(); }
    finally { await owner.query(`DROP TRIGGER "${functionName}" ON "${schema}".v2_workflow_requests`); await owner.query(`DROP FUNCTION "${schema}"."${functionName}"()`); }
    expect(await w.effects()).toEqual(before); await w.invariant();
  });

  it('AC-09 rejects a concurrent request-key collision across two warehouses as a business conflict', async () => {
    const first = await world(); const second = await world(); const item = await first.item();
    await first.command('receipt.create', { lines: [{ item_id: item, quantity: 1 }] });
    await second.command('receipt.create', { lines: [{ item_id: item, quantity: 1 }] });
    const key = randomUUID(); const fn = `barrier_${randomUUID().replaceAll('-', '')}`;
    const blocker = await owner.connect();
    let outcomes: Promise<PromiseSettledResult<unknown>[]> | undefined;
    await owner.query(`CREATE FUNCTION "${schema}"."${fn}"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.request_id='${key}'::uuid THEN PERFORM pg_advisory_xact_lock(hashtextextended('${key}',0)); END IF; RETURN NEW; END $$`);
    await owner.query(`CREATE TRIGGER "${fn}" BEFORE INSERT ON "${schema}".v2_workflow_requests FOR EACH ROW EXECUTE FUNCTION "${schema}"."${fn}"()`);
    try {
      await blocker.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [key]);
      outcomes = Promise.allSettled([first.command('receipt.create', { lines: [{ item_id: item, quantity: 2 }] }, identity, key), second.command('receipt.create', { lines: [{ item_id: item, quantity: 3 }] }, identity, key)]);
      let waiting = 0;
      for (let attempt = 0; attempt < 100 && waiting < 2; attempt++) {
        waiting = (await owner.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE usename=$1 AND datname=current_database() AND wait_event_type='Lock'", [role])).rows[0].count;
        if (waiting < 2) await new Promise(resolve => setTimeout(resolve, 20));
      }
      expect(waiting).toBeGreaterThanOrEqual(2);
    } finally {
      await blocker.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [key]); blocker.release();
      await outcomes;
      await owner.query(`DROP TRIGGER "${fn}" ON "${schema}".v2_workflow_requests`);
      await owner.query(`DROP FUNCTION "${schema}"."${fn}"()`);
    }
    const results = await outcomes!;
    expect(results.filter(row => row.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(row => row.status === 'rejected')).toHaveLength(1);
    expect((results.find(row => row.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await first.invariant(); await second.invariant();
  });

  it('AC-10 locks one location, requires recount and a different approver, then reconciles adjustment', async () => {
    const w = await world(); const item = await w.item(); await w.seed(item, 10); await w.seed(item, 3, w.location.second);
    const started = await w.command('count.start', { location_id: w.location.storage }); const countId = started.result.id;
    await assertQuantities(w, item, { S: 13, H: 13, A: 3 });
    await expect(w.command('stock.move', { lines: [{ item_id: item, from_location_id: w.location.storage, location_id: w.location.second, quantity: 1 }], reason: 'Locked' })).rejects.toBeDefined();
    await w.command('count.record', { count_id: countId, lines: [{ item_id: item, bucket: 'S', quantity: 8 }], recount: false, reason: 'First count' });
    await expect(w.command('count.submit', { count_id: countId, reason: 'Difference requires recount' })).rejects.toMatchObject({ code: 'RECOUNT_REQUIRED' });
    await w.command('count.record', { count_id: countId, lines: [{ item_id: item, bucket: 'S', quantity: 8 }], recount: true, reason: 'Recount confirms two missing' });
    const submitted = await w.command('count.submit', { count_id: countId, reason: 'Two missing' });
    const approval = submitted.snapshot.approvals.find(row => row.target_id === countId)!;
    await expect(w.command('approval.decide', { approval_id: approval.id, approve: true, reason: 'Self approval forbidden' }, identity)).rejects.toBeDefined();
    await w.command('approval.decide', { approval_id: approval.id, approve: true, reason: 'Independent approval' }, manager);
    await assertQuantities(w, item, { S: 11, H: 11, A: 11 });
    const next = await w.command('count.start', { location_id: w.location.storage });
    await w.command('count.record', { count_id: next.result.id, lines: [{ item_id: item, bucket: 'S', quantity: 7 }], recount: true, reason: 'Recount' });
    const pending = await w.command('count.submit', { count_id: next.result.id, reason: 'Difference' });
    const oldApproval = pending.snapshot.approvals.find(row => row.target_id === next.result.id)!;
    await w.command('count.unlock', { count_id: next.result.id, reason: 'Emergency unlock invalidates count' }, manager);
    await expect(w.command('approval.decide', { approval_id: oldApproval.id, approve: true, reason: 'Stale count' }, manager)).rejects.toBeDefined();
    await assertQuantities(w, item, { S: 11, H: 11, A: 11 });
  });

  it('AC-18 invalidates an approval after the receipt changes and rejects self approval by an authorized manager', async () => {
    const w = await world(); const item = await w.item();
    const created = await w.command('receipt.create', { lines: [{ item_id: item, quantity: 10 }] }); const receipt = created.snapshot.receipts[0];
    const close = await w.command('receipt.close.request', { receipt_id: receipt.id, reason: 'Close remaining ten' });
    await w.command('receipt.update', { receipt_id: receipt.id, lines: [{ id: receipt.lines[0].id, item_id: item, quantity: 12 }] });
    const before = await w.effects();
    await expect(w.command('approval.decide', { approval_id: close.result.id, approve: true, reason: 'Old target version' }, manager)).rejects.toMatchObject({ code: 'APPROVAL_STALE' });
    expect(await w.effects()).toEqual(before);
    const own = await w.command('receipt.close.request', { receipt_id: receipt.id, reason: 'Manager requests closing' }, manager);
    await expect(w.command('approval.decide', { approval_id: own.result.id, approve: true, reason: 'Manager still cannot approve own request' }, manager)).rejects.toMatchObject({ code: 'SELF_APPROVAL_FORBIDDEN' });
    expect((await w.snapshot()).receipts[0]).toMatchObject({ closed: false });
    await w.invariant();
  });

  it('OUT-02 honors location priority and reservation blocking, and freezes an order once work starts', async () => {
    const w = await world(); const item = await w.item(); await w.seed(item, 5, w.location.storage); await w.seed(item, 5, w.location.second);
    await withTenant(tenant, async client => {
      await client.query('UPDATE locations SET priority=100 WHERE id=$1', [w.location.storage]);
      await client.query('UPDATE locations SET priority=1 WHERE id=$1', [w.location.second]);
    });
    const order = await w.order(item, 3);
    const reserved = await w.command('order.reserve', { order_id: order.id, partial: false });
    expect(reserved.snapshot.orders[0].reservations[0]).toMatchObject({ location_id: w.location.second, quantity: 3 });
    await expect(w.command('order.update', { order_id: order.id, lines: [{ id: order.lines[0].id, item_id: item, quantity: 4 }] })).rejects.toBeDefined();
    await withTenant(tenant, client => client.query('UPDATE locations SET reservation_blocked=true WHERE id=$1', [w.location.storage]));
    const second = await w.order(item, 4); const before = await w.effects();
    await expect(w.command('order.reserve', { order_id: second.id, partial: false })).rejects.toBeDefined();
    expect(await w.effects()).toEqual(before);
    await w.command('order.reserve', { order_id: second.id, partial: true });
    // Only two units remain in the unblocked location; five in storage stay unavailable.
    await assertQuantities(w, item, { S: 10, R: 5, H: 10 });
    expect((await w.snapshot()).stock.filter(row => row.item_id === item).reduce((sum, row) => sum + row.A, 0)).toBe(0);
  });

  it('AC-21 records overage once, forbids self approval and availability before approved release/inspection', async () => {
    const w = await world(); const item = await w.item();
    const created = await w.command('receipt.create', { lines: [{ item_id: item, quantity: 100 }] }); const receipt = created.snapshot.receipts[0];
    const payload = { receipt_id: receipt.id, receiving_id: randomUUID(), reason: 'Five extra physically arrived', lines: [{ line_id: receipt.lines[0].id, quantity: 105, location_id: w.location.receiving }] };
    const receiveKey = randomUUID();
    const received = await w.command('receipt.receive', payload, identity, receiveKey);
    expect((await w.command('receipt.receive', payload, identity, receiveKey)).replayed).toBe(true);
    await assertQuantities(w, item, { Q: 100, B: 5, H: 105, A: 0 });
    const beforeDuplicate = await w.effects();
    await expect(w.command('receipt.receive', payload)).rejects.toBeDefined();
    expect(await w.effects()).toEqual(beforeDuplicate);
    const overage = received.snapshot.receipts[0].lots.find(row => row.overage)!;
    await expect(w.command('receipt.putaway', { receipt_id: receipt.id, lines: [{ lot_id: overage.id, quantity: 5, location_id: w.location.storage }] })).rejects.toBeDefined();
    const request = await w.command('overage.request', { lot_id: overage.id, quantity: 5, reason: 'Accept extra' });
    await expect(w.command('approval.decide', { approval_id: request.result.id, approve: true, reason: 'Self approval' })).rejects.toBeDefined();
    await w.command('approval.decide', { approval_id: request.result.id, approve: true, reason: 'Approved' }, manager);
    await assertQuantities(w, item, { Q: 100, B: 5, H: 105, A: 0 });
    await w.command('hold.release', { lot_id: overage.id, quantity: 5, location_id: w.location.receiving, reason: 'Physical release' });
    await w.command('receipt.inspect', { receipt_id: receipt.id, lines: [{ lot_id: overage.id, quantity: 5, outcome: 'normal' }] });
    await w.command('receipt.putaway', { receipt_id: receipt.id, lines: [{ lot_id: overage.id, quantity: 5, location_id: w.location.storage }] });
    await assertQuantities(w, item, { S: 5, Q: 100, B: 0, H: 105, A: 5 });
  });

  it('AC-21 rejection preserves the overage physically in B and H', async () => {
    const w = await world(); const item = await w.item();
    const created = await w.command('receipt.create', { lines: [{ item_id: item, quantity: 100 }] }); const receipt = created.snapshot.receipts[0];
    const received = await w.command('receipt.receive', { receipt_id: receipt.id, receiving_id: randomUUID(), reason: 'Overage', lines: [{ line_id: receipt.lines[0].id, quantity: 105, location_id: w.location.receiving }] });
    const overage = received.snapshot.receipts[0].lots.find(row => row.overage)!;
    const requested = await w.command('overage.request', { lot_id: overage.id, quantity: 5, reason: 'Accept?' });
    await w.command('approval.decide', { approval_id: requested.result.id, approve: false, reason: 'Rejected' }, manager);
    await expect(w.command('hold.release', { lot_id: overage.id, quantity: 5, location_id: w.location.receiving, reason: 'Rejected overage' })).rejects.toBeDefined();
    await assertQuantities(w, item, { Q: 100, B: 5, H: 105, A: 0 });
  });

  it('AC-22 preserves 21 distinct source rows, rejects a 21-line package and a 12+9 combined shipment', async () => {
    const w = await world(); const item = await w.item(); await w.seed(item, 21);
    // The same SKU in distinct original order lines must remain 21 shipping details.
    const created = await w.command('order.create', { lines: Array.from({ length: 21 }, () => ({ item_id: item, quantity: 1 })) });
    const order = created.snapshot.orders[0];
    const reservations = [];
    for (const group of [order.lines.slice(0, 20), order.lines.slice(20)]) {
      const reserved = await w.command('order.reserve', { order_id: order.id, partial: true, lines: group.map(line => ({ line_id: line.id, quantity: 1, location_id: w.location.storage })) });
      reservations.push(...reserved.snapshot.orders[0].reservations.filter(row => group.some(line => line.id === row.line_id)));
    }
    for (const group of [reservations.slice(0, 20), reservations.slice(20)]) await w.command('order.pick', { order_id: order.id, lines: group.map(row => ({ reservation_id: row.id, quantity: 1, location_id: w.location.staging, scanned_item_id: item, scanned_location_id: w.location.storage })) });
    const picks = (await w.snapshot()).orders[0].picks;
    expect(new Set(picks.map(row => row.line_id)).size).toBe(21);
    const details = picks.map(row => ({ pick_id: row.id, quantity: 1 }));
    const before = await w.effects();
    await expect(w.command('package.create', { order_id: order.id, lines: details })).rejects.toBeDefined();
    expect(await w.effects()).toEqual(before);
    const p12 = await w.command('package.create', { order_id: order.id, lines: details.slice(0, 12) });
    const p9 = await w.command('package.create', { order_id: order.id, lines: details.slice(12) });
    const beforeShipment = await w.effects();
    await expect(w.command('shipment.create', { package_ids: [p12.result.id, p9.result.id], handover_by: 'Driver', carrier: 'Carrier' })).rejects.toBeDefined();
    expect(await w.effects()).toEqual(beforeShipment);
    await w.command('shipment.create', { package_ids: [p12.result.id], handover_by: 'Driver', carrier: 'Carrier' });
    await w.command('shipment.create', { package_ids: [p9.result.id], handover_by: 'Driver', carrier: 'Carrier' });
    await assertQuantities(w, item, { P: 0, H: 0 });
  });

  it('AC-22 accepts exactly twenty shipping details and hands over the complete package', async () => {
    const w = await world(); const item = await w.item(); await w.seed(item, 20);
    const created = await w.command('order.create', { lines: Array.from({ length: 20 }, () => ({ item_id: item, quantity: 1 })) });
    const order = created.snapshot.orders[0];
    const reserved = await w.command('order.reserve', { order_id: order.id, partial: false });
    await w.command('order.pick', { order_id: order.id, lines: reserved.snapshot.orders[0].reservations.map(row => ({ reservation_id: row.id, quantity: 1, location_id: w.location.staging, scanned_item_id: item, scanned_location_id: w.location.storage })) });
    const packed = await w.command('package.create', { order_id: order.id, lines: (await w.snapshot()).orders[0].picks.map(row => ({ pick_id: row.id, quantity: 1 })) });
    const shipped = await w.command('shipment.create', { package_ids: [packed.result.id], handover_by: 'Driver', carrier: 'Carrier' });
    expect(shipped.snapshot.shipments[0].lines).toHaveLength(20);
    await assertQuantities(w, item, { P: 0, H: 0 });
  });

  it('AC-14 enforces FORCE RLS and composite tenant references with a real nonowner application role', async () => {
    const w = await world(); const item = await w.item(); await w.seed(item, 4);
    const flags = await owner.query(`SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=ANY($2)`, [schema, tables]);
    expect(flags.rows).toHaveLength(4);
    for (const row of flags.rows) expect(row).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
    expect((await state.pool!.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
    // Neither the absence of context nor another authenticated company can see A's data.
    for (const table of tables) expect((await state.pool!.query(`SELECT * FROM ${table}`)).rows).toEqual([]);
    await withTenant(otherTenant, async client => {
      for (const table of tables) expect((await client.query(`SELECT * FROM ${table}`)).rows).toEqual([]);
      await expect(client.query('INSERT INTO v2_workflow_state(tenant_id,warehouse_id,state) VALUES ($1,$2,$3)', [tenant, w.warehouse, '{}'])).rejects.toMatchObject({ code: '42501' });
    });
    const foreignWarehouse = randomUUID(); const foreignItem = randomUUID();
    await withTenant(otherTenant, async client => {
      await client.query("INSERT INTO warehouses(id,tenant_id,code,name) VALUES ($1,$2,'SAME','Other company')", [foreignWarehouse, otherTenant]);
      await client.query("INSERT INTO items(id,tenant_id,code,name) VALUES ($1::uuid,$2,$1::text,'Other item')", [foreignItem, otherTenant]);
    });
    await expect(getWorkflowSnapshot(identity, foreignWarehouse)).rejects.toBeDefined();
    await expect(w.command('receipt.create', { lines: [{ item_id: foreignItem, quantity: 1 }] })).rejects.toBeDefined();
    await withTenant(tenant, async client => {
      await expect(client.query('INSERT INTO v2_workflow_stock(tenant_id,warehouse_id,item_id,location_id) VALUES($1,$2,$3,$4)', [tenant, w.warehouse, foreignItem, w.location.storage])).rejects.toMatchObject({ code: '23503' });
    });
    const otherWarehouse = await world();
    await withTenant(tenant, async client => {
      await expect(client.query('INSERT INTO v2_workflow_stock(tenant_id,warehouse_id,item_id,location_id) VALUES($1,$2,$3,$4)', [tenant, w.warehouse, item, otherWarehouse.location.storage])).rejects.toMatchObject({ code: '23503' });
    });
    await withTenant(tenant, async client => {
      await expect(client.query('UPDATE v2_workflow_stock SET r=s+1 WHERE warehouse_id=$1', [w.warehouse])).rejects.toMatchObject({ code: '23514' });
    });
    for (const table of ['v2_workflow_ledger', 'v2_workflow_requests']) await withTenant(tenant, async client => {
      await expect(client.query(`DELETE FROM ${table} WHERE warehouse_id=$1`, [w.warehouse])).rejects.toMatchObject({ code: '23514' });
    });
    await assertQuantities(w, item, { H: 4, S: 4, A: 4 });
  });

  it('AC-14 rechecks warehouse grants and stopped memberships even when the identity is cached', async () => {
    const w = await world(); const item = await w.item(); await w.seed(item, 4);
    const other = await world(); const otherItem = await other.item(); await other.seed(otherItem, 7);
    await owner.query(`DELETE FROM "${schema}".v2_warehouse_grants WHERE tenant_id=$1 AND user_id=$2 AND warehouse_id=$3`, [tenant, actor, other.warehouse]);
    await expect(getWorkflowSnapshot(identity, other.warehouse)).rejects.toBeDefined();
    expect(await rawWarehouseScope(actor, [w.warehouse,other.warehouse])).toEqual([w.warehouse]);
    await expect(executeWorkflow(identity, { warehouse_id: other.warehouse, command: 'receipt.create', request_id: randomUUID(), payload: { lines: [{ item_id: item, quantity: 1 }] } })).rejects.toBeDefined();
    await assertQuantities(w, item, { H: 4 });
    await owner.query(`UPDATE "${schema}".memberships SET status='suspended' WHERE user_id=$1`, [actor]);
    try { await expect(w.snapshot()).rejects.toBeDefined(); expect(await rawWarehouseScope(actor, [w.warehouse])).toEqual([]); }
    finally { await owner.query(`UPDATE "${schema}".memberships SET status='active' WHERE user_id=$1`, [actor]); }
    await assertQuantities(w, item, { H: 4 });
  });

  it('AC-14 machine keys enforce source role, warehouse, live revocation and target environment', async () => {
    const w = await world(); const other = await world(); const item = await w.item();
    const previousEnvironment = process.env.WMS_ENVIRONMENT;
    process.env.WMS_ENVIRONMENT = 'test';
    await owner.query(`UPDATE "${schema}".tenants SET is_test=true WHERE id=$1`, [tenant]);
    try {
      const supplierKey = await createKey(manager, { name: 'Supplier', sourceSystem: 'acceptance-supplier', environment: 'test', kind: 'integration', scopes: ['read', 'integration.receive', 'integration.read'], warehouseIds: [w.warehouse] });
      const supplierHeaders = new Headers({ authorization: `Bearer ${supplierKey.token}` });
      const supplier = await authenticateV2Machine(supplierHeaders, 'integration.receive', w.warehouse);
      await expect(w.command('receipt.create', { lines: [{ item_id: item, quantity: 1 }] }, supplier)).rejects.toBeDefined();
      await expect(authenticateV2Machine(supplierHeaders, 'integration.receive', other.warehouse)).rejects.toBeDefined();
      const workerKey = await createKey(manager, { name: 'Physical worker', sourceSystem: 'acceptance-worker', environment: 'test', kind: 'automation', scopes: ['read', 'write'], warehouseIds: [w.warehouse] });
      const workerHeaders = new Headers({ authorization: `Bearer ${workerKey.token}` });
      const worker = await authenticateV2Machine(workerHeaders, 'write', w.warehouse);
      expect(await rawWarehouseScope(worker.user.id, [w.warehouse,other.warehouse])).toEqual([w.warehouse]);
      expect(await rawWarehouseScope(worker.user.id, [w.warehouse,other.warehouse], 'production')).toEqual([]);
      await w.command('receipt.create', { lines: [{ item_id: item, quantity: 1 }] }, worker);
      await expect(w.command('approval.decide', { approval_id: randomUUID(), approve: true, reason: 'Worker has no approval permission' }, worker)).rejects.toBeDefined();
      process.env.WMS_ENVIRONMENT = 'production';
      await expect(getWorkflowSnapshot(worker, w.warehouse)).rejects.toBeDefined();
      await expect(authenticateV2Machine(workerHeaders, 'write', w.warehouse)).rejects.toBeDefined();
      process.env.WMS_ENVIRONMENT = 'test';
      await revokeKey(manager, workerKey.keyId);
      expect(await rawWarehouseScope(worker.user.id, [w.warehouse,other.warehouse])).toEqual([]);
      await expect(getWorkflowSnapshot(worker, w.warehouse)).rejects.toBeDefined();
      await expect(authenticateV2Machine(workerHeaders, 'write', w.warehouse)).rejects.toBeDefined();
      await revokeKey(manager, supplierKey.keyId);
      await w.invariant();
    } finally {
      if (previousEnvironment === undefined) delete process.env.WMS_ENVIRONMENT; else process.env.WMS_ENVIRONMENT = previousEnvironment;
      await owner.query(`UPDATE "${schema}".tenants SET is_test=false WHERE id=$1`, [tenant]);
    }
  });

  it('IAM-01 preserves the temporary administrator grant for new warehouses without granting workers the same exception', async () => {
    const warehouse = randomUUID();
    await withTenant(tenant, async client => {
      await client.query("SELECT set_config('app.user_id',$1,true),set_config('app.creating_warehouse',$2,true)", [approver,warehouse]);
      await client.query("INSERT INTO warehouses(id,tenant_id,code,name) VALUES($1::uuid,$2,$1::text,'New authorized warehouse')", [warehouse,tenant]);
      await client.query('INSERT INTO v2_warehouse_grants(tenant_id,user_id,warehouse_id) VALUES($1,$2,$3)', [tenant,approver,warehouse]);
    });
    expect(await rawWarehouseScope(approver,[warehouse])).toEqual([warehouse]);
    expect(await rawWarehouseScope(actor,[warehouse])).toEqual([]);
    const forbidden = randomUUID();
    await expect(withTenant(tenant, async client => {
      await client.query("SELECT set_config('app.user_id',$1,true),set_config('app.creating_warehouse',$2,true)", [actor,forbidden]);
      await client.query("INSERT INTO warehouses(id,tenant_id,code,name) VALUES($1::uuid,$2,$1::text,'Forbidden worker warehouse')", [forbidden,tenant]);
    })).rejects.toMatchObject({code:'42501'});
  });

  it('AC-10 serializes count lock acquisition against a new reservation', async () => {
    const w = await world(); const item = await w.item(); await w.seed(item, 10); const order = await w.order(item, 10);
    const outcomes = await race(w.warehouse, [() => w.command('count.start', { location_id: w.location.storage }), () => w.command('order.reserve', { order_id: order.id, partial: false })]);
    expect(outcomes.filter(row => row.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter(row => row.status === 'rejected')).toHaveLength(1);
    await assertQuantities(w, item, { S: 10, H: 10, A: 0 });
    const snapshot = await w.snapshot();
    expect(snapshot.counts.length === 1 ? quantities(snapshot, item).R === 0 : quantities(snapshot, item).R === 10).toBe(true);
  });

  it('AC-20 requires explicit handover and resolved request results while freezing the close report', async () => {
    const w = await world(); const item = await w.item(); const receipt = await w.receive(item, 4); const order = await w.order(item, 2);
    const handover = [{ object_type: 'receipt', object_id: receipt.id, assignee_id: approver, reason: 'Inspect and put away next shift' }, { object_type: 'order', object_id: order.id, assignee_id: approver, reason: 'Wait for putaway then reserve' }];
    await expect(w.command('shift.close', { handover, unconfirmed_request_ids: [randomUUID()] }, manager)).rejects.toBeDefined();
    await expect(w.command('shift.close', { handover: [], unconfirmed_request_ids: [] }, manager)).rejects.toBeDefined();
    const closed = await w.command('shift.close', { handover, unconfirmed_request_ids: [] }, manager);
    const report = structuredClone(closed.snapshot.shifts[0]);
    const inspect = { receipt_id: receipt.id, lines: [{ lot_id: receipt.lots[0].id, quantity: 4, outcome: 'normal' }] };
    await expect(w.command('receipt.inspect', inspect)).rejects.toMatchObject({ code: 'TASK_ASSIGNEE_MISMATCH' });
    await w.command('receipt.inspect', inspect, manager);
    expect((await w.snapshot()).shifts[0]).toEqual(report);
    await assertQuantities(w, item, { Q: 4, H: 4, A: 0 });
  });

  it('AC-23 isolates damaged picks atomically and permits replacement without cancelling the original order', async () => {
    const w = await world(); const item = await w.item(); await w.seed(item, 12); const order = await w.pick(item, 10); const originalPick = order.picks[0];
    await assertQuantities(w, item, { S: 2, R: 0, P: 10, H: 12 });
    const packed = await w.command('package.create', { order_id: order.id, lines: [{ pick_id: originalPick.id, quantity: 10 }] });
    await expect(w.command('order.damage', { order_id: order.id, lines: [{ pick_id: originalPick.id, quantity: 2, location_id: w.location.hold }], reason: 'Unpack first' }, manager)).rejects.toBeDefined();
    await w.command('package.unpack', { package_id: packed.result.id, reason: 'Damage found' });
    const payload = { order_id: order.id, lines: [{ pick_id: originalPick.id, quantity: 2, location_id: w.location.hold }], reason: 'Two damaged' }; const key = randomUUID();
    await w.command('order.damage', payload, manager, key); await w.command('order.damage', payload, manager, key);
    await assertQuantities(w, item, { S: 2, R: 0, P: 8, B: 2, H: 12 });
    const reserved = await w.command('order.reserve', { order_id: order.id, partial: false }); const replacementReservation = reserved.snapshot.orders[0].reservations.at(-1)!;
    const replaced = await w.command('order.pick', { order_id: order.id, lines: [{ reservation_id: replacementReservation.id, quantity: 2, location_id: w.location.staging, scanned_item_id: item, scanned_location_id: w.location.storage }] });
    await assertQuantities(w, item, { S: 0, R: 0, P: 10, B: 2, H: 12 });
    const activePicks = replaced.snapshot.orders[0].picks.filter(row => row.active > 0);
    expect(replaced.snapshot.orders[0].picks.reduce((sum, row) => sum + row.quantity, 0)).toBe(12);
    expect(activePicks.reduce((sum, row) => sum + row.active, 0)).toBe(10);
    const repacked = await w.command('package.create', { order_id: order.id, lines: activePicks.map(row => ({ pick_id: row.id, quantity: row.active })) });
    await w.command('shipment.create', { package_ids: [repacked.result.id], handover_by: 'Driver', carrier: 'Carrier' });
    await assertQuantities(w, item, { S: 0, P: 0, B: 2, H: 2 });
    expect((await w.snapshot()).orders[0].lines[0]).toMatchObject({ quantity: 10, cancelled: 0, shipped: 10 });
  });
});
