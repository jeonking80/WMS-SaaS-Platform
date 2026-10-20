import { beforeEach, expect, it, vi } from "vitest";
vi.mock("../../src/server/auth/access", async importOriginal => ({
  ...await importOriginal<typeof import("../../src/server/auth/access")>(),
  requireIdentity: vi.fn(),
}));
vi.mock("../../src/server/master-search", () => ({ searchMaster: vi.fn() }));
import { requireIdentity } from "../../src/server/auth/access";
import { searchMaster } from "../../src/server/master-search";
import { GET } from "../../src/app/api/item-options/route";
import { masterCollection } from "../../src/server/master-data";
const identity = {user:{id:"viewer",name:"Viewer",email:"viewer@example.test"},tenant:{id:"11111111-1111-4111-8111-111111111111",name:"Tenant"},role:"viewer" as const};
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(requireIdentity).mockResolvedValue(identity);
});
it("allows a viewer's tenant scoped options while keeping master items forbidden", async () => {
  const payload = {items:[{id:"item",code:"ABC",name:"Item",active:true,min_stock:"0"}],pagination:{page:1,page_size:20,total:1,total_pages:1}};
  vi.mocked(searchMaster).mockResolvedValue(payload);
  const response = await GET(new Request("http://localhost/api/item-options?q=abc&active_only=true"));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(payload);
  expect(searchMaster).toHaveBeenCalledWith(identity.tenant.id,"items",new URLSearchParams("q=abc&active_only=true"),true);
  const master = await masterCollection(new Request("http://localhost/api/items?q=abc"),"items");
  expect(master.status).toBe(403);
});
