import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { hashPassword } from "better-auth/crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { migrate } from "../../scripts/db-migrate.mjs";
const state=vi.hoisted(()=>({pool:undefined as pg.Pool|undefined}));
vi.mock("../../src/server/db/pool",()=>({getPool:()=>state.pool}));
import { getAuth } from "../../src/server/auth/config";
import { withTenant } from "../../src/server/db/tenant";
import type { Identity } from "../../src/server/auth/access";
import { createDocument } from "../../src/server/documents";
import { postInbound } from "../../src/server/posting";
import { GET as stockGET } from "../../src/app/api/stock/route";
import { GET as ledgerGET } from "../../src/app/api/stock-ledger/route";
import { GET as documentsGET, POST as documentsPOST } from "../../src/app/api/documents/route";
import { GET as documentGET, PATCH as documentPATCH } from "../../src/app/api/documents/[id]/route";
import { POST as postPOST } from "../../src/app/api/documents/[id]/post/route";
import { POST as reversePOST } from "../../src/app/api/documents/[id]/reverse/route";
import { GET as lookupsGET } from "../../src/app/api/lookups/route";
import { GET as auditGET } from "../../src/app/api/audit-logs/route";
import { GET as dashboardGET } from "../../src/app/api/dashboard/route";
import { GET as warehousesGET } from "../../src/app/api/warehouses/route";
import { GET as locationsGET } from "../../src/app/api/locations/route";

const databaseUrl=process.env.TEST_DATABASE_URL;
if (!databaseUrl || !decodeURIComponent(new URL(databaseUrl).pathname).endsWith("_test")) throw new Error("A dedicated TEST_DATABASE_URL ending in _test is required.");
const schema=`legacy_scope_${randomUUID().replaceAll("-","")}`,role=`app_${randomUUID().replaceAll("-","")}`,rolePassword=randomBytes(32).toString("hex");
const owner=new pg.Pool({connectionString:databaseUrl});
const company=randomUUID(),foreignCompany=randomUUID(),userId=randomUUID(),foreignUser=randomUUID();
const warehouse=randomUUID(),hiddenWarehouse=randomUUID(),foreignWarehouse=randomUUID();
const location=randomUUID(),hiddenLocation=randomUUID(),foreignLocation=randomUUID();
const item=randomUUID(),foreignItem=randomUUID();
const identity:Identity={user:{id:userId,name:"Scoped admin",email:"scoped@legacy.invalid"},tenant:{id:company,name:"Company A"},role:"admin"};
const otherIdentity:Identity={user:{id:foreignUser,name:"Other admin",email:"other@legacy.invalid"},tenant:{id:foreignCompany,name:"Company B"},role:"admin"};
let server:Server|undefined,baseURL="",cookie="",roleCreated=false;
let visibleDocument="",hiddenDocument="",foreignDocument="",hiddenReplayKey="";
const secretPassword="legacy-scope-password-2026";
let log:ReturnType<typeof vi.spyOn>;

