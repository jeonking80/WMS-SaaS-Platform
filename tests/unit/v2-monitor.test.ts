import {describe,it,expect} from 'vitest';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {readBackupEvidence} from '../../scripts/v2-monitor-lib.mjs';
describe('backup monitoring evidence',()=>{
 it('reports missing evidence as unknown and never claims a backup or provider restore',async()=>{expect(await readBackupEvidence(undefined,'tenant')).toEqual({status:'unknown',reason:'BACKUP_EVIDENCE_NOT_CONFIGURED'});expect(await readBackupEvidence('/tmp/no-such-wms-evidence','tenant')).toEqual({status:'unknown',reason:'BACKUP_EVIDENCE_UNAVAILABLE'});});
 it('accepts scoped recorded evidence, rejects another tenant, and keeps provider verification absent',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'wms-monitor-'));const file=path.join(dir,'evidence.json');
  try{await writeFile(file,JSON.stringify({tenant_id:'A',completed_at:'2026-10-20T00:00:00Z',archive_sha256:'a'.repeat(64)}));expect(await readBackupEvidence(file,'A')).toMatchObject({status:'recorded',provider_restore_verified_at:null});expect(await readBackupEvidence(file,'B')).toMatchObject({status:'unknown',reason:'BACKUP_EVIDENCE_INVALID'});}finally{await rm(dir,{recursive:true,force:true});}
 });
});
