import { describe,it,expect } from 'vitest';
import { parseCsv,safeCsvCell,makeCsv } from '../../src/server/v2/masters/csv';
import { validateInput,csvInput } from '../../src/server/v2/masters/input';
import { randomUUID } from 'node:crypto';
describe('V2 master input and CSV',()=>{
 it('parses escaped quotes, CRLF and multiline values',()=>expect(parseCsv('code,name\r\nA,"one,""two""\r\nthree"\r\n')).toEqual([{code:'A',name:'one,"two"\r\nthree'}]));
 it('rejects duplicate headers and broken quotes',()=>{expect(()=>parseCsv('a,a\n1,2')).toThrow('CSV_INVALID_HEADER');expect(()=>parseCsv('a\n"bad')).toThrow('CSV_INVALID_QUOTE');});
 it('limits imports to 1000 rows',()=>expect(()=>parseCsv('a\n'+Array(1001).fill('x').join('\n'))).toThrow('CSV_TOO_MANY_ROWS'));
 it('prevents spreadsheet formulas including whitespace prefixes',()=>{for(const v of ['=1','+1','-1','@x',' \t=1','\nhello'])expect(safeCsvCell(v)).toMatch(/^"'/);expect(safeCsvCell('ordinary')).toBe('"ordinary"');});
 it('round trips CSV data without formulas',()=>expect(parseCsv(makeCsv(['name'],[{name:'a,"b"'}]))).toEqual([{name:'a,"b"'}]));
 it('accepts both partner roles and rejects roleless partners',()=>{expect(validateInput('partners',{code:' a ',name:'A',supplier:true,customer:true})).toMatchObject({code:'A'});expect(()=>validateInput('partners',{code:'a',name:'A'})).toThrow('PARTNER_ROLE_REQUIRED');});
 it('requires an integer fixed EA/BOX conversion',()=>{const item_id=randomUUID();expect(validateInput('barcodes',{barcode:'box',item_id,unit:'BOX',quantity:12})).toMatchObject({quantity:12});for(const quantity of [1,1.5,-1])expect(()=>validateInput('barcodes',{barcode:'box',item_id,unit:'BOX',quantity})).toThrow();expect(()=>validateInput('barcodes',{barcode:'ea',item_id,unit:'EA',quantity:2})).toThrow();});
 it('prevents barcode reassignment and accepts retirement',()=>{expect(()=>validateInput('barcodes',{quantity:10},true)).toThrow('BARCODE_IMMUTABLE');expect(validateInput('barcodes',{active:false},true)).toEqual({active:false});});
 it('rejects body tenant and warehouse overrides',()=>{expect(()=>validateInput('items',{code:'a',name:'A',tenant_id:randomUUID()})).toThrow();expect(()=>validateInput('locations',{code:'a',name:'A',kind:'STORAGE',warehouse_id:randomUUID()})).toThrow();});
 it('converts typed CSV cells and validates location types',()=>{expect(csvInput('locations',{code:'a',name:'A',kind:'STORAGE',priority:'2',reservation_blocked:'true'})).toMatchObject({priority:2,reservation_blocked:true});expect(()=>csvInput('locations',{code:'a',name:'A',kind:'UNKNOWN'})).toThrow('INVALID_LOCATION_KIND');});
});
