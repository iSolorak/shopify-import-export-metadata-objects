// Building a Shopify translations import CSV from a product export.
//
// The two files describe the same catalogue but share no identifier. A shop's
// own export numbers "The Great Book" 5; Shopify calls the same product
// 10202. So the translated copy sitting in the first file cannot simply be
// pasted into the second — the row it belongs on is only findable by matching
// something both files agree on.
//
// They agree on the handle, and failing that the title. Recovering the Shopify
// ID that way is the whole job here: once a product's ID is known, its rows in
// the translations export are known too, and filling in `Translated content` is
// bookkeeping.
//
// Scope is deliberately the `PRODUCT` rows only. The export identifies a
// metafield by bare metafield ID with no reference to the product carrying it,
// so those rows cannot be joined from CSV alone and are left untouched.

import { rowsToRecords, toCsv } from "./csv";
import { cellToRichTextValue } from "./rich-text";

/** The columns Shopify's translations export has, in order. */
export const TRANSLATION_COLUMNS = [
  "Type",
  "Identification",
  "Field",
  "Locale",
  "Market",
  "Status",
  "Default content",
  "Translated content",
] as const;

const TYPE_COLUMN = "Type";
const FIELD_COLUMN = "Field";
const TRANSLATED_COLUMN = "Translated content";
const DEFAULT_COLUMN = "Default content";
const ID_COLUMN = "Identification";
const PRODUCT_TYPE = "PRODUCT";

/**
 * A field that can be written, and how a source cell has to be shaped first.
 *
 * `format` is the extension point. Every product field is plain today, but a
 * `rich_text_field` metafield stores JSON like
 * `{"type":"root","children":[…]}` rather than the text a normal export holds,
 * so anything pointed at one has to be converted. Keeping the distinction on
 * the target rather than at the call site means adding such a target later is
 * a line in this list, not a change to the writer.
 */
export type TranslationTarget = {
  field: string;
  label: string;
  format: "text" | "rich_text";
};

/**
 * The product-level fields Shopify accepts translations for.
 *
 * `body_html` is HTML on both sides and passes through verbatim: Shopify stores
 * the translation as HTML too, so converting it would corrupt it.
 */
export const PRODUCT_FIELDS: TranslationTarget[] = [
  { field: "title", label: "Title", format: "text" },
  { field: "body_html", label: "Description (body_html)", format: "text" },
  { field: "handle", label: "Handle", format: "text" },
  { field: "product_type", label: "Product type", format: "text" },
  { field: "meta_title", label: "SEO title", format: "text" },
  { field: "meta_description", label: "SEO description", format: "text" },
];

const TARGETS_BY_FIELD = new Map(
  PRODUCT_FIELDS.map((target) => [target.field, target]),
);

/**
 * The join key, applied identically to both files.
 *
 * Case and stray whitespace differ freely between two systems' exports and
 * never mean two different products, so neither is allowed to break a match.
 */
export function normalizeKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

export type TranslationProduct = {
  /** The Shopify product ID, as it appears in the export. */
  id: string;
  handle: string;
  title: string;
  /** Field name to that field's index in `rows`. */
  rowsByField: Map<string, number>;
};

export type ParsedTranslations = {
  /** Every data row, kept whole so output rows can be reproduced verbatim. */
  rows: Record<string, string>[];
  products: TranslationProduct[];
  /** The distinct locales present, for display. */
  locales: string[];
};

/**
 * Read a translations export and index its `PRODUCT` rows by product.
 *
 * Rows are kept in full rather than reduced to what is needed: the output file
 * has to carry each row's original `Type`, `Identification`, `Field`, `Locale`
 * and `Market` back to Shopify untouched, and reconstructing those from a
 * summary risks getting one subtly wrong.
 */
