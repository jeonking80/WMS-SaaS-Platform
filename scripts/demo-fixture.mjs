/** Shared synthetic fixture statements. Values stay parameterized until SQL export. */
import { randomUUID } from 'node:crypto';
export const roles = ['viewer', 'worker', 'admin'];
export const id = n => `70000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const tenant = id(1), warehouse = id(2), receiving = id(3), picking = id(4);

export function fixturePlan(hashes) {
  if (hashes.length !== 3 || hashes.some(hash => typeof hash !== 'string' || !hash)) throw new Error('Three credential hashes required.');
  const statements = [];
  const add = (text, values) => statements.push({ text, values });
  add('INSERT INTO tenants(id,name) VALUES($1,$2)', [tenant,'WMS 합성 시연 고객사']);
  for (const [index,role] of roles.entries()) {
    const user = `p7-demo-${role}`;
    add('INSERT INTO "user"(id,name,email,"emailVerified") VALUES($1,$2,$3,true)', [user,`시연 ${role}`,`${role}@wms-demo.example.test`]);
    add('INSERT INTO account(id,"accountId","providerId","userId",password) VALUES($1,$2,\'credential\',$2,$3)', [randomUUID(),user,hashes[index]]);
    add('INSERT INTO memberships(user_id,tenant_id,role) VALUES($1,$2,$3)', [user,tenant,role]);
  }
  add("INSERT INTO warehouses(id,tenant_id,code,name) VALUES($1,$2,'DEMO-SEOUL','서울 시연 물류센터')", [warehouse,tenant]);
  for (const [location,code,name] of [[receiving,'A-01','입고 보관'],[picking,'B-01','출고 피킹']]) {
    add('INSERT INTO locations(id,tenant_id,warehouse_id,code,name) VALUES($1,$2,$3,$4,$5)', [location,tenant,warehouse,code,name]);
  }
  for (const [n,code,name,min] of [[10,'DEMO-COFFEE','합성 원두 1kg',30],[11,'DEMO-CUP','합성 머그컵',10],[12,'DEMO-FILTER','합성 드립필터',20]]) {
    add('INSERT INTO items(id,tenant_id,code,name,min_stock) VALUES($1,$2,$3,$4,$5)', [id(n),tenant,code,name,min]);
  }
  // Original posted documents and matching double-entry transfer legs; no fabricated reversal.
  const documents = [
    [20,'INBOUND',null,receiving,10,100], [21,'INBOUND',null,receiving,11,40],
    [22,'INBOUND',null,receiving,12,8], [23,'OUTBOUND',receiving,null,10,15],
    [24,'TRANSFER',receiving,picking,10,25], [25,'OUTBOUND',picking,null,10,5],
  ];
  for (const [n,kind,source,destination,item,quantity] of documents) {
    const posted = n !== 25;
    add(`INSERT INTO inventory_documents(id,tenant_id,kind,status,warehouse_id,source_location_id,destination_location_id,note,posted_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,'P7 synthetic demo fixture',CASE WHEN $8 THEN CURRENT_TIMESTAMP ELSE NULL END)`, [id(n),tenant,kind,posted?'POSTED':'DRAFT',warehouse,source,destination,posted]);
    add('INSERT INTO inventory_document_lines(tenant_id,document_id,item_id,quantity) VALUES($1,$2,$3,$4)', [tenant,id(n),id(item),quantity]);
    if (!posted) continue;
    for (const [location,delta] of [[source,-quantity],[destination,quantity]].filter(([location]) => location)) {
      add('INSERT INTO stock_ledger(tenant_id,document_id,warehouse_id,location_id,item_id,quantity_delta) VALUES($1,$2,$3,$4,$5,$6)', [tenant,id(n),warehouse,location,id(item),delta]);

    }
    add('INSERT INTO audit_logs(tenant_id,document_id,actor_id,action) VALUES($1,$2,$3,$4)', [tenant,id(n),'p7-demo-admin',`POST_${kind}`]);
  }
  add('INSERT INTO stock_balances(tenant_id,warehouse_id,location_id,item_id,quantity) SELECT tenant_id,warehouse_id,location_id,item_id,sum(quantity_delta) FROM stock_ledger WHERE tenant_id=$1 GROUP BY tenant_id,warehouse_id,location_id,item_id', [tenant]);
  return statements;
}
