import { DomainError } from "../../api";
/** RFC 4180 parser: embedded commas, quotes, CRLF and multiline cells. */
export function parseCsv(source: string, rowErrors = false): Record<string, string>[] {
  if (source.length > 2_000_000) throw new DomainError(400, "CSV_TOO_LARGE");
  source = source.replace(/^\uFEFF/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let closed = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (quoted) {
      if (ch === '"') {
        if (source[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else cell += ch;
      continue;
    }
    if (ch === '"') {
      if (cell || closed) throw new DomainError(400, "CSV_INVALID_QUOTE");
      quoted = true;
      continue;
    }
    if (ch === "," || ch === "\n" || ch === "\r") {
      row.push(cell);
      cell = "";
      closed = false;
      if (ch !== ",") {
        if (ch === "\r" && source[i + 1] === "\n") i++;
        if (row.some((v) => v !== "")) rows.push(row);
        row = [];
      }
      continue;
    }
    if (closed) throw new DomainError(400, "CSV_INVALID_QUOTE");
    cell += ch;
  }
  if (quoted) throw new DomainError(400, "CSV_INVALID_QUOTE");
  if (cell || row.length || closed) {
    row.push(cell);
    if (row.some((v) => v !== "")) rows.push(row);
  }
  const headers = rows.shift();
  if (!headers?.length || new Set(headers).size !== headers.length || headers.some((v) => !v))
    throw new DomainError(400, "CSV_INVALID_HEADER");
  if (rows.length > 1000) throw new DomainError(400, "CSV_TOO_MANY_ROWS");
  return rows.map((values) => {
    if (values.length !== headers.length && !rowErrors) throw new DomainError(400, "CSV_COLUMN_COUNT");
    return {
      ...Object.fromEntries(headers.map((k, i) => [k, values[i] ?? ""])),
      ...(values.length !== headers.length ? { __csv_column_count_error: "true" } : {}),
    };
  });
}
export function safeCsvCell(value: unknown): string {
  let text = value == null ? "" : String(value);
  if (/^[\s\u0000-\u001f]*[=+\-@]/.test(text) || /^[\t\r\n]/.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
}
export function makeCsv(headers: string[], rows: Record<string, unknown>[]) {
  return (
    "\uFEFF" +
    [headers.map(safeCsvCell).join(","), ...rows.map((r) => headers.map((k) => safeCsvCell(r[k])).join(","))].join(
      "\r\n",
    )
  );
}
