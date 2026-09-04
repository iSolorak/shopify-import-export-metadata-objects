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
// Metafield rows are joined too, but not from CSV alone: the export identifies
// them by bare metafield ID with no reference to the product carrying them, so
// the caller resolves those IDs through the Admin API and hands the result in
// as `metafieldRowsByProduct`.

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
const METAFIELD_TYPE = "METAFIELD";

/**
 * A place a source column can be written to, and how the cell has to be shaped
 * on the way in.
 *
 * `format` matters because a `rich_text_field` metafield does not store text.
 * It stores JSON — `{"type":"root","children":[{"type":"paragraph",…}]}` — and
 * a normal shop export holds plain text or HTML, so anything aimed at one has
 * to be converted or Shopify rejects the row.
 */
export type TranslationTarget = {
  /** `title` for a product field, `custom.usage` for a metafield. */
  field: string;
  label: string;
  format: "text" | "rich_text";
  kind: "product" | "metafield";
};

/**
 * The product-level fields Shopify accepts translations for.
 *
 * `body_html` is HTML on both sides and passes through verbatim: Shopify stores
 * the translation as HTML too, so converting it would corrupt it.
 */
export const PRODUCT_FIELDS: TranslationTarget[] = [
  { field: "title", label: "Title", format: "text", kind: "product" },
  {
    field: "body_html",
    label: "Description (body_html)",
    format: "text",
    kind: "product",
  },
  { field: "handle", label: "Handle", format: "text", kind: "product" },
  {
    field: "product_type",
    label: "Product type",
    format: "text",
    kind: "product",
  },
  { field: "meta_title", label: "SEO title", format: "text", kind: "product" },
  {
    field: "meta_description",
    label: "SEO description",
    format: "text",
    kind: "product",
  },
];

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
  /**
   * Metafield ID to that metafield's row index.
   *
   * The export says nothing else about these rows — no product, no namespace,
   * no key — so on their own they are unusable. `resolveMetafieldOwners` in
   * `translation-metafields.server.ts` turns the IDs into products.
   */
  metafieldRows: Map<string, number>;
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
  const metafieldRows = new Map<string, number>();

  records.forEach((record, index) => {
    const rowId = record[ID_COLUMN]?.trim();

    if (record[TYPE_COLUMN] === METAFIELD_TYPE) {
      // Keyed on the metafield ID because that is genuinely all there is. The
      // first row per ID wins, for the same multi-locale reason as below.
      if (rowId && !metafieldRows.has(rowId)) metafieldRows.set(rowId, index);
      return;
    }

    if (record[TYPE_COLUMN] !== PRODUCT_TYPE) return;

    const id = rowId;
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
    metafieldRows,
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
  const handleColumn = findColumn(columns, HANDLE_COLUMNS);
  const titleColumn = findColumn(columns, ["title"]);
  const records = collapseVariantRows(rowsToRecords(rows), columns, handleColumn);

  const byHandle = new Map<string, Record<string, string>>();
  const byTitle = new Map<string, Record<string, string>[]>();

  for (const record of records) {
    const handle = handleColumn
      ? normalizeKey(record[handleColumn] ?? "")
      : "";
    if (handle && !byHandle.has(handle)) byHandle.set(handle, record);

    const title = titleColumn ? normalizeKey(record[titleColumn] ?? "") : "";
    if (title) byTitle.set(title, [...(byTitle.get(title) ?? []), record]);
  }

  return { columns, records, byHandle, byTitle };
}

/**
 * What a shop's export might call the URL handle.
 *
 * Shopify says `Handle`; other systems say `slug`, and one that does is also
 * one row per variant. Without the alias its rows never group, every title
 * turns up dozens of times, and the whole file is rejected as ambiguous — the
 * safe answer to a question that was never really ambiguous.
 */
const HANDLE_COLUMNS = ["handle", "slug"];

/** The first of `names` present in `columns`, ignoring case. */
function findColumn(columns: string[], names: string[]): string | null {
  for (const name of names) {
    const match = columns.find(
      (column) => column.trim().toLowerCase() === name,
    );
    if (match) return match;
  }
  return null;
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
 * one correct for both. Grouped on the handle only — two rows sharing a handle
 * are certainly the same product, whereas two sharing a title may not be.
 */
function collapseVariantRows(
  records: Record<string, string>[],
  columns: string[],
  handleColumn: string | null,
): Record<string, string>[] {
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
  targets,
  metafieldRowsByProduct,
}: {
  translations: ParsedTranslations;
  source: ParsedSource;
  mapping: ColumnMapping;
  /** Everything mappable: the product fields plus the store's metafields. */
  targets: TranslationTarget[];
  /**
   * Product ID → `namespace.key` → row index, built from the API lookup.
   * Absent when nothing metafield-shaped was mapped, since the caller then
   * skips the lookup entirely.
   */
  metafieldRowsByProduct?: Map<string, Map<string, number>>;
}): BuildResult {
  const byField = new Map(targets.map((target) => [target.field, target]));
  const pairs = Object.entries(mapping)
    .filter(([, field]) => field)
    // A mapping naming a field this store does not have is dropped rather than
    // written blindly: the form is re-posted from the client, and a stale one
    // could otherwise aim at a metafield that has since been deleted.
    .filter(([, field]) => byField.has(field));

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

      const target = byField.get(field)!;
      // A product field is addressed by name; a metafield only through the
      // product it was resolved onto.
      const rowIndex =
        target.kind === "metafield"
          ? metafieldRowsByProduct?.get(product.id)?.get(field)
          : product.rowsByField.get(field);

      if (rowIndex === undefined) {
        missingFields.add(target.label);
        continue;
      }

      writes.set(rowIndex, formatValue(cell, target));
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

/**
 * Shape a source cell for the field it is going into.
 *
 * A `rich_text_field` gets the JSON document Shopify stores; anything else
 * keeps the text exactly as the shop's export wrote it.
 */
function formatValue(cell: string, target: TranslationTarget) {
  return target.format === "rich_text" ? cellToRichTextValue(cell) : cell;
}