export function parseTranslations(rows: string[][]): ParsedTranslations {
  const headers = (rows[0] ?? []).map((header) => header.trim());
  const missing = TRANSLATION_COLUMNS.filter(
    (column) => !headers.includes(column),
  );
  if (missing.length > 0) {
    throw new Error(
      `That does not look like a Shopify translations export — it is missing the column(s): ${missing.join(", ")}. Export one from Apps → Translate & Adapt.`,
    );
  }

  const records = rowsToRecords(rows);
  const byId = new Map<string, TranslationProduct>();
  const locales = new Set<string>();

  records.forEach((record, index) => {
    if (record[TYPE_COLUMN] !== PRODUCT_TYPE) return;

    const id = record[ID_COLUMN]?.trim();
    if (!id) return;

    const locale = record["Locale"]?.trim();
    if (locale) locales.add(locale);

    let product = byId.get(id);
    if (!product) {
      product = { id, handle: "", title: "", rowsByField: new Map() };
      byId.set(id, product);
    }

    const field = record[FIELD_COLUMN]?.trim();
    if (!field) return;

    // Only the first row for a field is recorded. A multi-locale export has one
    // row per locale per field, and writing the same translation into all of
    // them would be wrong — see the single-locale note on `buildTranslationCsv`.
    if (!product.rowsByField.has(field)) product.rowsByField.set(field, index);

    // The product's own handle and title come from its rows in this same file,
    // which is what makes the join possible without an API call.
    const value = record[DEFAULT_COLUMN] ?? "";
    if (field === "handle" && !product.handle) product.handle = value;
    if (field === "title" && !product.title) product.title = value;
  });

  return {
    rows: records,
    products: [...byId.values()],
    locales: [...locales],
  };
}

export type ParsedSource = {
  columns: string[];
  records: Record<string, string>[];
  byHandle: Map<string, Record<string, string>>;
  /** Titles mapping to more than one product are held here and never guessed. */
  byTitle: Map<string, Record<string, string>[]>;
};

/**
 * Read the shop's own product export.
 *
 * Every column is kept — which column holds the translated copy is the user's
 * choice, and it is routinely one this app has no name for.
 */
export function parseSource(rows: string[][]): ParsedSource {
  const columns = (rows[0] ?? []).map((header) => header.trim());
  const records = collapseVariantRows(rowsToRecords(rows), columns);

  const byHandle = new Map<string, Record<string, string>>();
  const byTitle = new Map<string, Record<string, string>[]>();

  for (const record of records) {
    const handle = normalizeKey(findValue(record, "handle"));
    if (handle && !byHandle.has(handle)) byHandle.set(handle, record);

    const title = normalizeKey(findValue(record, "title"));
    if (title) byTitle.set(title, [...(byTitle.get(title) ?? []), record]);
  }

  return { columns, records, byHandle, byTitle };
}

/** Look a column up ignoring case, so `Handle` and `handle` both resolve. */
function findValue(record: Record<string, string>, name: string): string {
  for (const [key, value] of Object.entries(record)) {
    if (key.trim().toLowerCase() === name) return value;
  }
  return "";
}

/**
 * Merge the rows describing one product into a single record.
 *
 * A product export is one row per *variant*: a twenty-variant product is twenty
 * rows with the title and description filled in on one of them and blank on the
 * rest. The real file behind this comment is 2042 rows for 203 products.
 *
 * First non-empty value per column wins. Shopify puts the product-level fields
 * on the first row and other exporters on the last, and that rule is the only
 * one correct for both. Grouped on handle only — two rows sharing a handle are
 * certainly the same product, whereas two sharing a title may not be.
 */
function collapseVariantRows(
  records: Record<string, string>[],
  columns: string[],
): Record<string, string>[] {
  const handleColumn = columns.find(
    (column) => column.trim().toLowerCase() === "handle",
  );
  if (!handleColumn) return records;

  const merged = new Map<string, Record<string, string>>();
  const ungrouped: Record<string, string>[] = [];

  for (const record of records) {
    const handle = (record[handleColumn] ?? "").trim();
    if (!handle) {
      ungrouped.push(record);
      continue;
    }

    const existing = merged.get(handle);
    if (!existing) {
      merged.set(handle, { ...record });
      continue;
    }

    for (const column of columns) {
      if (!existing[column]) existing[column] = record[column] ?? "";
    }
  }

  return [...merged.values(), ...ungrouped];
}

