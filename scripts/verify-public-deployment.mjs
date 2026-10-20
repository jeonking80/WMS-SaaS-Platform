/** Read-only deployment checks. No seed, migration, credentials or business mutations. */
const input = process.env.PUBLIC_DEPLOYMENT_URL;
if (!input) throw Error('PUBLIC_DEPLOYMENT_URL required.');
const url = new URL(input);
if(url.protocol!=='https:' || ['localhost','127.0.0.1','::1'].includes(url.hostname) || url.username || url.password) throw Error('Provide a public HTTPS URL without credentials.');
const origin=url.origin;
for(const [path,status] of [['/api/health',200],['/api/ready',200],['/login',200],['/api/me',401],['/api/stock',401],['/api/stock-ledger',401]]) {
 const response=await fetch(origin+path,{redirect:'manual',signal:AbortSignal.timeout(15000)});
 if(path.startsWith('/api/')&&!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(response.headers.get('x-request-id')??''))throw Error(`${path}: missing server-generated UUID x-request-id (HTTP ${response.status})`);
 if(response.status!==status)throw Error(`${path}: expected ${status}, got ${response.status}`);
 if(path==='/api/health'&&(await response.json()).status!=='ok')throw Error('Health payload mismatch');
 if(path==='/api/ready'){const body=await response.json();if(body.status!=='ok'||body.database!=='ok')throw Error('Readiness payload mismatch');}
 console.log(`${path}: HTTP ${status}`);
}
console.log('Public HTTPS readiness and unauthenticated API boundaries passed. Authenticated role checks remain a separate demo:smoke run.');
