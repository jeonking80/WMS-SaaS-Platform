/** Bidirectional API isolation using provisioned synthetic A/B companies; no stock changes. */
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
const origin=new URL(process.env.PUBLIC_DEPLOYMENT_URL??'https://wms-saa-s-platform.vercel.app').origin;
if(!origin.startsWith('https://'))throw Error('Public HTTPS required');
const report={origin,startedAt:new Date().toISOString(),completed:false,checks:[]};
async function main(){
 const aText=await readFile(process.env.DEMO_CREDENTIALS_FILE??'artifacts/neon-demo-credentials.txt','utf8');
 const password=aText.match(/\(admin\)\r?\n이메일: [^\n]+\r?\n비밀번호: ([^\r\n]+)/)?.[1];
 assert(password,'A admin credentials missing');
 const b=JSON.parse(await readFile(process.env.ISOLATION_B_CREDENTIALS_FILE??'artifacts/neon-isolation-b-credentials.json','utf8'));
 const a={email:'admin@wms-demo.example.test',password,prefix:'70000000'};
 b.prefix='71000000';
 const id=(who,n)=>`${who.prefix}-0000-4000-8000-${String(n).padStart(12,'0')}`;
 async function call(who,path,expected=200,method='GET',body){
  const r=await fetch(origin+path,{method,redirect:'error',signal:AbortSignal.timeout(30000),headers:{Origin:origin,'Content-Type':'application/json',...(who.cookie?{Cookie:who.cookie}:{})},...(body?{body:JSON.stringify(body)}:{})});
  assert.equal(r.status,expected,`${method} ${path}: unexpected status ${r.status}`);
  assert.match(r.headers.get('x-request-id')??'',/^[0-9a-f-]{36}$/);
  assert.match(r.headers.get('cache-control')??'',/no-store/);
  return r.json();
 }
 for(const who of [a,b]){
  const r=await fetch(origin+'/api/auth/sign-in/email',{method:'POST',redirect:'error',signal:AbortSignal.timeout(30000),headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({email:who.email,password:who.password})});
  assert.equal(r.status,200,'Synthetic admin login failed');
  who.cookie=r.headers.getSetCookie().map(s=>s.split(';')[0]).join('; ');
  assert(who.cookie,'Missing session cookie');
  const me=await call(who,'/api/me');assert.equal(me.role,'admin');assert.equal(me.tenant.id,id(who,1));
 }
 for(const [own,other] of [[a,b],[b,a]]){
  const target=id(other,20);
  const before=await call(other,`/api/documents/${target}`);
  assert.equal(before.document.status,'POSTED','Use immutable posted fixture only');
  assert((await call(other,`/api/stock?item_id=${id(other,10)}`)).stock.length>0,'Foreign fixture must exist');
  const ownStock=await call(own,`/api/stock?item_id=${id(own,10)}`);assert(ownStock.stock.length>0);
  assert.deepEqual((await call(own,`/api/stock?item_id=${id(other,10)}`)).stock,[]);
  assert.deepEqual((await call(own,`/api/stock-ledger?item_id=${id(other,10)}`)).entries,[]);
  await call(own,`/api/documents/${target}`,404);
  await call(own,`/api/documents/${target}?view=history`,404);
  // Cancel cannot alter an already-posted document even if a tenant check regresses.
  await call(own,`/api/documents/${target}/cancel`,404,'POST',{version:before.document.version});
  assert.deepEqual(await call(other,`/api/documents/${target}`),before,'Foreign document changed');
  assert.deepEqual(await call(own,`/api/stock?item_id=${id(own,10)}`),ownStock,'Own stock changed');
  assert.equal((await call(own,'/api/stock/reconcile')).consistent,true);
  report.checks.push({direction:`${own.prefix} -> ${other.prefix}`,foreignFixtureConfirmed:true,foreignStockAndLedgerEmpty:true,detailAndHistory404:true,cancel404:true,documentUnchanged:true,stockUnchanged:true,reconciled:true});
 }
 report.completed=true;
}
try{await main();}catch{report.failure='Isolation verification did not complete. Check connectivity, provisioned fixtures and credentials; no secrets logged.';process.exitCode=1;}
await mkdir('artifacts/public-isolation',{recursive:true});
await writeFile('artifacts/public-isolation/result.json',JSON.stringify(report,null,2)+'\n');
console.log(report.completed?'Bidirectional public API isolation passed; stock unchanged.':'Public isolation NOT verified. See non-secret result.json.');
