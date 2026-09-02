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
//
// Collapsing per-variant rows is applied to *every* format, not just Shopify's.
// Any tool that walks variants emits one row per variant with the product-level
// fields on exactly one of them, and which row that is varies: Shopify uses the
// first, other exporters the last. Merging on the first non-empty value per
// column is the only rule correct for both.

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
 * Keyed on the presence of a `(product.metafields.…)` column, which is the one
 * unambiguous signature of that format and the only thing here that warrants
 * discarding columns.
 *
 * Deliberately *not* keyed on capitalised `Handle`/`Title`. A file that has been
 * through a spreadsheet often arrives with one renamed and the other not, and a
 * check requiring both matches neither path — which is precisely how a
 * half-edited export slipped through as an unrecognised format.
 */
export function isShopifyProductExport(headers: string[]): boolean {
  return headers.some((header) => METAFIELD_COLUMN.test(header.trim()));
}

/**
 * The planner's name for an identifying column, or null if it is not one.
 *
 * Case-insensitive: `Handle` and `handle` mean the same thing, and which one a
 * given file uses says nothing useful about it.
 */
function identifyingColumn(header: string): string | null {
  const lower = header.trim().toLowerCase();
  if (lower === SHOPIFY_HANDLE.toLowerCase()) return HANDLE_COLUMN;
  if (lower === SHOPIFY_TITLE.toLowerCase()) return TITLE_COLUMN;
  return null;
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
  const known = knownColumns ? new Set(knownColumns) : null;
  const isShopify = isShopifyProductExport(headers);

  let records = rowsToRecords(rows);
  const parts: string[] = [];

  // --- Rename and prune, for Shopify's format only -------------------------
  //
  // A file already using this app's column names is left alone: its unexpected
  // columns are the merchant's own typos, and the planner reporting them is
  // more useful than silently dropping them.
  let otherMetafieldColumns = 0;

  if (isShopify) {
    const mapping = new Map<string, string>();
    const claimed = new Set<string>();
    let richTextColumns = 0;

    for (const header of headers) {
      const identifying = identifyingColumn(header);
      if (identifying) {
        // A file carrying both `Title` and `title` would otherwise have one
        // silently overwrite the other; first occurrence wins instead.
        if (claimed.has(identifying)) continue;
        claimed.add(identifying);
        mapping.set(header, identifying);
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
      richTextColumns++;
    }

    records = records.map((record) => {
      const mapped: Record<string, string> = {};
      for (const [from, to] of mapping) mapped[to] = record[from] ?? "";
      return mapped;
    });

    parts.push(`Read as a Shopify product export`);
    parts.push(`${richTextColumns} rich text column(s) found`);

    const ignored = headers.length - mapping.size - otherMetafieldColumns;
    if (ignored > 0) parts.push(`${ignored} product column(s) ignored`);
    if (otherMetafieldColumns > 0) {
      parts.push(`${otherMetafieldColumns} non-rich-text metafield(s) ignored`);
    }
  } else {
    // Not Shopify's format, so nothing is discarded — but the identifying
    // columns are still normalised for case, so a file with `Handle` and
    // `custom.highlight` groups the same as one with `handle`.
    const renames = headers
      .map((header) => [header, identifyingColumn(header)] as const)
      .filter(
        ([header, to]) => to !== null && header !== to,
      ) as [string, string][];

    if (renames.length) {
      records = records.map((record) => {
        const next = { ...record };
        for (const [from, to] of renames) {
          if (next[to] === undefined) next[to] = next[from];
          delete next[from];
        }
        return next;
      });
    }
  }

  // --- Collapse rows describing the same product ---------------------------
  //
  // Applies to every format, because a per-variant export is not unique to
  // Shopify's own: any tool that walks variants emits one row per variant with
  // the product-level fields filled in on exactly one of them.
  //
  // Keyed on the handle, never the title. Two rows sharing a handle are the
  // same product and can safely be merged; two rows merely sharing a title may
  // be different products, and collapsing those would write one product's copy
  // over another. That case stays an error from the planner.
  const merged = new Map<string, Record<string, string>>();
  const ungrouped: Record<string, string>[] = [];
  let collapsed = 0;

  for (const record of records) {
    const handle = (record[HANDLE_COLUMN] ?? "").trim();

    // No handle to group on: keep the row as-is so the planner can judge it.
    if (!handle) {
      ungrouped.push(record);
      continue;
    }

    const existing = merged.get(handle);
    if (!existing) {
      merged.set(handle, { ...record });
      continue;
    }

    // Merge rather than keeping whichever row came first, and let a later
    // non-empty value win. An empty cell never overwrites anything, so the
    // hundreds of blank variant rows in a real export cannot erase the one row
    // carrying the copy — which is what makes this safe regardless of whether
    // the value sits on the first row (Shopify's own layout) or the last.
    //
    // Last-wins rather than first-wins is deliberate. Where a product really
    // does have two filled rows, the later one is the corrected copy: in the
    // export this was built against, every such conflict paired a generic
    // placeholder early on with the product-specific text further down.
    for (const [column, value] of Object.entries(record)) {
      if (value.trim()) existing[column] = value;
    }
    collapsed++;
  }

  if (collapsed === 0 && !isShopify) return { records };

  // The format label leads, then what was done to the rows, then what was
  // dropped — so the sentence reads in the order a reader needs it.
  const products = merged.size + ungrouped.length;
  const count = collapsed
    ? `${products} product(s) from ${records.length} rows, ${collapsed} duplicate row(s) merged`
    : `${products} product(s)`;
  parts.splice(isShopify ? 1 : 0, 0, count);

  return {
    records: [...merged.values(), ...ungrouped],
    note: `${parts.join(", ")}.`,
  };
}
