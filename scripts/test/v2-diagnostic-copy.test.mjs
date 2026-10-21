import test from 'node:test';
import assert from 'node:assert/strict';
import {validateDiagnosticPlan,compareFingerprints} from '../v2-diagnostic-copy.mjs';

const fingerprint=()=>({tables:[{name:'v2_workflow_ledger',rows:'10',row_sha256:'a'.repeat(64),rls:true,force_rls:true},{name:'pgmigrations',rows:'18',row_sha256:'b'.repeat(64),rls:false,force_rls:false}],sequences:[{name:'pgmigrations_id_seq',last_value:'18',is_called:true},{name:'v2_integration_events_sequence_seq',last_value:'20',is_called:true}],warehouse_boundaries:[{warehouse_id:'w',version:8}],ledger_boundaries:[{warehouse_id:'w',rows:'10',last_request_version:'8'}],integration_boundaries:[{warehouse_id:'w',status:'quarantined',rows:'1',max_sequence:'20'}],migrations:['old']});

test('preparation accepts environment selectors and rejects source-shaped database reuse names',()=>{
 const plan={source_run_id:'c83531b5-faad-4e95-836e-26c7056ed465',clone_database:'wms_diagnostic_c835_copy',output_directory:'/tmp/diagnostic-new',source_report_file:'/tmp/failed.json'};
 assert.equal(validateDiagnosticPlan(plan).source_migration_env,'MIGRATION_DATABASE_URL');
 assert.equal(validateDiagnosticPlan({...plan,frozen_database:'wms_diagnostic_frozen18'}).frozen_database,'wms_diagnostic_frozen18');
 assert.throws(()=>validateDiagnosticPlan({...plan,frozen_database:plan.clone_database}),/FRESH_FROZEN/);
 assert.throws(()=>validateDiagnosticPlan({...plan,frozen_database:'wms_app'}),/FRESH_FROZEN/);
 assert.throws(()=>validateDiagnosticPlan({...plan,clone_database:'wms_app'}),/FRESH_DIAGNOSTIC/);
 assert.throws(()=>validateDiagnosticPlan({...plan,source_admin_env:'postgres://private-value'}),/SELECTOR/);
});

test('equal counts cannot hide changed row hashes, RLS, quarantine or version boundaries',()=>{
 const before=fingerprint();assert.equal(compareFingerprints(before,structuredClone(before)).passed,true);
 for(const mutate of [copy=>copy.tables[0].row_sha256='c'.repeat(64),copy=>copy.tables[0].force_rls=false,copy=>copy.warehouse_boundaries[0].version++,copy=>copy.integration_boundaries[0].status='applied',copy=>copy.sequences[1].last_value++]){
  const after=structuredClone(before);mutate(after);assert.equal(compareFingerprints(before,after).passed,false);
 }
});

test('migration comparison allows only the reviewed migration metadata and empty rateLimit table delta',()=>{
 const before=fingerprint(),after=structuredClone(before);after.tables[1].rows='19';after.tables[1].row_sha256='d'.repeat(64);after.tables.push({name:'rateLimit',rows:'0',row_sha256:'e'.repeat(64),rls:false,force_rls:false});after.sequences[0].last_value='19';after.migrations.push('new');
 assert.equal(compareFingerprints(before,after,{after_migration:true}).passed,true);assert.equal(compareFingerprints(before,after).passed,false);
 const changed=structuredClone(after);changed.tables[0].row_sha256='f'.repeat(64);assert.equal(compareFingerprints(before,changed,{after_migration:true}).passed,false);
 after.tables[2].rows='1';assert.equal(compareFingerprints(before,after,{after_migration:true}).passed,false);
});
