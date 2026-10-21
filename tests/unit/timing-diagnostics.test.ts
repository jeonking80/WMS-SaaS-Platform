import {afterEach,describe,expect,it,vi} from 'vitest';
import {beginTiming,observeTimingBytes,observeTimingCount,observeTimingPool,timeAsync,timeSync,timingDiagnosticsActive,withTimingDiagnostics,type TimingLabel} from '../../src/server/timing-diagnostics';
import {json,readBody} from '../../src/server/api';

afterEach(()=>{vi.unstubAllEnvs();vi.restoreAllMocks();});
function enabled(){vi.stubEnv('WMS_TIMING_DIAGNOSTICS','1');vi.stubEnv('WMS_ENVIRONMENT','test');const output=vi.spyOn(console,'info').mockImplementation(()=>{});return()=>output.mock.calls.map(([line])=>JSON.parse(String(line)));}

describe('opt-in timing diagnostics',()=>{
 it('leaves the original promise and return values untouched while disabled',async()=>{
  vi.stubEnv('WMS_TIMING_DIAGNOSTICS','');vi.stubEnv('WMS_ENVIRONMENT','test');const output=vi.spyOn(console,'info').mockImplementation(()=>{}),promise=Promise.resolve({value:1});
  expect(withTimingDiagnostics('v2.workflow.read',()=>promise)).toBe(promise);expect(timeAsync('db.operation',()=>promise)).toBe(promise);expect(timeSync('http.json_response',()=>17)).toBe(17);expect(timingDiagnosticsActive()).toBe(false);await promise;expect(output).not.toHaveBeenCalled();
 });
 it('requires explicit test environment as well as opt-in',async()=>{
  const records=enabled();vi.stubEnv('WMS_ENVIRONMENT','production');await withTimingDiagnostics('v2.workflow.read',async()=>{expect(timingDiagnosticsActive()).toBe(false);});expect(records()).toEqual([]);
 });
 it('records only fixed labels and numeric summaries without caller text or errors',async()=>{
  const records=enabled(),secret=new Error('SQL credential private-body');
  await withTimingDiagnostics('private-tenant-operation',async()=>{
   expect(timingDiagnosticsActive()).toBe(true);const end=beginTiming('db.operation');end();end();
   beginTiming('private-query' as TimingLabel)();observeTimingCount('state.orders',4);observeTimingCount('private-id',12);observeTimingCount('state.orders',NaN);observeTimingBytes('workflow.state_json',400);observeTimingBytes('private-payload',500);observeTimingPool('business',{totalCount:5,idleCount:1,waitingCount:2});
   expect(()=>timeSync('http.json_response',()=>{throw secret;})).toThrow(secret);await expect(timeAsync('db.commit',async()=>{throw secret;})).rejects.toBe(secret);
  });
  const [record]=records();expect(record.operation).toBe('other');expect(record.spans['db.operation'].count).toBe(1);expect(record.spans['http.json_response'].failed_count).toBe(1);expect(record.spans['db.commit'].failed_count).toBe(1);expect(record.counts).toEqual({'state.orders':{samples:1,total:4,max:4}});expect(record.bytes).toEqual({'workflow.state_json':{samples:1,total:400,max:400}});expect(record.pool_counts.business.max_waiting).toBe(2);expect(record.overhead).toMatchObject({extra_db_queries:0,extra_business_payload_serializations:0,logging_overhead_measured:false});expect(JSON.stringify(record)).not.toMatch(/credential|private|SQL/);expect(timingDiagnosticsActive()).toBe(false);
 });
 it('preserves an escaping error and records the failed request without its detail',async()=>{
  const records=enabled(),error=new Error('private-error');await expect(withTimingDiagnostics('v2.workflow.command',async()=>{throw error;})).rejects.toBe(error);expect(records()[0].request_failed_count).toBe(1);expect(JSON.stringify(records())).not.toContain('private-error');
 });
 it('keeps JSON body parsing and response serialization single-pass with identical content',async()=>{
  const records=enabled();let serializations=0;
  await withTimingDiagnostics('v2.workflow.command',async()=>{
   const parsed=await readBody(new Request('http://test.invalid',{method:'POST',headers:{'content-type':'application/json'},body:'{"value":"private-body"}'}));
   const response=json({toJSON(){serializations++;return parsed;}},201);expect(response.status).toBe(201);expect(response.headers.get('cache-control')).toBe('no-store');expect(await response.json()).toEqual({value:'private-body'});
  });
  expect(serializations).toBe(1);expect(records()[0].spans['http.body_parse'].count).toBe(1);expect(records()[0].spans['http.json_response'].count).toBe(1);expect(JSON.stringify(records())).not.toContain('private-body');
 });
 it('isolates overlapping requests instead of combining their phase counts',async()=>{
  const records=enabled();let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
  const first=withTimingDiagnostics('v2.workflow.command',async()=>{await gate;observeTimingCount('state.orders',11);});
  await withTimingDiagnostics('v2.integration.process',async()=>{observeTimingCount('integration.events',2);release();});await first;
  expect(records()).toHaveLength(2);expect(records().find(row=>row.operation==='v2.workflow.command').counts).toEqual({'state.orders':{samples:1,total:11,max:11}});expect(records().find(row=>row.operation==='v2.integration.process').counts).toEqual({'integration.events':{samples:1,total:2,max:2}});
 });
 it('does not replace the business result when diagnostic output fails',async()=>{
  enabled();vi.spyOn(console,'info').mockImplementation(()=>{throw Error('sink unavailable');});expect(await withTimingDiagnostics('v2.workflow.read',async()=>42)).toBe(42);
 });
});
