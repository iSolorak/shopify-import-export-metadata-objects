// Minimal RFC 4180 CSV reader/writer.
//
// Hand-rolled rather than pulled from npm because the requirements are narrow
// and fully known: quoted fields, doubled quotes as escapes, embedded newlines,
// CRLF or LF. A dependency would carry dialect options this app never uses.

/** Serialize a field, quoting only when the content forces it. */
function encodeField(value: string): string {
  // A leading/trailing space survives unquoted in most parsers but not all, and
  // it is meaningful in a metaobject value, so quote it too.
  const mustQuote =
    /["\n\r,]/.test(value) || value !== value.trim();
  if (!mustQuote) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

export function toCsv(rows: string[][]): string {
  // CRLF: Excel on Windows is the most common destination for these files and
  // it is the line ending RFC 4180 specifies.
  return rows.map((row) => row.map(encodeField).join(",")).join("\r\n");
}

/**
 * Parse CSV text into rows. Returns raw strings — no type coercion, because a
 * metaobject value like "0123" or "true" must survive a round trip unchanged.
 */
export function parseCsv(text: string): string[][] {
  // Excel writes a UTF-8 BOM; left in place it becomes part of the first header
  // name and every column lookup for that header silently misses.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let fieldWasQuoted = false;

  const endField = () => {
    row.push(field);
    field = "";
    fieldWasQuoted = false;
  };
  const endRow = () => {
    endField();
    // Skip blank lines rather than emitting a phantom one-empty-field row,
    // which would otherwise import as an entry with a missing handle.
    if (row.length > 1 || row[0] !== "") rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"' && field === "" && !fieldWasQuoted) {
      inQuotes = true;
      fieldWasQuoted = true;
    } else if (char === ",") {
      endField();
    } else if (char === "\n") {
      endRow();
    } else if (char === "\r") {
      // Swallow CR; the following LF ends the row. A lone CR ends it too.
      if (text[i + 1] !== "\n") endRow();
    } else {
      field += char;
    }
  }

  // A file not ending in a newline still has a final row pending.
  if (field !== "" || row.length > 0) endRow();

  return rows;
}

/**
 * Turn a parsed sheet into objects keyed by header name.
 * Throws on duplicate headers: two columns named the same silently drop one,
 * and for a field key that means importing nulls over real data.
 */
export function rowsToRecords(rows: string[][]): Record<string, string>[] {
  if (rows.length === 0) return [];

  const headers = rows[0].map((header) => header.trim());
  const seen = new Set<string>();
  for (const header of headers) {
    if (seen.has(header)) {
      throw new Error(`Duplicate column "${header}" in the CSV header row.`);
    }
    seen.add(header);
  }

  return rows.slice(1).map((row) => {
    const record: Record<string, string> = {};
    headers.forEach((header, index) => {
      record[header] = row[index] ?? "";
    });
    return record;
  });
}
