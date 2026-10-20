import { withRequestLog } from '@/server/request-log';
import { json } from '@/server/api';
import { authenticateV2Machine,v2Environment } from '@/server/v2/access';
import { integrationError } from '@/server/v2/integration/http';
import { withTenant } from '@/server/db/tenant';
export const runtime='nodejs';
export const GET=withRequestLog('v2.integration.connection',async(request:Request)=>{try{const identity=await authenticateV2Machine(request.headers,'integration:read');const warehouses=await withTenant(identity.tenant.id,async c=>(await c.query('SELECT id,code,name FROM warehouses WHERE tenant_id=$1 AND id=ANY($2::uuid[]) AND active ORDER BY code',[identity.tenant.id,identity.warehouseIds])).rows);return json({contract_version:'2.0',company_id:identity.tenant.id,environment:v2Environment(),test_company:identity.tenant.isTest===true,source_system:identity.sourceSystem,warehouse_ids:identity.warehouseIds,warehouses,kind:identity.kind});}catch(error){return integrationError(error);}});
