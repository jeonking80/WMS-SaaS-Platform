/** Match Array.find's first row without joining/normalizing potentially empty keys. */
export function firstPositions<T extends {item_id:string;location_id:string}>(rows:readonly T[]) {
 const index=new Map<string,Map<string,T>>();
 for(const row of rows){let locations=index.get(row.item_id);if(!locations){locations=new Map();index.set(row.item_id,locations);}if(!locations.has(row.location_id))locations.set(row.location_id,row);}
 return index;
}
