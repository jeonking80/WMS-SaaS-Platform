"use client";
import { api } from './common';
export type MasterPage<T>={rows:T[];has_more:boolean;next_cursor:string|null};
/** A partial catalog must never become an operational picker/scan source. */
export async function loadAllMasters<T extends {id:string}>(url:string,fetchPage:(url:string)=>Promise<MasterPage<T>>=path=>api<MasterPage<T>>(path)):Promise<T[]> {
 const address=new URL(url,'http://master-pages.invalid');
 if(address.origin!=='http://master-pages.invalid'||!address.pathname.startsWith('/api/v2/masters/'))throw new Error('MASTER_PAGE_SCOPE_INVALID');
 const rows:T[]=[],ids=new Set<string>(),cursors=new Set<string>();const initial=address.searchParams.get('cursor');if(initial)cursors.add(initial);
 for(;;){
  const page=await fetchPage(address.pathname+address.search);
  if(!Array.isArray(page.rows)||typeof page.has_more!=='boolean'||page.rows.length>1000)throw new Error('MASTER_PAGE_INVALID');
  for(const row of page.rows){if(typeof row.id!=='string'||!row.id||ids.has(row.id))throw new Error('MASTER_PAGE_DUPLICATE');ids.add(row.id);rows.push(row);}
  if(!page.has_more){if(page.next_cursor!==null)throw new Error('MASTER_PAGE_INVALID');return rows;}
  if(!page.rows.length||typeof page.next_cursor!=='string'||!page.next_cursor||cursors.has(page.next_cursor))throw new Error('MASTER_PAGE_CURSOR_STALLED');
  cursors.add(page.next_cursor);address.searchParams.set('cursor',page.next_cursor);
 }
}