// Real HTTP transport around the application's exported Next route handlers.
async function startHttp() {
  server=createServer(async(incoming,outgoing)=>{
    try {
      const chunks:Buffer[]=[];for await(const chunk of incoming)chunks.push(Buffer.from(chunk));
      const body=Buffer.concat(chunks);
      const headers=new Headers();for(const[key,value]of Object.entries(incoming.headers))if(value)headers.set(key,Array.isArray(value)?value.join(","):value);
      const request=new Request(new URL(incoming.url!,baseURL),{method:incoming.method,headers,...(body.length?{body}: {})});
      const path=new URL(request.url).pathname;
      let response:Response;
      const collections:Record<string,(request:Request)=>Promise<Response>>={"/api/stock":stockGET,"/api/stock-ledger":ledgerGET,"/api/documents":request.method==="POST"?documentsPOST:documentsGET,"/api/lookups":lookupsGET,"/api/audit-logs":auditGET,"/api/dashboard":dashboardGET,"/api/warehouses":warehousesGET,"/api/locations":locationsGET};
      const match=path.match(/^\/api\/documents\/([^/]+)(?:\/(post|reverse))?$/);
      if(path.startsWith("/api/auth/"))response=await getAuth().handler(request);
      else if(collections[path])response=await collections[path](request);
      else if(match){const context={params:Promise.resolve({id:match[1]})};response=await(match[2]==="post"?postPOST:match[2]==="reverse"?reversePOST:request.method==="PATCH"?documentPATCH:documentGET)(request,context);}
      else response=new Response(null,{status:404});
      outgoing.statusCode=response.status;response.headers.forEach((value,key)=>{if(key!=="set-cookie")outgoing.setHeader(key,value);});
      if(response.headers.getSetCookie().length)outgoing.setHeader("set-cookie",response.headers.getSetCookie());
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    }catch{outgoing.statusCode=500;outgoing.end();}
  });
  await new Promise<void>(resolve=>server!.listen(0,"127.0.0.1",resolve));
  baseURL=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function api(path:string,options:{method?:string;body?:Record<string,unknown>;key?:string}={}) {
  return fetch(`${baseURL}${path}`,{method:options.method??"GET",headers:{cookie,origin:baseURL,...(options.body?{"content-type":"application/json"}:{}),...(options.key?{"idempotency-key":options.key}:{})},...(options.body?{body:JSON.stringify(options.body)}:{})});
}
async function posted(actor:Identity,w:string,l:string,i:string,quantity:number,note:string) {
  const draft=await createDocument(actor.tenant.id,{kind:"INBOUND",warehouse_id:w,source_location_id:null,destination_location_id:l,lines:[{item_id:i,quantity}],note});
  const key=randomUUID();await postInbound(actor,String(draft.id),1,key);return {id:String(draft.id),key};
}
beforeAll(async()=>{
  log=vi.spyOn(console,"info").mockImplementation(()=>{});
  await migrate(databaseUrl,{schema,migrationsSchema:schema,createSchema:true,createMigrationsSchema:true,log:()=>{}});
  await owner.query(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD ${pg.escapeLiteral(rolePassword)}`);roleCreated=true;
  await owner.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${role}"`);
  await owner.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA "${schema}" TO "${role}"`);
  const appURL=new URL(databaseUrl);appURL.username=role;appURL.password=rolePassword;
  state.pool=new pg.Pool({connectionString:appURL.toString(),options:`-c search_path=${schema}`,max:5});
  await owner.query(`INSERT INTO "${schema}".tenants(id,name) VALUES($1,'Company A'),($2,'Company B')`,[company,foreignCompany]);
  await owner.query(`INSERT INTO "${schema}"."user"(id,name,email) VALUES($1,'Scoped admin',$2),($3,'Other admin',$4)`,[userId,identity.user.email,foreignUser,otherIdentity.user.email]);
  await owner.query(`INSERT INTO "${schema}".memberships(user_id,tenant_id,role) VALUES($1,$2,'admin'),($3,$4,'admin')`,[userId,company,foreignUser,foreignCompany]);
  const hashed=await hashPassword(secretPassword);
  await owner.query(`INSERT INTO "${schema}".account(id,"accountId","providerId","userId",password) VALUES($1,$2,'credential',$2,$3)`,[randomUUID(),userId,hashed]);
  for(const[t,w,l,c,i]of [[company,warehouse,location,"VISIBLE",item],[company,hiddenWarehouse,hiddenLocation,"HIDDEN",item],[foreignCompany,foreignWarehouse,foreignLocation,"FOREIGN",foreignItem]]){
    await withTenant(t,async client=>{
      await client.query("INSERT INTO warehouses(id,tenant_id,code,name) VALUES($1,$2,$3,$3)",[w,t,c]);
      await client.query("INSERT INTO locations(id,tenant_id,warehouse_id,code,name) VALUES($1,$2,$3,$4,$4)",[l,t,w,c]);
      await client.query("INSERT INTO items(id,tenant_id,code,name) VALUES($1,$2,'SHARED','Shared item') ON CONFLICT DO NOTHING",[i,t]);
    });
  }
  await withTenant(company,c=>c.query("INSERT INTO v2_warehouse_grants VALUES($1,$2,$3)",[company,userId,warehouse]));
  await withTenant(foreignCompany,c=>c.query("INSERT INTO v2_warehouse_grants VALUES($1,$2,$3)",[foreignCompany,foreignUser,foreignWarehouse]));
  visibleDocument=(await posted(identity,warehouse,location,item,11,"VISIBLE_NOTE")).id;
  const hidden=await posted(identity,hiddenWarehouse,hiddenLocation,item,22,"HIDDEN_NOTE");hiddenDocument=hidden.id;hiddenReplayKey=hidden.key;
  foreignDocument=(await posted(otherIdentity,foreignWarehouse,foreignLocation,foreignItem,33,"FOREIGN_NOTE")).id;
  await startHttp();process.env.BETTER_AUTH_URL=baseURL;process.env.BETTER_AUTH_SECRET=randomBytes(48).toString("hex");
  const login=await fetch(`${baseURL}/api/auth/sign-in/email`,{method:"POST",headers:{"content-type":"application/json",origin:baseURL},body:JSON.stringify({email:identity.user.email,password:secretPassword})});
  expect(login.status).toBe(200);cookie=login.headers.getSetCookie().map(value=>value.split(";")[0]).join("; ");expect(Boolean(cookie)).toBe(true);
});
afterAll(async()=>{
  if(server)await new Promise<void>((resolve,reject)=>server!.close(error=>error?reject(error):resolve()));
  await state.pool?.end();
  try{await owner.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);}finally{try{if(roleCreated)await owner.query(`DROP ROLE "${role}"`);}finally{await owner.end();log?.mockRestore();}}
});

describe("Legacy HTTP warehouse scope under real FORCE RLS",()=>{
  it.each(["/api/stock","/api/stock-ledger","/api/documents?view=history","/api/lookups","/api/audit-logs","/api/dashboard","/api/warehouses","/api/locations"])("does not expose another warehouse or tenant through %s",async path=>{
    const response=await api(path);expect(response.status).toBe(200);const body=await response.json();const encoded=JSON.stringify(body);
    for(const secret of [hiddenWarehouse,hiddenLocation,hiddenDocument,foreignWarehouse,foreignLocation,foreignDocument,"HIDDEN_NOTE","FOREIGN_NOTE"])expect(encoded.includes(secret)).toBe(false);
    expect(response.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it("counts and filters stock/history/lookups/audit using only the allowed warehouse",async()=>{
    const stock=await(await api("/api/stock")).json();expect(stock.pagination.total).toBe(1);expect(stock.stock[0].quantity).toBe("11");
    const documents=await(await api("/api/documents?view=history")).json();expect(documents.pagination.total).toBe(1);expect(documents.documents[0].id).toBe(visibleDocument);
    const audit=await(await api("/api/audit-logs")).json();expect(audit.pagination.total).toBe(1);expect(audit.entries[0].document_id).toBe(visibleDocument);
    const hidden=await(await api(`/api/stock?warehouse_id=${hiddenWarehouse}`)).json();expect(hidden.stock).toEqual([]);expect(hidden.pagination.total).toBe(0);
    const hiddenAudit=await(await api(`/api/audit-logs?warehouse_id=${hiddenWarehouse}`)).json();expect(hiddenAudit.entries).toEqual([]);expect(hiddenAudit.pagination.total).toBe(0);
    const visibleAudit=await(await api(`/api/audit-logs?warehouse_id=${warehouse}`)).json();expect(visibleAudit.pagination.total).toBe(1);
    const lookups=await(await api("/api/lookups")).json();expect(lookups.warehouses.map((w:{id:string})=>w.id)).toEqual([warehouse]);expect(lookups.locations.map((l:{id:string})=>l.id)).toEqual([location]);
  });
  it("denies hidden document detail, update, posting replay and reversal without leaking cached effects",async()=>{
    const read=await api(`/api/documents/${hiddenDocument}?view=history`);expect(read.status).toBe(404);
    const replay=await api(`/api/documents/${hiddenDocument}/post`,{method:"POST",body:{version:1},key:hiddenReplayKey});expect(replay.status).toBe(404);
    const reverse=await api(`/api/documents/${hiddenDocument}/reverse`,{method:"POST",body:{version:2},key:randomUUID()});expect(reverse.status).toBe(404);
    const update=await api(`/api/documents/${hiddenDocument}`,{method:"PATCH",body:{version:2,kind:"INBOUND",warehouse_id:hiddenWarehouse,destination_location_id:hiddenLocation,source_location_id:null,note:"forbidden",lines:[{item_id:item,quantity:1}]}});expect(update.status).toBe(404);
    const foreign=await api(`/api/documents/${foreignDocument}?view=history`);expect(foreign.status).toBe(404);
    const unchanged=await owner.query(`SELECT note,status FROM "${schema}".inventory_documents WHERE id=$1`,[hiddenDocument]);expect(unchanged.rows[0]).toEqual({note:"HIDDEN_NOTE",status:"POSTED"});
  });
  it("refuses creating a draft in a hidden warehouse",async()=>{
    const response=await api("/api/documents",{method:"POST",body:{kind:"INBOUND",warehouse_id:hiddenWarehouse,source_location_id:null,destination_location_id:hiddenLocation,note:"forbidden",lines:[{item_id:item,quantity:1}]}});
    expect(response.status).toBe(404);
  });
  it("pages beyond 1000 lookup locations without exposing other warehouse choices",async()=>{
    await owner.query(`INSERT INTO "${schema}".locations(tenant_id,warehouse_id,code,name) SELECT $1,$2,'PAGE-'||n,'Page location '||n FROM generate_series(1,1001) n`,[company,warehouse]);
    try {
      const first=await(await api("/api/lookups")).json();
      expect(first.locations).toHaveLength(1000);
      expect(first.pagination.locations.next_cursor).toMatch(/^[0-9a-f-]{36}$/);
      const next=await(await api(`/api/lookups?kind=locations&after=${first.pagination.locations.next_cursor}`)).json();
      expect(next.locations).toHaveLength(2);expect(next.warehouses).toEqual([]);expect(next.pagination.locations.next_cursor).toBeNull();
      const rows=[...first.locations,...next.locations];
      expect(new Set(rows.map((row:{id:string})=>row.id)).size).toBe(1002);
      expect(rows.every((row:{warehouse_id:string})=>row.warehouse_id===warehouse)).toBe(true);
      expect(rows.some((row:{code:string})=>row.code==='PAGE-1001')).toBe(true);
      for(const path of ['/api/lookups?kind=items','/api/lookups?kind=locations&after=invalid','/api/lookups?after='+location])expect((await api(path)).status).toBe(400);
    } finally {
      await withTenant(company,c=>c.query("UPDATE locations SET active=false WHERE tenant_id=$1 AND code LIKE 'PAGE-%'",[company]));
    }
  });
  it("applies grant and role revocation on the existing session's next HTTP request",async()=>{
    await withTenant(company,c=>c.query("DELETE FROM v2_warehouse_grants WHERE user_id=$1",[userId]));
    const stock=await(await api("/api/stock")).json();expect(stock.stock).toEqual([]);expect(stock.pagination.total).toBe(0);
    const detail=await api(`/api/documents/${visibleDocument}?view=history`);expect(detail.status).toBe(404);
    await withTenant(company,c=>c.query("INSERT INTO v2_warehouse_grants VALUES($1,$2,$3)",[company,userId,warehouse]));
    await owner.query(`UPDATE "${schema}".memberships SET role='viewer' WHERE user_id=$1`,[userId]);
    expect((await api("/api/audit-logs")).status).toBe(403);
    expect((await api("/api/documents")).status).toBe(403);
    const viewerStock=await api("/api/stock");expect(viewerStock.status).toBe(200);const viewerStockBody=await viewerStock.json();expect(viewerStockBody.stock).toHaveLength(1);expect(viewerStockBody.stock[0].warehouse_id).toBe(warehouse);
    const viewerDashboard=await(await api("/api/dashboard")).json();expect(viewerDashboard.metrics.today_inbound).toBe(1);expect(viewerDashboard.setup.warehouses).toBe(1);expect(viewerDashboard.recent).toHaveLength(1);expect(viewerDashboard.recent[0].id).toBe(visibleDocument);
    await owner.query(`UPDATE "${schema}".memberships SET status='suspended' WHERE user_id=$1`,[userId]);
    for(const path of ["/api/stock","/api/documents?view=history","/api/lookups","/api/audit-logs"])expect((await api(path)).status).toBe(403);
  });
});
