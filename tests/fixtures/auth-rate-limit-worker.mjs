import pg from 'pg';
import { betterAuth } from 'better-auth';
import { authenticationRateLimit } from '../../src/server/auth/rate-limit.mjs';

// IPC emits only status codes. Credentials, request bodies and limiter keys never
// leave this isolated fixture process or appear in test diagnostics.
const schema=process.env.AUTH_LIMIT_TEST_SCHEMA;
if(!/^auth_limit_[a-f0-9]+$/.test(schema??''))throw new Error('Invalid isolated schema');
const pool=new pg.Pool({connectionString:process.env.AUTH_LIMIT_TEST_DATABASE_URL,options:`-c search_path=${schema}`,max:4});
const auth=betterAuth({database:pool,secret:process.env.AUTH_LIMIT_TEST_SECRET,baseURL:'http://localhost:3309',
 emailAndPassword:{enabled:true,disableSignUp:true},rateLimit:authenticationRateLimit,telemetry:{enabled:false},logger:{disabled:true}});
try {
 await auth.$context;
 process.send?.({ready:true});
 process.once('message',async message=>{
  try{
   if(!Number.isInteger(message?.count)||message.count<1||message.count>10)throw new Error('Invalid fixture count');
   const statuses=await Promise.all(Array.from({length:message.count},async()=>{
    const response=await auth.handler(new Request('http://localhost:3309/api/auth/sign-in/email',{method:'POST',headers:{'content-type':'application/json',origin:'http://localhost:3309'},body:JSON.stringify({email:'absent@example.invalid',password:'invalid-fixture-password'})}));
    await response.body?.cancel();return response.status;
   }));
   process.send?.({statuses});
  }catch{process.send?.({failed:true});process.exitCode=1;}
  finally{await pool.end();process.disconnect?.();}
 });
}catch{await pool.end();process.send?.({failed:true});process.exitCode=1;process.disconnect?.();}
