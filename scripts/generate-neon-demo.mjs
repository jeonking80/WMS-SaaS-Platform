/** Offline, one-time SQL Editor fixture export. Never logs credentials. */
import { randomBytes } from 'node:crypto';
import { mkdir, open, lstat, rm, chmod } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashPassword } from 'better-auth/crypto';
import { roles, tenant, fixturePlan } from './demo-fixture.mjs';

function literal(value) {
  if (value === null) return 'NULL';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  if (typeof value !== 'string' || value.includes('\0')) throw new Error('Unsupported SQL value.');
  return "'" + value.replaceAll("'", "''") + "'";
}
export function renderNeonDemo(hashByRole) {
  const statements = fixturePlan(roles.map(role => hashByRole[role])).map(({text, values}) =>
    text.replace(/\$(\d+)/g, (_, number) => literal(values[Number(number) - 1])) + ';');
  return `-- Private one-time synthetic fixture. Run the entire file in the wms_demo SQL Editor.
BEGIN;
SET LOCAL standard_conforming_strings = on;
DO $guard$ BEGIN
  IF current_database() <> 'wms_demo' THEN RAISE EXCEPTION 'Requires wms_demo database'; END IF;
END $guard$;
SET LOCAL ROLE wms_migrator;
SET LOCAL search_path = public;
SELECT pg_advisory_xact_lock(hashtext('wms-p7-synthetic-demo'));
SELECT set_config('app.tenant_id', '${tenant}', true);
DO $guard$ BEGIN
  IF (SELECT count(*) FROM pgmigrations) < 8 OR
     NOT EXISTS (SELECT 1 FROM pgmigrations WHERE name='1792368000007_outbound-delivery') THEN
    RAISE EXCEPTION 'Requires outbound delivery migration';
  END IF;
  IF EXISTS (SELECT 1 FROM tenants WHERE id='${tenant}') OR
     EXISTS (SELECT 1 FROM "user" WHERE id IN ('p7-demo-viewer','p7-demo-worker','p7-demo-admin')
       OR email IN ('viewer@wms-demo.example.test','worker@wms-demo.example.test','admin@wms-demo.example.test')) THEN
    RAISE EXCEPTION 'Existing demo tenant or identities; refusing to reset';
  END IF;
END $guard$;
${statements.join('\n')}
DO $check$ DECLARE entry record; actual integer; BEGIN
  FOR entry IN SELECT * FROM (VALUES ('items',3),('warehouses',1),('locations',2),('inventory_documents',6),
    ('inventory_document_lines',6),('stock_ledger',6),('stock_balances',4),('audit_logs',5),('memberships',3)) AS checks(name, expected)
  LOOP
    EXECUTE format('SELECT count(*) FROM %I WHERE tenant_id=$1',entry.name) INTO actual USING '${tenant}'::uuid;
    IF actual <> entry.expected THEN RAISE EXCEPTION 'Fixture count mismatch: %',entry.name; END IF;
  END LOOP;
  IF (SELECT count(*) FROM "user" WHERE id IN ('p7-demo-viewer','p7-demo-worker','p7-demo-admin')) <> 3 OR
    (SELECT count(*) FROM account WHERE "userId" IN ('p7-demo-viewer','p7-demo-worker','p7-demo-admin')
      AND "accountId"="userId" AND "providerId"='credential' AND length(password)>0) <> 3 THEN
    RAISE EXCEPTION 'Fixture identity mismatch';
  END IF;
  IF EXISTS (
    WITH ledger AS (SELECT location_id,item_id,sum(quantity_delta) quantity FROM stock_ledger WHERE tenant_id='${tenant}' GROUP BY location_id,item_id)
    SELECT 1 FROM ledger l FULL JOIN (SELECT * FROM stock_balances WHERE tenant_id='${tenant}') b USING(location_id,item_id)
    WHERE COALESCE(l.quantity,0)<>COALESCE(b.quantity,0)
  ) THEN RAISE EXCEPTION 'Fixture ledger/balance mismatch'; END IF;
  IF EXISTS (
    WITH expected AS (
      SELECT d.id document_id,l.item_id,v.location_id,v.delta
      FROM inventory_documents d JOIN inventory_document_lines l ON l.document_id=d.id AND l.tenant_id=d.tenant_id
      CROSS JOIN LATERAL (VALUES(d.source_location_id,-l.quantity::bigint),(d.destination_location_id,l.quantity::bigint)) v(location_id,delta)
      WHERE d.tenant_id='${tenant}' AND d.status='POSTED' AND v.location_id IS NOT NULL
    ), actual AS (SELECT document_id,item_id,location_id,quantity_delta delta FROM stock_ledger WHERE tenant_id='${tenant}')
    SELECT 1 FROM expected e FULL JOIN actual a USING(document_id,item_id,location_id) WHERE e.delta IS DISTINCT FROM a.delta
  ) THEN RAISE EXCEPTION 'Fixture document/ledger mismatch'; END IF;
END $check$;
SELECT (SELECT count(*) FROM memberships WHERE tenant_id='${tenant}') AS demo_users,
  (SELECT count(*) FROM items WHERE tenant_id='${tenant}') AS items,
  (SELECT count(*) FROM inventory_documents WHERE tenant_id='${tenant}') AS documents,
  (SELECT count(*) FROM stock_ledger WHERE tenant_id='${tenant}') AS ledger_entries,
  (SELECT count(*) FROM stock_balances WHERE tenant_id='${tenant}') AS balances,
  (SELECT count(*) FROM audit_logs WHERE tenant_id='${tenant}') AS audit_entries;
COMMIT;
SELECT (SELECT count(*) FROM memberships WHERE tenant_id='${tenant}') AS demo_users,
  (SELECT count(*) FROM account WHERE "userId" IN ('p7-demo-viewer','p7-demo-worker','p7-demo-admin')
    AND "providerId"='credential') AS credential_accounts;
`;
}

