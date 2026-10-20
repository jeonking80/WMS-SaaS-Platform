import { DomainError } from "../../api";
export const kinds = ["items", "locations", "partners", "destinations", "barcodes"] as const;
export type MasterKind = typeof kinds[number];
export const locationKinds = ["RECEIVING", "STORAGE", "STAGING", "SHIPPING", "HOLD"] as const;
export const tables: Record<MasterKind, string> = { items: "items", locations: "locations", partners: "business_partners", destinations: "delivery_destinations", barcodes: "master_barcodes" };
export const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fields: Record<MasterKind, string[]> = {
 items: ["code","name","search_terms","min_stock","base_unit","active"],
 locations: ["code","name","kind","priority","reservation_blocked","active"],
 partners: ["code","name","supplier","customer","external_code","active"],
 destinations: ["recipient_name","name","postal_code","address_line1","address_line2","partner_id","external_code","contact_name","phone","active"],
 barcodes: ["barcode","item_id","location_id","unit","quantity","active"],
};
const required: Record<MasterKind,string[]> = {items:["code","name"],locations:["code","name","kind"],partners:["code","name"],destinations:["recipient_name","name","address_line1"],barcodes:["barcode"]};
export function parseKind(kind: string): MasterKind {
 if (!kinds.includes(kind as MasterKind)) throw new DomainError(404,"NOT_FOUND");
 return kind as MasterKind;
}
export function validateInput(kind: MasterKind, body: Record<string,unknown>, patch = false): Record<string,unknown> {
 if (!Object.keys(body).length || Object.keys(body).some(k=>!fields[kind].includes(k))) throw new DomainError(400,"INVALID_INPUT");
 if (kind==='barcodes' && patch && Object.keys(body).some(k=>k!=='active')) throw new DomainError(409,'BARCODE_IMMUTABLE');
 const out: Record<string,unknown> = {};
 for (const [key,value] of Object.entries(body)) {
  if (["active","supplier","customer","reservation_blocked"].includes(key)) {
   if(typeof value!=="boolean") throw new DomainError(400,"INVALID_INPUT"); out[key]=value;
  } else if (["min_stock","priority","quantity"].includes(key)) {
   if(typeof value!=="number" || !Number.isSafeInteger(value) || value < (key==='quantity'?1:0) || value>1e9) throw new DomainError(400,"INVALID_INPUT"); out[key]=value;
  } else if(key.endsWith('_id')) {
   if(value !== null && (typeof value!=="string" || !uuid.test(value))) throw new DomainError(400,"INVALID_INPUT"); out[key]=value;
  } else {
   const max=key==='search_terms'?1000:key==='address_line1'?300:key==='address_line2'?160:["code","phone"].includes(key)?64:key==='postal_code'?5:128;
   if(typeof value!=="string" || value.trim().length>max) throw new DomainError(400,"INVALID_INPUT");
   out[key]=key==='code'?value.trim().toUpperCase():value.trim();
  }
 }
 if(!patch && required[kind].some(k=>typeof out[k]!=="string" || !String(out[k]).length)) throw new DomainError(400,"REQUIRED_FIELD");
 if(['code','name','recipient_name','address_line1','barcode'].some(k=>k in out && out[k]==='')) throw new DomainError(400,'REQUIRED_FIELD');
 if('kind' in out && !locationKinds.includes(out.kind as typeof locationKinds[number])) throw new DomainError(400,"INVALID_LOCATION_KIND");
 if('base_unit' in out && out.base_unit!=='EA') throw new DomainError(400,"INVALID_UNIT");
 if('postal_code' in out && out.postal_code!=='' && !/^\d{5}$/.test(String(out.postal_code))) throw new DomainError(400,'INVALID_POSTAL_CODE');
 if(kind==='partners' && !patch && out.supplier!==true && out.customer!==true) throw new DomainError(400,'PARTNER_ROLE_REQUIRED');
 if(kind==='barcodes' && !patch) {
  const item=!!out.item_id, location=!!out.location_id;
  if(item===location || (item && !((out.unit==='EA'&&out.quantity===1)||(out.unit==='BOX'&&Number(out.quantity)>=2))) || (location && ('unit' in out || 'quantity' in out))) throw new DomainError(400,'INVALID_BARCODE_TARGET');
 }
 return out;
}
export function csvInput(kind:MasterKind, row:Record<string,string>) {
 const body:Record<string,unknown>={};
 for(const [k,v] of Object.entries(row)) {
  if(v==='' && !required[kind].includes(k)) continue;
  body[k]=["active","supplier","customer","reservation_blocked"].includes(k)?v==='true'?true:v==='false'?false:v:["min_stock","priority","quantity"].includes(k)?Number(v):v;
 }
 return validateInput(kind,body);
}
export function csvColumns(kind:MasterKind) {return [...fields[kind],...(kind==='barcodes'?['item_code','location_code']:kind==='destinations'?['customer_code','partner_code']:[])];}
