// Pure CSV/TSV serialization for the table export. RFC 4180 escaping: a field
// is quoted when it contains the delimiter, a double quote, CR, or LF;
// embedded double quotes are doubled; records are separated by CRLF.

export type DelimitedFormat = "csv" | "tsv";

export interface DelimitedTable {
  columns: string[];
  rows: string[][];
}

const DELIMITERS: Record<DelimitedFormat, string> = {
  csv: ",",
  tsv: "\t",
};

function escapeField(field: string, delimiter: string): string {
  const needsQuoting =
    field.includes(delimiter) ||
    field.includes('"') ||
    field.includes("\r") ||
    field.includes("\n");
  if (!needsQuoting) return field;
  return `"${field.replace(/"/g, '""')}"`;
}

function serializeRecord(fields: string[], delimiter: string): string {
  return fields.map((field) => escapeField(field, delimiter)).join(delimiter);
}

export function serializeDelimited(
  table: DelimitedTable,
  format: DelimitedFormat
): string {
  const delimiter = DELIMITERS[format];
  const records = [table.columns, ...table.rows];
  return records
    .map((record) => serializeRecord(record, delimiter))
    .join("\r\n");
}