/** Source column name → the translation field it feeds. */
export type ColumnMapping = Record<string, string>;

export type BuildResult = {
  csv: string;
  /** Rows given a translation. */
  filled: number;
  /** Products matched to a source record. */
  matched: number;
  /** Titles of products with no source record at all. */
  unmatched: string[];
  /** Titles matching several source rows — reported rather than guessed. */
  ambiguous: string[];
  /** Products matched, but whose mapped field has no row in the export. */
  missingFields: string[];
};

/**
 * Produce the translations CSV to hand back to Shopify.
 *
 * Only rows that were actually given a translation are emitted. The file is a
 * work order, and a mostly-empty one buries the rows that matter among
 * thousands that do nothing.
 *
 * Assumes a single locale, which is what the export has when it is taken for
 * one language. A multi-locale export would need the target locale chosen
 * first, since one column of source copy cannot be right for every language;
 * `parseTranslations` surfaces `locales` so the caller can say so.
 */
export function buildTranslationCsv({
  translations,
  source,
  mapping,
}: {
  translations: ParsedTranslations;
  source: ParsedSource;
  mapping: ColumnMapping;
}): BuildResult {
  const pairs = Object.entries(mapping).filter(([, field]) => field);
  if (pairs.length === 0) {
    throw new Error("Choose at least one column to import before building.");
  }

  // Row index → the translated value to write, so a row is emitted once even if
  // two mapped columns somehow aim at the same field.
  const writes = new Map<number, string>();
  const unmatched: string[] = [];
  const ambiguous: string[] = [];
  const missingFields = new Set<string>();
  let matched = 0;

  for (const product of translations.products) {
    const record = matchSource(product, source);

    if (record === "ambiguous") {
      ambiguous.push(product.title || product.handle || product.id);
      continue;
    }
    if (!record) {
      unmatched.push(product.title || product.handle || product.id);
      continue;
    }
    matched++;

    for (const [column, field] of pairs) {
      const cell = record[column] ?? "";
      // An empty cell means "no translation for this one", never "clear it".
      if (!cell.trim()) continue;

      const rowIndex = product.rowsByField.get(field);
      if (rowIndex === undefined) {
        missingFields.add(field);
        continue;
      }

      writes.set(rowIndex, formatValue(cell, TARGETS_BY_FIELD.get(field)));
    }
  }

  const rows: string[][] = [[...TRANSLATION_COLUMNS]];
  // Original order, so the result lines up against the file it came from.
  for (const rowIndex of [...writes.keys()].sort((a, b) => a - b)) {
    const record = translations.rows[rowIndex];
    rows.push(
      TRANSLATION_COLUMNS.map((column) =>
        column === TRANSLATED_COLUMN
          ? writes.get(rowIndex)!
          : (record[column] ?? ""),
      ),
    );
  }

  return {
    csv: toCsv(rows),
    filled: writes.size,
    matched,
    unmatched,
    ambiguous,
    missingFields: [...missingFields],
  };
}

/** Handle first, then title. Returns "ambiguous" if the title is not unique. */
function matchSource(
  product: TranslationProduct,
  source: ParsedSource,
): Record<string, string> | "ambiguous" | null {
  const byHandle = source.byHandle.get(normalizeKey(product.handle));
  if (byHandle) return byHandle;

  const byTitle = source.byTitle.get(normalizeKey(product.title));
  if (!byTitle || byTitle.length === 0) return null;
  // Two different products sharing a title cannot be told apart from here, and
  // picking one would silently write one product's copy onto the other.
  if (byTitle.length > 1) return "ambiguous";

  return byTitle[0];
}

function formatValue(cell: string, target: TranslationTarget | undefined) {
  return target?.format === "rich_text" ? cellToRichTextValue(cell) : cell;
}
