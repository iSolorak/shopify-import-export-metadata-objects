// Reading Shopify's own product export CSV.
//
// The admin's Products → Export produces a file with a different shape to this
// app's: columns are `Handle` and `Title` rather than lowercase, metafields are
// named `Label (product.metafields.namespace.key)`, and there is one row per
// *variant* rather than per product. A twenty-variant product is twenty rows,
// with the title and every product-level metafield filled in on the first one
// and blank on the rest.
//
// Accepting that file directly matters because it is what merchants already
// have. Handed to the importer unchanged it would fail on nineteen rows out of
// twenty with "missing title", which tells them nothing about what went wrong.
//
// This module normalises such a file into the same records the app's own export
// produces, so everything downstream — the planner, the diff, the writes — stays
// unaware there are two input formats.

import { rowsToRecords } from "./csv";
import { HANDLE_COLUMN, TITLE_COLUMN } from "./rich-text-csv";

/** Shopify's column names for the two identifying columns. */
const SHOPIFY_HANDLE = "Handle";
const SHOPIFY_TITLE = "Title";

/**
 * A metafield column in Shopify's export, e.g.
 * `Care guide (product.metafields.custom.care_guide)`.
 *
 * The namespace cannot contain a dot, so it is matched non-greedily up to the
 * first one; the key takes the rest. Real namespaces are gnarlier than they
 * look — `shopify--discovery--product_recommendation` is one Shopify itself
 * emits — so nothing here assumes a tidy identifier.
 */
const METAFIELD_COLUMN = /^.*?\(product\.metafields\.([^.)]+)\.([^)]+)\)$/;

/**
 * Does this look like a file exported from Products → Export?
 *
 * Keyed on the capitalised column names, which is what distinguishes it from
 * this app's own export. Case matters: `title` is ours, `Title` is Shopify's.
 */
export function isShopifyProductExport(headers: string[]): boolean {
  const trimmed = headers.map((header) => header.trim());
  return trimmed.includes(SHOPIFY_HANDLE) && trimmed.includes(SHOPIFY_TITLE);
}

export type NormalizedCsv = {
  records: Record<string, string>[];
  /** Set when the input was a Shopify export, for reporting back to the user. */
  note?: string;
};

/**
 * Parse a CSV into records the planner understands, whichever format it is in.
 *
 * A file in this app's own format is passed straight through. A Shopify export
 * is rewritten: columns renamed, metafield columns unwrapped to `namespace.key`,
 * variant rows collapsed, and everything else dropped.
 *
 * Dropping the ~45 columns that are not metafields is deliberate. They are
 * inventory, pricing and image data this feature has no business touching, and
 * left in place they would each be reported as an unrecognised column and bury
 * the warnings that actually matter.
 */
export function normalizeCsvRecords(
  rows: string[][],
  /**
   * The `namespace.key` columns the caller can actually write — the store's
   * rich text fields. A Shopify export carries a column for *every* metafield
   * on the product, most of them irrelevant here, so the rest are dropped and
   * counted rather than each being reported as an unrecognised column.
   */
  knownColumns?: Iterable<string>,
): NormalizedCsv {
  const headers = (rows[0] ?? []).map((header) => header.trim());

  if (!isShopifyProductExport(headers)) {
    return { records: rowsToRecords(rows) };
  }

  const known = knownColumns ? new Set(knownColumns) : null;

  const records = rowsToRecords(rows);

  // Map each source column to the name the planner expects, or to null to drop
  // it. Built from the headers rather than per row so the work happens once.
  const mapping = new Map<string, string>();
  let metafieldColumns = 0;
  let otherMetafieldColumns = 0;

  for (const header of headers) {
    if (header === SHOPIFY_HANDLE) {
      mapping.set(header, HANDLE_COLUMN);
      continue;
    }
    if (header === SHOPIFY_TITLE) {
      mapping.set(header, TITLE_COLUMN);
      continue;
    }

    const match = METAFIELD_COLUMN.exec(header);
    if (!match) continue;

    const column = `${match[1]}.${match[2]}`;
    if (known && !known.has(column)) {
      otherMetafieldColumns++;
      continue;
    }

    mapping.set(header, column);
    metafieldColumns++;
  }

  // Collapse to one row per product. Shopify writes the product-level fields on
  // the first row of a handle and leaves them blank on the variant rows that
  // follow, so the first occurrence is the one carrying the data.
  //
  // Grouped by handle rather than by "has a title", because a row whose title
  // happens to be blank for another reason should still be reported as an error
  // by the planner rather than silently swallowed here.
  const byHandle = new Map<string, Record<string, string>>();
  const anonymous: Record<string, string>[] = [];
  let variantRows = 0;

  for (const record of records) {
    const handle = (record[SHOPIFY_HANDLE] ?? "").trim();

    const mapped: Record<string, string> = {};
    for (const [from, to] of mapping) mapped[to] = record[from] ?? "";

    // A row with no handle cannot be grouped; keep it so the planner can report
    // it rather than dropping a row the merchant may have hand-added.
    if (!handle) {
      anonymous.push(mapped);
      continue;
    }

    if (byHandle.has(handle)) {
      variantRows++;
      continue;
    }
    byHandle.set(handle, mapped);
  }

  const parts = [
    `Read as a Shopify product export: ${byHandle.size + anonymous.length} product(s)`,
  ];
  if (variantRows) parts.push(`${variantRows} extra variant row(s) collapsed`);
  parts.push(`${metafieldColumns} rich text column(s) found`);

  const ignored = headers.length - mapping.size - otherMetafieldColumns;
  if (ignored > 0) parts.push(`${ignored} product column(s) ignored`);
  if (otherMetafieldColumns > 0) {
    parts.push(`${otherMetafieldColumns} non-rich-text metafield(s) ignored`);
  }

  return {
    records: [...byHandle.values(), ...anonymous],
    note: `${parts.join(", ")}.`,
  };
}