async function generate() {
  const directory = resolve(dirname(fileURLToPath(import.meta.url)), '../artifacts');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Private artifacts must be a real directory.');
  await chmod(directory, 0o700);
  const targets = ['neon-demo-seed.sql', 'neon-demo-credentials.txt'].map(name => resolve(directory, name));
  for (const target of targets) {
    try { await lstat(target); throw new Error('Private demo output already exists; refusing to overwrite.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  // Exclusive creation reserves both paths before any secret is generated.
  const handles = [];
  try {
    for (const target of targets) handles.push(await open(target, 'wx', 0o600));
    const passwords = Object.fromEntries(roles.map(role => [role, randomBytes(24).toString('hex')]));
    const hashes = Object.fromEntries(await Promise.all(roles.map(async role => [role, await hashPassword(passwords[role])])));
    await handles[0].writeFile(renderNeonDemo(hashes));
    const labels = {viewer:'조회자',worker:'작업자',admin:'관리자'};
    await handles[1].writeFile(`비공개 — WMS 데모 초기 로그인 정보\n\n먼저 neon-demo-seed.sql 전체를 Neon SQL Editor에서 실행하세요. DB는 wms_demo, 계정은 초기화에 사용한 소유자를 선택합니다.\n마지막 SELECT 결과: demo_users=3, credential_accounts=3.\n그 뒤 배포된 앱의 /login 화면에서 아래 계정으로 로그인하세요. 전체 기능 확인에는 관리자 계정을 사용합니다.\n\n${roles.map(role => `${labels[role]} (${role})\n이메일: ${role}@wms-demo.example.test\n비밀번호: ${passwords[role]}`).join('\n\n')}\n\n이 파일과 SQL은 GitHub, 채팅, 스크린샷에 공유하지 마세요.\n관리자와 작업자는 비공개로 유지하고 공개 시연에는 조회자 계정만 사용하세요.\nSQL은 기존 계정이나 활동을 덮어쓰지 않습니다. SQL 실행 오류가 발생하면 결과를 확인하고 ROLLBACK 후 원인을 해결하세요.\n`);
  } catch (error) {
    await Promise.all(handles.map(handle => handle.close().catch(() => {})));
    await Promise.all(targets.slice(0, handles.length).map(target => rm(target, { force: true })));
    throw error;
  }
  await Promise.all(handles.map(handle => handle.close()));
  console.log('Private files created: artifacts/neon-demo-seed.sql and artifacts/neon-demo-credentials.txt');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  generate().catch(() => {
    console.error('Private demo generation failed; check directory permissions and existing output files. No credentials were logged.');
    process.exitCode = 1;
  });
}
