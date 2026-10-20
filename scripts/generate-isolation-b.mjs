/** Offline B-company fixture. Does not connect to a database or reset identities. */
import { randomBytes } from 'node:crypto';
import { mkdir, open, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashPassword } from 'better-auth/crypto';
import { renderNeonDemo } from './generate-neon-demo.mjs';
export function renderIsolationB(hashes) {
  return renderNeonDemo(hashes)
    .replaceAll('70000000-0000-4000-8000-', '71000000-0000-4000-8000-')
    .replaceAll('p7-demo-', 'p7-isolation-b-')
    .replaceAll('@wms-demo.example.test', '@wms-isolation-b.example.test')
    .replaceAll('WMS 합성 시연 고객사', 'WMS 격리 검증 고객사 B');
}
async function main() {
  await mkdir('artifacts', {recursive:true,mode:0o700});
  const names=['artifacts/neon-isolation-b.sql','artifacts/neon-isolation-b-credentials.json'];
  const handles=[];
  try {
    for(const name of names) handles.push(await open(name,'wx',0o600));
    const passwords=Object.fromEntries(['viewer','worker','admin'].map(r=>[r,randomBytes(24).toString('hex')]));
    const hashes=Object.fromEntries(await Promise.all(Object.entries(passwords).map(async([r,p])=>[r,await hashPassword(p)])));
    await handles[0].writeFile(renderIsolationB(hashes));
    await handles[1].writeFile(JSON.stringify({tenant:'71000000-0000-4000-8000-000000000001',email:'admin@wms-isolation-b.example.test',password:passwords.admin,roles:passwords},null,2)+'\n');
  } catch(e) {
    await Promise.all(handles.map(h=>h.close()));
    await Promise.all(names.slice(0,handles.length).map(p=>rm(p,{force:true})));
    throw e;
  }
  await Promise.all(handles.map(h=>h.close()));
  console.log('Private B fixture and credentials generated under artifacts/. No database changes made.');
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) main().catch(()=>{console.error('Generation failed; existing outputs are never overwritten.');process.exitCode=1;});
