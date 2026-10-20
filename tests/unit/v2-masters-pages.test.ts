import {describe,it,expect,vi} from 'vitest';
import {loadAllMasters} from '../../src/app/dashboard/v2/master-pages';
describe('complete operational master collection',()=>{
 it('collects row1001 without changing warehouse/filter scope or duplicating the first page',async()=>{
  const fetch=vi.fn().mockResolvedValueOnce({rows:Array.from({length:1000},(_,i)=>({id:String(i)})),has_more:true,next_cursor:'next+token'}).mockResolvedValueOnce({rows:[{id:'1000'}],has_more:false,next_cursor:null});
  const rows=await loadAllMasters('/api/v2/masters/items?warehouse_id=own&q=BOX%25&active=true',fetch);expect(rows).toHaveLength(1001);expect(new Set(rows.map(r=>r.id)).size).toBe(1001);const next=new URL(fetch.mock.calls[1][0],'http://test');expect(next.searchParams.get('q')).toBe('BOX%');expect(next.searchParams.get('warehouse_id')).toBe('own');expect(next.searchParams.get('active')).toBe('true');expect(next.searchParams.get('cursor')).toBe('next+token');
 });
 it('returns no partial catalog if a later page fails or repeats a row/cursor',async()=>{
  const page={rows:[{id:'one'}],has_more:true,next_cursor:'next'};
  await expect(loadAllMasters('/api/v2/masters/items',vi.fn().mockResolvedValueOnce(page).mockRejectedValueOnce(Error('revoked')))).rejects.toThrow('revoked');
  await expect(loadAllMasters('/api/v2/masters/items',vi.fn().mockResolvedValueOnce(page).mockResolvedValueOnce({rows:[{id:'one'}],has_more:false,next_cursor:null}))).rejects.toThrow('MASTER_PAGE_DUPLICATE');
  await expect(loadAllMasters('/api/v2/masters/items',vi.fn().mockResolvedValueOnce(page).mockResolvedValueOnce({rows:[{id:'two'}],has_more:true,next_cursor:'next'}))).rejects.toThrow('MASTER_PAGE_CURSOR_STALLED');
 });
 it('rejects missing continuation metadata, empty continuation pages and foreign URLs',async()=>{
  await expect(loadAllMasters('/api/v2/masters/items',vi.fn().mockResolvedValue({rows:[{id:'one'}]}))).rejects.toThrow('MASTER_PAGE_INVALID');
  await expect(loadAllMasters('/api/v2/masters/items',vi.fn().mockResolvedValue({rows:[],has_more:true,next_cursor:'next'}))).rejects.toThrow('MASTER_PAGE_CURSOR_STALLED');
  await expect(loadAllMasters('https://foreign.example/api/v2/masters/items',vi.fn())).rejects.toThrow('MASTER_PAGE_SCOPE_INVALID');
 });
});
