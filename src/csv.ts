// Pure CSV/TSV serialization for the table export. RFC 4180 escaping: a field
// is quoted when it contains the delimiter, a double quote, CR, or LF;
// embedded double quotes are doubled; records are separated by CRLF. Fields
// that a spreadsheet would read as a formula are neutralized with a leading
// single quote before those quoting rules apply.

export type DelimitedFormat = "csv" | "tsv";

export interface DelimitedCell {
  text: string;
  /** The source JSON value was a number, so a leading `-` is genuine. */
  numeric: boolean;
}

export type DelimitedField = string | DelimitedCell;

export interface DelimitedTable {
  columns: string[];
  rows: DelimitedField[][];
}

const DELIMITERS: Record<DelimitedFormat, string> = {
  csv: ",",
  tsv: "\t",
};

// Excel, LibreOffice, and Sheets evaluate a cell starting with one of these as
// a formula; a leading tab or CR is trimmed first and the next character is
// evaluated instead, so those two have to be neutralized as well.
const FORMULA_LEADS = ["=", "+", "-", "@", "\t", "\r"];

function neutralizeFormula(text: string, numeric: boolean): string {
  if (numeric) return text;
  return FORMULA_LEADS.includes(text.charAt(0)) ? `'${text}` : text;
}

function escapeField(
  field: string,
  delimiter: string,
  numeric: boolean
): string {
  const text = neutralizeFormula(field, numeric);
  const needsQuoting =
    text.includes(delimiter) ||
    text.includes('"') ||
    text.includes("\r") ||
    text.includes("\n");
  if (!needsQuoting) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function serializeRecord(fields: DelimitedField[], delimiter: string): string {
  return fields
    .map((field) =>
      typeof field === "string"
        ? escapeField(field, delimiter, false)
        : escapeField(field.text, delimiter, field.numeric)
    )
    .join(delimiter);
}

export function serializeDelimited(
  table: DelimitedTable,
  format: DelimitedFormat
): string {
  const delimiter = DELIMITERS[format];
  const records: DelimitedField[][] = [table.columns, ...table.rows];
  return records
    .map((record) => serializeRecord(record, delimiter))
    .join("\r\n");
}
