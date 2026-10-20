/** PostgreSQL lpad truncates longer values; preserve every decimal digit. */
export function documentNumberSql(alias: string) {
  return `('WMS-' || lpad(${alias}.document_no::text, greatest(6, length(${alias}.document_no::text)), '0'))`;
}
